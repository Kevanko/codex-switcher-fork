//! Claude-auth environment overrides.
//!
//! Gateway accounts (GLM via z.ai / OpenRouter) were removed; what remains is the
//! cleanup that keeps a leftover `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` env var
//! (from an old gateway activation or another tool) from shadowing the account
//! selected in `~/.claude/.credentials.json`.

use anyhow::Result;
use std::fs;
use std::path::PathBuf;

use crate::auth::storage::{get_config_dir, load_accounts, save_accounts};

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

/// Mirror file written by the removed gateway feature; deleted on cleanup.
fn active_gateway_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("gateway-active-env"))
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

/// Drop a gateway left active by an older build. No-op when none is active.
pub fn deactivate_active_gateway() -> Result<()> {
    let mut store = load_accounts()?;
    if store.active_gateway_id.take().is_none() {
        return Ok(());
    }
    save_accounts(&store)?;
    let _ = fs::remove_file(active_gateway_file()?);
    Ok(())
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
