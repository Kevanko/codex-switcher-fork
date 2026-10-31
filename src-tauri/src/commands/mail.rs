//! Login codes from the account's own mailbox (IMAP), so signing back in to a
//! dropped account does not mean opening webmail by hand.
//!
//! The mailbox address and password live in the account's `extra` map under
//! `mail_login`, so older app versions keep them untouched.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

use crate::auth::{get_account, with_store};

const MAIL_KEY: &str = "mail_login";

#[derive(Debug, Clone, Serialize)]
pub struct MailCode {
    pub code: String,
    pub from: String,
    pub subject: String,
    /// Unix seconds the server received the message.
    pub received_at: Option<i64>,
}

pub(crate) fn stored_mail_pair(account_id: &str) -> Result<(String, String), String> {
    stored_mail(account_id)
}

fn stored_mail(account_id: &str) -> Result<(String, String), String> {
    let account = get_account(account_id)
        .map_err(|e| e.to_string())?
        .ok_or("Account not found")?;
    let m = account.extra.get(MAIL_KEY).ok_or("Почта для кодов не указана")?;
    let addr = m.get("address").and_then(|v| v.as_str()).unwrap_or_default();
    let pass = m.get("password").and_then(|v| v.as_str()).unwrap_or_default();
    if addr.is_empty() || pass.is_empty() {
        return Err("Почта для кодов не указана".into());
    }
    Ok((addr.to_string(), pass.to_string()))
}

/// Save (or, with an empty address, forget) the mailbox for an account.
/// An empty password keeps the one already saved.
#[tauri::command]
pub async fn set_account_mail(account_id: String, address: String, password: String) -> Result<(), String> {
    let address = address.trim().to_string();
    if !address.is_empty() {
        // Bind only a mailbox we could actually sign in to.
        let pass = if password.is_empty() { stored_mail(&account_id).map(|(_, p)| p).unwrap_or_default() } else { password.clone() };
        if pass.is_empty() {
            return Err("Введи пароль от почты".into());
        }
        check_mail_login(address.clone(), pass).await?;
    }
    with_store(|store| {
        let acc = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .ok_or_else(|| anyhow::anyhow!("Account not found"))?;
        let address = address.trim().to_string();
        if address.is_empty() {
            acc.extra.remove(MAIL_KEY);
        } else {
            let keep = acc
                .extra
                .get(MAIL_KEY)
                .and_then(|m| m.get("password"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let password = if password.is_empty() { keep } else { password };
            acc.extra.insert(
                MAIL_KEY.into(),
                serde_json::json!({ "address": address, "password": password }),
            );
        }
        Ok(((), true))
    })
    .map_err(|e| e.to_string())
}

/// Newest login code for a saved account. `since` (unix seconds) skips older mail.
#[tauri::command]
pub async fn fetch_login_code(account_id: String, since: Option<i64>) -> Result<Option<MailCode>, String> {
    let (addr, pass) = stored_mail(&account_id)?;
    fetch_code(addr, pass, since).await
}

/// Same, for a mailbox typed into the add-account form before the account exists.
#[tauri::command]
pub async fn fetch_login_code_with(address: String, password: String, since: Option<i64>) -> Result<Option<MailCode>, String> {
    fetch_code(address, password, since).await
}

async fn fetch_code(addr: String, pass: String, since: Option<i64>) -> Result<Option<MailCode>, String> {
    tokio::task::spawn_blocking(move || imap_latest_code(&addr, &pass, since))
        .await
        .map_err(|e| e.to_string())?
}

// ── IMAP ──────────────────────────────────────────────────────────────────────
// ponytail: INBOX only, last 15 messages; add Junk/Spam if codes land there.

/// Hosts to try, in order. Resellers (firstmail.ltd and friends) serve many
/// domains from one IMAP server, so `imap.<domain>` is tried first and the
/// shared server second.
fn imap_hosts(addr: &str) -> Result<Vec<String>, String> {
    let domain = addr.rsplit_once('@').map(|(_, d)| d.trim()).filter(|d| !d.is_empty()).ok_or("Неверный адрес почты")?;
    let mut hosts = vec![format!("imap.{domain}")];
    if domain != "firstmail.ltd" {
        hosts.push("imap.firstmail.ltd".to_string());
    }
    Ok(hosts)
}

/// Plain-language reason, keeping the server's wording only when it adds something.
fn explain(errors: &[String]) -> String {
    if errors.iter().any(|e| e.contains("AUTHENTICATIONFAILED") || e.contains("Authentication failed")) {
        return "Неверный адрес или пароль почты".into();
    }
    format!("Не удалось подключиться к почте: {}", errors.join("; "))
}

fn imap_latest_code(addr: &str, pass: &str, since: Option<i64>) -> Result<Option<MailCode>, String> {
    let mut errors = Vec::new();
    for host in imap_hosts(addr)? {
        match imap_latest_code_on(&host, addr, pass, since) {
            Ok(v) => return Ok(v),
            Err(e) => errors.push(e),
        }
    }
    Err(explain(&errors))
}

/// Proves the address and password work (a real IMAP login) — nothing is saved on failure.
fn imap_check(addr: &str, pass: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    for host in imap_hosts(addr)? {
        match imap_login_on(&host, addr, pass) {
            Ok(mut s) => { let _ = s.logout(); return Ok(()); }
            Err(e) => errors.push(e),
        }
    }
    Err(explain(&errors))
}

#[tauri::command]
pub async fn check_mail_login(address: String, password: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || imap_check(address.trim(), &password))
        .await
        .map_err(|e| e.to_string())?
}

type Session = imap::Session<native_tls::TlsStream<TcpStream>>;

fn imap_login_on(host: &str, addr: &str, pass: &str) -> Result<Session, String> {
    let sock = (host, 993)
        .to_socket_addrs()
        .map_err(|e| format!("{host}: {e}"))?
        .next()
        .ok_or_else(|| format!("{host}: адрес не найден"))?;
    let tcp = TcpStream::connect_timeout(&sock, Duration::from_secs(10)).map_err(|e| format!("{host}: {e}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(20))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(20))).ok();
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let stream = tls.connect(host, tcp).map_err(|e| format!("TLS {host}: {e}"))?;
    let mut client = imap::Client::new(stream);
    client.read_greeting().map_err(|e| e.to_string())?;
    client
        .login(addr, pass)
        .map_err(|(e, _)| format!("Почта не пустила ({host}): {e}"))
}

fn imap_latest_code_on(host: &str, addr: &str, pass: &str, since: Option<i64>) -> Result<Option<MailCode>, String> {
    let mut session = imap_login_on(host, addr, pass)?;
    let mailbox = session.select("INBOX").map_err(|e| e.to_string())?;
    let n = mailbox.exists;
    let mut found = None;
    if n > 0 {
        let start = n.saturating_sub(14).max(1);
        let fetches = session
            .fetch(format!("{start}:{n}"), "(INTERNALDATE BODY.PEEK[])")
            .map_err(|e| e.to_string())?;
        let mut list: Vec<_> = fetches.iter().collect();
        list.sort_by_key(|f| std::cmp::Reverse(f.message));
        for f in list {
            let at = f.internal_date().map(|d| d.timestamp());
            if let (Some(s), Some(a)) = (since, at) {
                if a < s {
                    continue;
                }
            }
            let Some(raw) = f.body() else { continue };
            if let Some(mut c) = code_from_message(raw) {
                c.received_at = at;
                found = Some(c);
                break;
            }
        }
    }
    let _ = session.logout();
    Ok(found)
}

fn code_from_message(raw: &[u8]) -> Option<MailCode> {
    let mail = mailparse::parse_mail(raw).ok()?;
    let header = |name: &str| {
        mail.headers
            .iter()
            .find(|h| h.get_key().eq_ignore_ascii_case(name))
            .map(|h| h.get_value())
            .unwrap_or_default()
    };
    let from = header("From");
    let subject = header("Subject");
    let who = format!("{from} {subject}").to_lowercase();
    if !["openai", "chatgpt", "anthropic", "claude"].iter().any(|k| who.contains(k)) {
        return None;
    }
    // "New sign-in to your account" and the like carry no code.
    let subj = subject.to_lowercase();
    if !subj.contains("code") && !subj.contains("verif") && !subj.contains("код") {
        return None;
    }
    let mut text = String::new();
    collect_text(&mail, &mut text);
    let code = find_code(&subject).or_else(|| find_code(&strip_html(&text)))?;
    Some(MailCode { code, from, subject, received_at: None })
}

fn collect_text(part: &mailparse::ParsedMail, out: &mut String) {
    if part.subparts.is_empty() {
        if part.ctype.mimetype.starts_with("text/") {
            if let Ok(b) = part.get_body() {
                out.push_str(&b);
                out.push('\n');
            }
        }
    } else {
        for p in &part.subparts {
            collect_text(p, out);
        }
    }
}

fn strip_html(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < s.len() {
        if lower[i..].starts_with("<style") || lower[i..].starts_with("<script") {
            let close = if lower[i..].starts_with("<style") { "</style>" } else { "</script>" };
            i = lower[i..].find(close).map(|p| i + p + close.len()).unwrap_or(s.len());
            continue;
        }
        if bytes[i] == b'<' {
            i = s[i..].find('>').map(|p| i + p + 1).unwrap_or(s.len());
            out.push(' ');
            continue;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// First standalone run of exactly six digits (not part of a colour like #202123).
fn find_code(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let before = if start > 0 { b[start - 1] } else { b' ' };
            let after = if i < b.len() { b[i] } else { b' ' };
            if i - start == 6 && !before.is_ascii_alphanumeric() && before != b'#' && !after.is_ascii_alphanumeric() {
                return Some(s[start..i].to_string());
            }
        } else {
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_codes_and_skips_colours() {
        assert_eq!(find_code("Your ChatGPT code is 482913"), Some("482913".into()));
        assert_eq!(find_code("color:#202123; code 1234567 then 004211."), Some("004211".into()));
        assert_eq!(find_code("no code here 12345"), None);
        assert_eq!(strip_html("<style>a{color:#111111}</style><p>Code: <b>918273</b></p>").contains("918273"), true);
    }

    #[test]
    fn parses_openai_mail_and_ignores_others() {
        let raw = b"From: OpenAI <noreply@tm.openai.com>\r\nSubject: Your ChatGPT code is 551177\r\nContent-Type: text/plain\r\n\r\nEnter this code: 551177\r\n";
        assert_eq!(code_from_message(raw).unwrap().code, "551177");
        let spam = b"From: shop@example.com\r\nSubject: Sale 123456\r\n\r\n123456\r\n";
        assert!(code_from_message(spam).is_none());
        let signin = b"From: OpenAI <noreply@tm.openai.com>
Subject: New sign-in to your OpenAI account

Time 20:15:44 ip 123456
";
        assert!(code_from_message(signin).is_none());
        let html = b"From: Anthropic <no-reply@mail.anthropic.com>\r\nSubject: Your login code\r\nContent-Type: text/html\r\n\r\n<div style=\"color:#334455\">Code <b>778899</b></div>\r\n";
        assert_eq!(code_from_message(html).unwrap().code, "778899");
    }

    /// Live check against a real mailbox: MAIL_TEST="user@host:password" cargo test live_mailbox -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_mailbox() {
        let v = std::env::var("MAIL_TEST").expect("MAIL_TEST");
        let (a, p) = v.split_once(':').unwrap();
        let c = imap_latest_code(a, p, None).expect("imap");
        println!("{c:?}");
        assert!(c.is_some());
    }
}
