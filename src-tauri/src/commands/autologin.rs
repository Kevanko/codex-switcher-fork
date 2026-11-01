//! Automatic re-login: when a ChatGPT account drops, sign in again by itself.
//!
//! A throw-away WebView (fresh profile, hidden) opens the normal OAuth page and
//! walks it exactly as a person would: e-mail → password (if saved) or
//! "one-time code" → the code that arrives in the linked mailbox → consent. The
//! existing local callback server then receives the result like any other login.
//! If the page asks for something we cannot do (phone number, captcha) the
//! window is shown so the person can finish that step; the login carries on.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::mail::{fetch_login_code_with, stored_mail_pair};
use super::oauth::{complete_reauth_login, start_login};
use crate::auth::{get_account, with_store};
use crate::types::{AccountInfo, AuthData};

const WINDOW: &str = "autologin";
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Step log (no secrets) so a failed automatic sign-in can be explained afterwards.
fn log(msg: &str) {
    use std::io::Write;
    crate::applog::log("INFO", &format!("[autologin] {msg}"));
    if let Ok(dir) = crate::auth::get_config_dir() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("autologin.log")) {
            let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), msg);
        }
    }
}
const LOGIN_PASSWORD_KEY: &str = "login_password";

/// Remember (or, when empty, forget) the account's own password.
#[tauri::command]
pub async fn set_account_login_password(account_id: String, password: String) -> Result<(), String> {
    with_store(|store| {
        let acc = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .ok_or_else(|| anyhow::anyhow!("Account not found"))?;
        if password.is_empty() {
            acc.extra.remove(LOGIN_PASSWORD_KEY);
        } else {
            acc.extra.insert(LOGIN_PASSWORD_KEY.into(), serde_json::Value::String(password));
        }
        Ok(((), true))
    })
    .map_err(|e| e.to_string())
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Fill `input_sel` with `value` (React-safe), then click `button_sel`.
/// Retries for ~10 s because the page renders its form a moment after load.
fn fill_and_click(input_sel: Option<&str>, value: &str, button_sel: &str) -> String {
    format!(
        r#"(function(){{
  var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  var inSel={inp}, val={val}, btnSel={btn}, n=0;
  var t=setInterval(function(){{
    var ok=true;
    if(inSel){{
      var i=document.querySelector(inSel);
      if(i){{ i.focus(); set.call(i,val); i.dispatchEvent(new Event('input',{{bubbles:true}})); i.dispatchEvent(new Event('change',{{bubbles:true}})); }} else ok=false;
    }}
    var b=document.querySelector(btnSel);
    if(ok&&b){{ clearInterval(t); setTimeout(function(){{ b.click(); }},200); }}
    else if(++n>40) clearInterval(t);
  }},250);
}})();"#,
        inp = input_sel.map(js_str).unwrap_or_else(|| "null".into()),
        val = js_str(value),
        btn = js_str(button_sel),
    )
}

fn path_of(url: &tauri::Url) -> String {
    url.path().trim_end_matches('/').to_string()
}

#[tauri::command]
pub async fn auto_relogin(app: AppHandle, account_id: String) -> Result<AccountInfo, String> {
    if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("Автовход уже идёт для другого аккаунта - подожди".into());
    }
    let _guard = RunGuard;
    let account = get_account(&account_id).map_err(|e| e.to_string())?.ok_or("Account not found")?;
    log(&format!("start {} ({})", account.name, account_id));
    if !matches!(account.auth_data, AuthData::ChatGPT { .. }) {
        return Err("Автовход работает только для аккаунтов ChatGPT".into());
    }
    let email = account.email.clone().ok_or("У аккаунта нет почты в профиле")?;
    let mail = stored_mail_pair(&account_id).map_err(|_| "Подключи почту для кодов - без неё автовход невозможен")?;
    let password = account
        .extra
        .get(LOGIN_PASSWORD_KEY)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let started_at = chrono::Utc::now().timestamp();
    let info = start_login(account.name.clone()).await?;
    if info.callback_port != 1455 {
        let _ = super::oauth::cancel_login().await;
        log(&format!("abort: callback port {} instead of 1455", info.callback_port));
        return Err("Порт 1455 занят другой программой (например Codex CLI) - закрой её и повтори".into());
    }
    let id_for_task = account_id.clone();
    let done = tauri::async_runtime::spawn(async move { complete_reauth_login(id_for_task).await });

    // Fresh profile every time: no cookies from an earlier session to confuse the flow.
    if let Some(old) = app.get_webview_window(WINDOW) {
        let _ = old.destroy();
    }
    let profile = std::env::temp_dir().join(format!("cs-autologin-{}", uuid::Uuid::new_v4()));
    let url: tauri::Url = info.auth_url.parse().map_err(|e| format!("{e}"))?;
    let win = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::External(url))
        .title("Codex Switcher - вход")
        .inner_size(520.0, 720.0)
        .visible(false)
        .data_directory(profile.clone())
        .build()
        .map_err(|e| format!("Не открылось окно входа: {e}"))?;

    let mut seen_path = String::new();
    let mut seen_since = Instant::now();
    let mut acted: std::collections::HashSet<String> = Default::default();
    let mut shown = false;
    let mut password_tried_at: Option<Instant> = None;
    let mut last_code = String::new();
    let mut code_filled_at: Option<Instant> = None;
    let mut last_code_poll = Instant::now() - Duration::from_secs(10);
    let deadline = Instant::now() + Duration::from_secs(240);
    let mut stuck_on = String::new();
    let mut fatal: Option<String> = None;

    while Instant::now() < deadline && !done.inner().is_finished() {
        tokio::time::sleep(Duration::from_millis(700)).await;
        let Ok(u) = win.url() else { continue };
        if u.host_str() == Some("localhost") {
            break; // the callback server has the result
        }
        let path = path_of(&u);
        if path != seen_path {
            seen_path = path.clone();
            seen_since = Instant::now();
            log(&format!("page {path}"));
        }
        let on_page_for = seen_since.elapsed();
        // Each step fires once per visit to its page.
        match path.as_str() {
            "/log-in" => {
                if acted.insert(format!("email:{seen_path}")) {
                    let _ = win.eval(&fill_and_click(Some("input[type=email]"), &email, "button[name=intent][value=email]"));
                }
            }
            "/log-in/password" => {
                if !password.is_empty() && acted.insert("pwd".into()) {
                    password_tried_at = Some(Instant::now());
                    let _ = win.eval(&fill_and_click(Some("input[name=current-password]"), &password, "button[name=intent][value=validate]"));
                } else if password.is_empty() && acted.insert("otp".into()) {
                    let _ = win.eval(&fill_and_click(None, "", "button[name=intent][value=passwordless_login_send_otp]"));
                } else if let Some(t) = password_tried_at {
                    // Wrong/rejected password: fall back to the one-time code.
                    if t.elapsed() > Duration::from_secs(9) && acted.insert("otp".into()) {
                        let _ = win.eval(&fill_and_click(None, "", "button[name=intent][value=passwordless_login_send_otp]"));
                    }
                }
            }
            "/email-verification" => {
                if last_code_poll.elapsed() >= Duration::from_secs(3) {
                    last_code_poll = Instant::now();
                    if let Ok(Some(c)) = fetch_login_code_with(mail.0.clone(), mail.1.clone(), Some(started_at - 30)).await {
                        let stale_retry = code_filled_at.map(|t| t.elapsed() > Duration::from_secs(12)).unwrap_or(true);
                        if c.code != last_code || (stale_retry && code_filled_at.is_some()) {
                            last_code = c.code.clone();
                            code_filled_at = Some(Instant::now());
                            let _ = win.eval(&fill_and_click(Some("input[name=code]"), &c.code, "button[name=intent][value=validate]"));
                        }
                    }
                }
            }
            p if p.contains("/consent") => {
                if acted.insert("consent".into()) {
                    let _ = win.eval(&fill_and_click(None, "", "form button[type=submit]"));
                }
            }
            "/oauth/authorize" | "" | "/api/accounts/authorize" => {
                // The authorize page never stays: it is a redirect or an error JSON.
                if on_page_for > Duration::from_secs(12) {
                    fatal = Some("OpenAI отклонил запрос входа (invalid_authorize_request) - повтори позже".to_string());
                    break;
                }
            }
            other => {
                // Something we do not know how to drive (phone number, captcha…): hand it to the person.
                if !shown && on_page_for > Duration::from_secs(6) {
                    shown = true;
                    stuck_on = other.to_string();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        }
        // Known pages that do not move for a long time need a person too (captcha, wrong code…).
        if !shown && on_page_for > Duration::from_secs(45) && !seen_path.contains("/consent") {
            shown = true;
            stuck_on = seen_path.clone();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }

    let finished = done.inner().is_finished();
    let result = if finished {
        done.await.map_err(|e| e.to_string()).and_then(|r| r)
    } else {
        let _ = super::oauth::cancel_login().await;
        log(&format!("fail on {seen_path} stuck_on={stuck_on} fatal={fatal:?}"));
        Err(if let Some(f) = fatal {
            f
        } else if stuck_on.contains("phone") {
            "PHONE: OpenAI просит подтвердить телефон - сделай это в открывшемся окне".to_string()
        } else if stuck_on.is_empty() {
            format!("Не дождались входа (страница {seen_path})")
        } else {
            format!("Вход остановился на {stuck_on} - нужно действие руками (телефон/капча)")
        })
    };
    let _ = win.destroy();
    log(&format!("end ok={}", result.is_ok()));
    // The profile folder is still locked for a moment after the window closes.
    std::thread::spawn(move || {
        for _ in 0..10 {
            std::thread::sleep(Duration::from_secs(2));
            if std::fs::remove_dir_all(&profile).is_ok() {
                break;
            }
        }
    });
    result
}
