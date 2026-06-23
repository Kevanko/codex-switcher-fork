//! Anthropic-compatible gateway accounts (GLM via z.ai / OpenRouter / custom).
//!
//! Fully separate from the OAuth `StoredAccount`s and the Claude CLI token
//! accounts. The key is stable (no rotation, no reuse detection) and is consumed
//! only via env vars, so Claude Code routes to the gateway instead of Anthropic:
//!   - `ANTHROPIC_BASE_URL`   — the gateway's Anthropic-compatible endpoint
//!   - `ANTHROPIC_AUTH_TOKEN` — the gateway API key
//!   - `ANTHROPIC_MODEL`      — optional pinned model (e.g. `glm-5.2`)
//!
//! "Activating" injects these for new `claude` runs (Windows: persisted user env
//! via `setx`; Unix: a 0600 file with `export` lines + copy-paste in the UI) and
//! clears the conflicting `CLAUDE_CODE_OAUTH_TOKEN`. Switching to a regular Claude
//! account (OAuth tab) or a Claude CLI token clears these vars in turn.

use anyhow::{Context, Result};
use chrono::Utc;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use crate::auth::storage::{get_config_dir, load_accounts, save_accounts};
use crate::types::{GatewayAccount, GatewayAccountInfo};

/// Every env var that can override Claude Code's `~/.claude/.credentials.json`
/// account selection. The app owns all of them: each Claude-auth switch wipes the
/// whole set first, then re-sets only what the chosen mode needs. A stray
/// `ANTHROPIC_API_KEY` (left by a GLM/z.ai installer or a shared-folder shell)
/// otherwise makes Claude Code warn "connectors disabled … takes precedence" and
/// silently use the wrong auth.
#[cfg(windows)]
const CLAUDE_OVERRIDE_ENV_VARS: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// Delete every Claude-auth override env var (Windows registry, `HKCU`).
#[cfg(windows)]
pub(crate) fn clear_all_override_env() {
    for var in CLAUDE_OVERRIDE_ENV_VARS {
        del_env(var);
    }
}

/// Path to the 0600 file mirroring the active gateway env (Unix shims / export).
fn active_gateway_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("gateway-active-env"))
}

/// Inject (or clear) the active gateway's env into the OS environment for new
/// sessions. `Some` also clears the conflicting `CLAUDE_CODE_OAUTH_TOKEN`.
fn apply_gateway_env(account: Option<&GatewayAccount>) -> Result<()> {
    let path = active_gateway_file()?;
    match account {
        Some(acc) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).ok();
            }
            let mut lines = format!(
                "export ANTHROPIC_BASE_URL={}\nexport ANTHROPIC_AUTH_TOKEN={}\n",
                acc.base_url, acc.key
            );
            if let Some(model) = acc.model.as_deref().filter(|m| !m.trim().is_empty()) {
                lines.push_str(&format!("export ANTHROPIC_MODEL={model}\n"));
            }
            fs::write(&path, &lines).with_context(|| {
                format!("Failed to write active gateway file: {}", path.display())
            })?;
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
        apply_windows_env(account)?;
    }

    Ok(())
}

#[cfg(windows)]
fn apply_windows_env(account: Option<&GatewayAccount>) -> Result<()> {
    // Wipe every Claude-auth override first (including a stray ANTHROPIC_API_KEY
    // and any lingering CLI token) so nothing survives the switch, then set only
    // what the gateway mode needs.
    clear_all_override_env();
    if let Some(acc) = account {
        setx("ANTHROPIC_BASE_URL", &acc.base_url)?;
        setx("ANTHROPIC_AUTH_TOKEN", &acc.key)?;
        if let Some(model) = acc.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            setx("ANTHROPIC_MODEL", model)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn setx(name: &str, value: &str) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let status = Command::new("setx")
        .creation_flags(CREATE_NO_WINDOW)
        .args([name, value])
        .status()
        .with_context(|| format!("Failed to run setx for {name}"))?;
    if !status.success() {
        anyhow::bail!("setx {name} returned a non-zero exit status");
    }
    Ok(())
}

#[cfg(windows)]
fn del_env(name: &str) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let _ = Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["delete", "HKCU\\Environment", "/F", "/V", name])
        .status();
}

/// Clear any active gateway: env vars + store pointer. Called when another Claude
/// auth mechanism takes over (regular OAuth switch / Claude CLI token activate).
/// No-op when no gateway is active, so it stays cheap on every switch.
pub fn deactivate_active_gateway() -> Result<()> {
    let mut store = load_accounts()?;
    if store.active_gateway_id.take().is_none() {
        return Ok(());
    }
    save_accounts(&store)?;
    apply_gateway_env(None)
}

/// Force Claude Code back to plain `~/.claude/.credentials.json`: drop the active
/// gateway / CLI-token store pointers and their mirror files, and wipe EVERY
/// auth-override env var. Unlike `deactivate_active_gateway`, this does NOT
/// early-return when the store shows nothing active — a stray `ANTHROPIC_API_KEY`
/// set outside the app (GLM/z.ai installer, shared-folder shell) must be cleared
/// too. Called when a regular Claude OAuth account becomes active.
pub fn clear_claude_auth_overrides() -> Result<()> {
    let mut store = load_accounts()?;
    let changed =
        store.active_gateway_id.take().is_some() | store.active_claude_token_id.take().is_some();
    if changed {
        save_accounts(&store)?;
    }
    let _ = fs::remove_file(active_gateway_file()?);
    let _ = fs::remove_file(get_config_dir()?.join("claude-active-token"));
    #[cfg(windows)]
    clear_all_override_env();
    Ok(())
}

fn to_info(store_active: Option<&str>, account: &GatewayAccount) -> GatewayAccountInfo {
    GatewayAccountInfo::from_account(account, store_active == Some(account.id.as_str()))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_gateway_accounts() -> Result<Vec<GatewayAccountInfo>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let active = store.active_gateway_id.as_deref();
    Ok(store
        .gateway_accounts
        .iter()
        .map(|a| to_info(active, a))
        .collect())
}

#[tauri::command]
pub async fn add_gateway_account(
    name: String,
    base_url: String,
    key: String,
    model: Option<String>,
) -> Result<GatewayAccountInfo, String> {
    let name = name.trim().to_string();
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    let key = key.trim().to_string();
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());

    if name.is_empty() {
        return Err("Account name is empty".to_string());
    }
    if key.is_empty() {
        return Err("API key is empty".to_string());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".to_string());
    }

    let mut store = load_accounts().map_err(|e| e.to_string())?;
    if store
        .gateway_accounts
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("A gateway account named '{name}' already exists"));
    }

    let account = GatewayAccount {
        id: Uuid::new_v4().to_string(),
        name,
        base_url,
        key,
        model,
        created_at: Utc::now(),
    };
    let info = to_info(store.active_gateway_id.as_deref(), &account);
    store.gateway_accounts.push(account);
    save_accounts(&store).map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
pub async fn rename_gateway_account(id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Account name is empty".to_string());
    }
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    if store
        .gateway_accounts
        .iter()
        .any(|a| a.id != id && a.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("A gateway account named '{name}' already exists"));
    }
    let account = store
        .gateway_accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("Gateway account not found: {id}"))?;
    account.name = name;
    save_accounts(&store).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_gateway_account(id: String) -> Result<(), String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    let before = store.gateway_accounts.len();
    store.gateway_accounts.retain(|a| a.id != id);
    if store.gateway_accounts.len() == before {
        return Err(format!("Gateway account not found: {id}"));
    }
    let was_active = store.active_gateway_id.as_deref() == Some(id.as_str());
    if was_active {
        store.active_gateway_id = None;
    }
    save_accounts(&store).map_err(|e| e.to_string())?;
    if was_active {
        apply_gateway_env(None).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Make a gateway account active (injects its env for new `claude` sessions).
#[tauri::command]
pub async fn activate_gateway_account(id: String) -> Result<(), String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    let account = store
        .gateway_accounts
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| format!("Gateway account not found: {id}"))?;
    store.active_gateway_id = Some(id);
    save_accounts(&store).map_err(|e| e.to_string())?;
    apply_gateway_env(Some(&account)).map_err(|e| e.to_string())
}

/// Clear the active gateway (removes the injected env vars).
#[tauri::command]
pub async fn deactivate_gateway() -> Result<(), String> {
    let mut store = load_accounts().map_err(|e| e.to_string())?;
    store.active_gateway_id = None;
    save_accounts(&store).map_err(|e| e.to_string())?;
    apply_gateway_env(None).map_err(|e| e.to_string())
}

/// Return the full key for a "copy export" action in the UI.
#[tauri::command]
pub async fn get_gateway_key_secret(id: String) -> Result<String, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    store
        .gateway_accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.key.clone())
        .ok_or_else(|| format!("Gateway account not found: {id}"))
}
