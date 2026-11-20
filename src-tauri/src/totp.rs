//! One-time codes (RFC 6238: SHA-1, 6 digits, 30 seconds) from the secret an authenticator app
//! was set up with. The secret is kept with the account, like its saved login password.

use crate::auth::{get_account, with_store};
use anyhow::{anyhow, bail, Context, Result};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};

/// Key in the account's extra fields.
pub(crate) const KEY: &str = "totp_secret";
const STEP: u64 = 30;

/// Decodes RFC 4648 base32. Spaces, dashes and padding are ignored, letters may be lower case.
pub(crate) fn decode_secret(secret: &str) -> Result<Vec<u8>> {
    let mut bits = 0u32;
    let mut count = 0u32;
    let mut out = Vec::new();
    for c in secret.chars().filter(|c| !c.is_whitespace() && !matches!(c, '-' | '=')) {
        let value = match c.to_ascii_uppercase() {
            letter @ 'A'..='Z' => letter as u32 - 'A' as u32,
            digit @ '2'..='7' => digit as u32 - '2' as u32 + 26,
            _ => bail!("В секретном ключе есть недопустимые символы: нужны буквы A–Z и цифры 2–7"),
        };
        bits = (bits << 5) | value;
        count += 5;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    if out.is_empty() {
        bail!("Секретный ключ пустой");
    }
    Ok(out)
}

fn code_at(key: &[u8], unix: u64) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(&(unix / STEP).to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let binary = u32::from_be_bytes([
        hash[offset] & 0x7f,
        hash[offset + 1],
        hash[offset + 2],
        hash[offset + 3],
    ]);
    format!("{:06}", binary % 1_000_000)
}

/// Below this many seconds left, the current code may expire before it is typed and checked.
const MIN_LEFT: u64 = 3;

/// The code to use now and the seconds it stays usable. Near the end of a window this is the
/// next window's code (servers accept one window of drift), so a code is never sent stale.
pub(crate) fn current(secret: &str) -> Result<(String, u64)> {
    let key = decode_secret(secret)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("Системное время раньше 1970 года")?
        .as_secs();
    Ok(code_for(&key, now))
}

fn code_for(key: &[u8], unix: u64) -> (String, u64) {
    let left = STEP - unix % STEP;
    if left < MIN_LEFT {
        (code_at(key, unix + left), left + STEP)
    } else {
        (code_at(key, unix), left)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TotpCode {
    code: String,
    /// Seconds until the shown code should be replaced (up to 32 near a window's end).
    remaining: u64,
}

#[tauri::command]
pub(crate) async fn get_totp_code(account_id: String) -> Result<TotpCode, String> {
    let account = get_account(&account_id)
        .map_err(|e| e.to_string())?
        .ok_or("Аккаунт не найден")?;
    let secret = account
        .extra
        .get(KEY)
        .and_then(|v| v.as_str())
        .ok_or("У аккаунта не сохранён секретный ключ 2FA")?;
    let (code, remaining) = current(secret).map_err(|e| format!("{e:#}"))?;
    Ok(TotpCode { code, remaining })
}

/// Saves the setup key (spaces are dropped). An empty key removes it.
#[tauri::command]
pub(crate) async fn set_totp_secret(account_id: String, secret: String) -> Result<(), String> {
    let normalized: String = secret
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    if !normalized.is_empty() {
        decode_secret(&normalized).map_err(|e| format!("{e:#}"))?;
    }
    with_store(|store| {
        let account = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .ok_or_else(|| anyhow!("Аккаунт не найден"))?;
        if normalized.is_empty() {
            account.extra.remove(KEY);
        } else {
            account
                .extra
                .insert(KEY.into(), serde_json::Value::String(normalized));
        }
        Ok(((), true))
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_6238_sha1_vectors() {
        // The RFC's secret "12345678901234567890", in base32.
        let key = decode_secret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        assert_eq!(key, b"12345678901234567890");
        assert_eq!(code_at(&key, 59), "287082");
        assert_eq!(code_at(&key, 1_111_111_109), "081804");
        assert_eq!(code_at(&key, 1_234_567_890), "005924");
    }

    #[test]
    fn the_next_code_is_given_near_the_end_of_a_window() {
        let key = b"12345678901234567890";
        assert_eq!(code_for(key, 60), (code_at(key, 60), 30));
        assert_eq!(code_for(key, 87), (code_at(key, 87), 3));
        assert_eq!(code_for(key, 88), (code_at(key, 90), 32));
        assert_eq!(code_for(key, 89), (code_at(key, 90), 31));
    }

    /// Puts CODEX_SWITCHER_HOME back as it was when the test ends, even on panic.
    struct HomeGuard(Option<std::ffi::OsString>);
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("CODEX_SWITCHER_HOME", value),
                None => std::env::remove_var("CODEX_SWITCHER_HOME"),
            }
        }
    }

    #[test]
    fn setup_key_is_read_loosely_and_bad_characters_are_refused() {
        assert_eq!(decode_secret("gezd gnbv-gy3t qojq").unwrap(), b"1234567890");
        assert!(decode_secret("GEZ1").is_err());
        assert!(decode_secret("").is_err());
    }

    #[tokio::test]
    async fn the_setup_key_is_saved_without_spaces_and_gives_codes() -> Result<()> {
        // A temporary data folder with one account: the real accounts file is never touched.
        let _env = crate::TEST_ENV.lock().unwrap_or_else(|poison| poison.into_inner());
        let fixture = tempfile::tempdir()?;
        let _home = HomeGuard(std::env::var_os("CODEX_SWITCHER_HOME"));
        std::env::set_var("CODEX_SWITCHER_HOME", fixture.path());
        let store = serde_json::json!({
            "version": 1,
            "accounts": [{
                "id": "acc-1", "name": "Test", "email": null, "plan_type": null,
                "auth_mode": "api_key", "auth_data": {"type": "api_key", "key": "sk-test"},
                "created_at": "2026-11-12T00:00:00Z"
            }],
            "active_account_id": null
        });
        std::fs::write(fixture.path().join("accounts.json"), serde_json::to_vec(&store)?)?;

        set_totp_secret("acc-1".into(), "gezd gnbv gy3t qojq gezd gnbv gy3t qojq".into())
            .await
            .map_err(|error| anyhow!(error))?;
        let saved = get_account("acc-1")?.context("account")?;
        assert_eq!(saved.extra[KEY], "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        let code = get_totp_code("acc-1".into()).await.map_err(|error| anyhow!(error))?;
        assert_eq!(code.code.len(), 6);
        assert!(set_totp_secret("acc-1".into(), "GEZ1".into()).await.is_err());

        set_totp_secret("acc-1".into(), String::new())
            .await
            .map_err(|error| anyhow!(error))?;
        assert!(get_account("acc-1")?.context("account")?.extra.get(KEY).is_none());
        Ok(())
    }
}
