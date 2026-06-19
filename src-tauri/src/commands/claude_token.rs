//! Claude CLI long-lived token accounts (`claude setup-token`).
//!
//! These are fully separate from the OAuth `StoredAccount`s. The token is stable
//! (no rotation, no reuse detection) and is consumed only via the
//! `CLAUDE_CODE_OAUTH_TOKEN` environment variable — so switching between them can
//! never cause a session revoke. "Activating" an account injects its token into
//! the environment for new `claude` runs:
//!   - Windows: a persisted user env var via `setx`.
//!   - Unix: a 0600 file (`~/.codex-switcher/claude-active-token`) that a shell
//!     snippet / shim can source; the UI also offers a copy-paste export line.

use anyhow::{Context, Result};
use chrono::{Duration, Utc};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use crate::auth::storage::{get_config_dir, load_accounts, save_accounts};
use crate::types::{ClaudeTokenAccount, ClaudeTokenAccountInfo};

/// `claude setup-token` tokens are valid for exactly one year.
const TOKEN_TTL_DAYS: i64 = 365;

/// Path to the 0600 file mirroring the active token (for Unix shims / export).
fn active_token_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("claude-active-token"))
}

/// Inject (or clear) the active token into the OS environment for new sessions.
fn apply_claude_token_env(token: Option<&str>) -> Result<()> {
    let path = active_token_file()?;
    match token {
        Some(t) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::write(&path, t)
                .with_context(|| format!("Failed to write active token file: {}", path.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
            }
        }
        None => {
            let _ = fs::remove_file(&path);
        }
    }

    #[cfg(windows)]
    {
        apply_windows_env(token)?;
    }

    Ok(())
}

#[cfg(windows)]
fn apply_windows_env(token: Option<&str>) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    match token {
        Some(t) => {
            // Persist a user-level env var so new shells inherit it. setx caps the
            // value at ~1024 chars, which is far above any OAuth token length.
            let status = Command::new("setx")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["CLAUDE_CODE_OAUTH_TOKEN", t])
                .status()
                .context("Failed to run setx for CLAUDE_CODE_OAUTH_TOKEN")?;
            if !status.success() {
                anyhow::bail!("setx returned a non-zero exit status");
            }
        }
        None => {
            // Remove the persisted user env var (ignore "not found").
            let _ = Command::new("reg")
                .creation_flags(CREATE_NO_WINDOW)
                .args([
                    "delete",
                    "HKCU\\Environment",
                    "/F",
                    "/V",
                    "CLAUDE_CODE_OAUTH_TOKEN",
                ])
                .status();
        }
    }
    Ok(())
}

fn to_info(store_active: Option<&str>, account: &ClaudeTokenAccount) -> ClaudeTokenAccountInfo {
    ClaudeTokenAccountInfo::from_account(account, store_active == Some(account.id.as_str()))
}

/// Persist a new token account (shared by paste-add and setup-token-create).
fn store_token_account(
    name: String,
    token: String,
    plan_label: Option<String>,
) -> Result<ClaudeTokenAccountInfo> {
    let name = name.trim().to_string();
    let token = token.trim().to_string();
    if name.is_empty() {
        anyhow::bail!("Account name is empty");
    }
    if token.is_empty() {
        anyhow::bail!("Token is empty");
    }

    let mut store = load_accounts()?;
    if store
        .claude_token_accounts
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&name))
    {
        anyhow::bail!("A token account named '{name}' already exists");
    }

    let now = Utc::now();
    let account = ClaudeTokenAccount {
        id: Uuid::new_v4().to_string(),
        name,
        token,
        created_at: now,
        expires_at: now + Duration::days(TOKEN_TTL_DAYS),
        plan_label,
    };
    let info = to_info(store.active_claude_token_id.as_deref(), &account);
    store.claude_token_accounts.push(account);
    save_accounts(&store)?;
    Ok(info)
}

/// Extract a Claude OAuth token from `claude setup-token` output. Conservative:
/// requires the well-known `sk-ant-` prefix so we never store a wrong value.
fn extract_oauth_token(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace())
        .map(|t| t.trim_matches(|c: char| !c.is_ascii_graphic()))
        .find(|t| t.starts_with("sk-ant-") && t.len() >= 20 && !t.contains("://"))
        .map(|t| t.to_string())
}

/// Run `claude setup-token` and capture the printed long-lived token.
/// Best-effort: the command is interactive (browser login), so this may time out
/// — callers should fall back to manual paste.
async fn run_setup_token() -> Result<String> {
    use tokio::process::Command as TokioCommand;
    use tokio::time::{timeout, Duration as TokioDuration};

    let child = TokioCommand::new("claude")
        .arg("setup-token")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("Could not launch `claude setup-token` — is the Claude CLI installed and on PATH?")?;

    let output = timeout(TokioDuration::from_secs(300), child.wait_with_output())
        .await
        .context("`claude setup-token` did not finish in time — finish the browser login, or use “Add existing”")?
        .context("Failed while running `claude setup-token`")?;

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    extract_oauth_token(&combined).context(
        "Could not read a token from `claude setup-token` output — copy it and use “Add existing” instead",
    )
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_claude_token_accounts() -> Result<Vec<ClaudeTokenAccountInfo>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let active = store.active_claude_token_id.as_deref();
    Ok(store
        .claude_token_accounts
        .iter()
        .map(|a| to_info(active, a))
        .collect())
}

/// Add an already-generated long-lived token (pasted by the user).
#[tauri::command]
pub async fn add_claude_token_account(
    name: String,
    token: String,
    plan_label: Option<String>,
) -> Result<ClaudeTokenAccountInfo, String> {
    store_token_account(name, token, plan_label).map_err(|e| e.to_string())
}

/// Create a token by running `claude setup-token` and capturing its output.
#[tauri::command]
pub async fn create_claude_token_account(
    name: String,
    plan_label: Option<String>,
) -> Result<ClaudeTokenAccountInfo, String> {
    let token = run_setup_token().await.map_err(|e| e.to_string())?;
    store_token_account(name, token, plan_label).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_claude_token_account(id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Account name is empty".to_string());
    }
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    if store
        .claude_token_accounts
        .iter()
        .any(|a| a.id != id && a.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("A token account named '{name}' already exists"));
    }
    let account = store
        .claude_token_accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("Token account not found: {id}"))?;
    account.name = name;
    save_accounts(&store).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_claude_token_account(id: String) -> Result<(), String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    let before = store.claude_token_accounts.len();
    store.claude_token_accounts.retain(|a| a.id != id);
    if store.claude_token_accounts.len() == before {
        return Err(format!("Token account not found: {id}"));
    }
    let was_active = store.active_claude_token_id.as_deref() == Some(id.as_str());
    if was_active {
        store.active_claude_token_id = None;
    }
    save_accounts(&store).map_err(|e| e.to_string())?;
    if was_active {
        apply_claude_token_env(None).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Make a token account the active one (injects its token into the environment).
#[tauri::command]
pub async fn activate_claude_token_account(id: String) -> Result<(), String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    let token = store
        .claude_token_accounts
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("Token account not found: {id}"))?
        .token
        .clone();
    // A gateway (GLM) env override would shadow this token — clear it first.
    let _ = crate::commands::gateway::deactivate_active_gateway();
    store.active_claude_token_id = Some(id);
    save_accounts(&store).map_err(|e| e.to_string())?;
    apply_claude_token_env(Some(&token)).map_err(|e| e.to_string())
}

/// Clear the active token account (removes the injected env var).
#[tauri::command]
pub async fn deactivate_claude_token() -> Result<(), String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    store.active_claude_token_id = None;
    save_accounts(&store).map_err(|e| e.to_string())?;
    apply_claude_token_env(None).map_err(|e| e.to_string())
}

/// Return the full token secret for a "copy" / export-line action in the UI.
#[tauri::command]
pub async fn get_claude_token_secret(id: String) -> Result<String, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    store
        .claude_token_accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.token.clone())
        .ok_or_else(|| format!("Token account not found: {id}"))
}
