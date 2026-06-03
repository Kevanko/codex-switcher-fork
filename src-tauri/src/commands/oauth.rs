//! OAuth login Tauri commands

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use super::account::finalize_added_account_state;
use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{
    add_account, load_accounts, reconcile_active_account_with_current_auth, switch_to_account,
    update_account_chatgpt_tokens,
};
use crate::types::{AccountInfo, OAuthLoginInfo};

struct PendingOAuth {
    rx: oneshot::Receiver<anyhow::Result<OAuthLoginResult>>,
    cancelled: Arc<AtomicBool>,
}

// Global state for pending OAuth login
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);

/// Start the OAuth login flow
#[tauri::command]
pub async fn start_login(account_name: String) -> Result<OAuthLoginInfo, String> {
    // Cancel any previous pending flow so it does not keep the callback port occupied.
    if let Some(previous) = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending.take()
    } {
        previous.cancelled.store(true, Ordering::Relaxed);
    }

    let (info, rx, cancelled) = start_oauth_login(account_name)
        .await
        .map_err(|e| e.to_string())?;

    // Store the receiver for later
    {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        *pending = Some(PendingOAuth { rx, cancelled });
    }

    Ok(info)
}

/// Wait for the OAuth login to complete and add the account
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let pending = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending
            .take()
            .ok_or_else(|| "No pending OAuth login".to_string())?
    };

    let account = wait_for_oauth_login(pending.rx)
        .await
        .map_err(|e| e.to_string())?;

    // Add the account to storage
    let stored = add_account(account).map_err(|e| e.to_string())?;
    finalize_added_account_state(&stored).map_err(|e| e.to_string())?;
    let _ = reconcile_active_account_with_current_auth();

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();
    let active_claude_id = store.active_claude_account_id.as_deref();

    Ok(AccountInfo::from_stored(
        &stored,
        active_id,
        active_claude_id,
    ))
}

/// Wait for the OAuth login to complete and update an existing ChatGPT account.
#[tauri::command]
pub async fn complete_reauth_login(account_id: String) -> Result<AccountInfo, String> {
    let pending = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending
            .take()
            .ok_or_else(|| "No pending OAuth login".to_string())?
    };

    let account = wait_for_oauth_login(pending.rx)
        .await
        .map_err(|e| e.to_string())?;

    let (
        id_token,
        access_token,
        refresh_token,
        chatgpt_account_id,
        email,
        plan_type,
        subscription_expires_at,
    ) = match account.auth_data {
        crate::types::AuthData::ChatGPT {
            id_token,
            access_token,
            refresh_token,
            account_id,
        } => (
            id_token,
            access_token,
            refresh_token,
            account_id,
            account.email,
            account.plan_type,
            account.subscription_expires_at,
        ),
        crate::types::AuthData::ApiKey { .. } | crate::types::AuthData::ClaudeOAuth { .. } => {
            return Err("OAuth login did not return ChatGPT credentials".to_string());
        }
    };

    let updated = update_account_chatgpt_tokens(
        &account_id,
        id_token,
        access_token,
        refresh_token,
        chatgpt_account_id,
        email,
        plan_type,
        subscription_expires_at,
    )
    .map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();
    let active_claude_id = store.active_claude_account_id.as_deref();
    if active_id == Some(account_id.as_str()) {
        switch_to_account(&updated).map_err(|e| e.to_string())?;
    }

    Ok(AccountInfo::from_stored(
        &updated,
        active_id,
        active_claude_id,
    ))
}

/// Cancel a pending OAuth login
#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    let mut pending = PENDING_OAUTH.lock().unwrap();
    if let Some(pending_oauth) = pending.take() {
        pending_oauth.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}
