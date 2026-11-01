//! One plain-text log of everything that went wrong, so a bug report can be
//! diagnosed from `~/.codex-switcher/app.log` instead of from memory.
//! Never write secrets here: messages are errors and step names only.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

const MAX_BYTES: u64 = 512 * 1024;

static LAST_BY_KEY: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn path() -> Option<std::path::PathBuf> {
    crate::auth::get_config_dir().ok().map(|d| d.join("app.log"))
}

pub fn log(level: &str, msg: &str) {
    let Some(p) = path() else { return };
    if std::fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&p, p.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let one_line = msg.replace('\n', " | ");
        let _ = writeln!(f, "{} {:<5} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), level, one_line);
    }
}

/// Log only when the message for `key` differs from the previous one (a dead
/// account polled every few minutes must not fill the log with the same line).
pub fn log_change(key: &str, level: &str, msg: &str) {
    let mut g = LAST_BY_KEY.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(Default::default);
    if map.get(key).map(|m| m == msg).unwrap_or(false) {
        return;
    }
    map.insert(key.to_string(), msg.to_string());
    drop(g);
    log(level, msg);
}

/// Forget a key's last message (the problem went away) so it is logged again if it returns.
pub fn clear_key(key: &str) {
    let mut g = LAST_BY_KEY.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(m) = g.as_mut() {
        if m.remove(key).is_some() {
            drop(g);
            log("INFO", &format!("{key}: ok again"));
        }
    }
}

#[tauri::command]
pub async fn log_event(level: String, message: String) -> Result<(), String> {
    let level = match level.as_str() { "error" => "ERROR", "warn" => "WARN", _ => "INFO" };
    log(level, &format!("[ui] {}", message.chars().take(600).collect::<String>()));
    Ok(())
}

/// Last `lines` lines of the log, for "copy the log" in settings.
#[tauri::command]
pub async fn read_app_log(lines: Option<usize>) -> Result<String, String> {
    let p = path().ok_or("no config dir")?;
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let n = lines.unwrap_or(300);
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(n);
    Ok(format!("# {}\n{}", p.display(), all[start..].join("\n")))
}
