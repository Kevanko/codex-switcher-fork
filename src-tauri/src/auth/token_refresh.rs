//! ChatGPT and Claude OAuth token refresh helpers

use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use tokio::time::{sleep, Duration};

use super::{
    load_accounts, switch_to_account, update_account_chatgpt_tokens,
    update_account_claude_tokens,
};
use crate::types::{parse_chatgpt_id_token_claims, AuthData, StoredAccount};

const DEFAULT_ISSUER: &str = "https://auth.openai.com";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_SKEW_SECONDS: i64 = 60;

const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Claude expiresAt is stored in milliseconds.
const CLAUDE_EXPIRY_SKEW_MS: i64 = 120_000;
const CLAUDE_DEFAULT_EXPIRES_IN_SECONDS: i64 = 3600;

#[derive(Debug, serde::Deserialize)]
struct RefreshTokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Ensure the account has a non-expired ChatGPT access token.
/// Returns an updated account when a refresh was performed.
pub async fn ensure_chatgpt_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    match &account.auth_data {
        AuthData::ApiKey { .. } => Ok(account.clone()),
        AuthData::ClaudeOAuth { .. } => Ok(account.clone()),
        AuthData::ChatGPT { access_token, .. } => {
            if token_expired_or_near_expiry(access_token) {
                println!(
                    "[Auth] Access token expired/near expiry for account {}, refreshing",
                    account.name
                );
                refresh_chatgpt_tokens(account).await
            } else {
                Ok(account.clone())
            }
        }
    }
}

/// Force-refresh ChatGPT OAuth tokens for an account.
pub async fn refresh_chatgpt_tokens(account: &StoredAccount) -> Result<StoredAccount> {
    let (current_id_token, current_refresh_token, current_account_id) = match &account.auth_data {
        AuthData::ApiKey { .. } => return Ok(account.clone()),
        AuthData::ClaudeOAuth { .. } => return Ok(account.clone()),
        AuthData::ChatGPT {
            id_token,
            refresh_token,
            account_id,
            ..
        } => (id_token.clone(), refresh_token.clone(), account_id.clone()),
    };

    if current_refresh_token.is_empty() {
        anyhow::bail!("Missing refresh token for account {}", account.name);
    }

    let refreshed = refresh_tokens_with_refresh_token(&current_refresh_token).await?;
    let next_id_token = refreshed.id_token.unwrap_or(current_id_token);
    let next_refresh_token = refreshed
        .refresh_token
        .unwrap_or_else(|| current_refresh_token.clone());

    let claims = parse_chatgpt_id_token_claims(&next_id_token);
    let next_account_id = claims.account_id.or(current_account_id);

    let is_active = load_accounts()?.active_account_id.as_deref() == Some(account.id.as_str());

    let updated = update_account_chatgpt_tokens(
        &account.id,
        next_id_token,
        refreshed.access_token,
        next_refresh_token,
        next_account_id,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
    )?;

    // Keep ~/.codex/auth.json in sync when this is the active account.
    if is_active {
        if let Err(err) = switch_to_account(&updated) {
            println!("[Auth] Failed to sync active auth.json after token refresh: {err}");
        }
    }

    Ok(updated)
}

/// Build a new ChatGPT account from a refresh token.
/// This is used by slim import to recreate full credentials.
pub async fn create_chatgpt_account_from_refresh_token(
    account_name: String,
    refresh_token: String,
) -> Result<StoredAccount> {
    if refresh_token.trim().is_empty() {
        anyhow::bail!("Missing refresh token for account {account_name}");
    }

    let refreshed = refresh_tokens_with_refresh_token(&refresh_token).await?;
    let id_token = refreshed
        .id_token
        .context("Refresh response did not include id_token")?;
    let next_refresh_token = refreshed.refresh_token.unwrap_or(refresh_token);
    let claims = parse_chatgpt_id_token_claims(&id_token);

    Ok(StoredAccount::new_chatgpt(
        account_name,
        claims.email,
        claims.plan_type,
        claims.subscription_expires_at,
        id_token,
        refreshed.access_token,
        next_refresh_token,
        claims.account_id,
    ))
}

#[derive(Debug, serde::Deserialize)]
struct ClaudeRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

/// Serializes Claude token refreshes: Anthropic rotates the refresh_token on
/// every refresh and the old one is invalidated, so two concurrent refreshes
/// for the same credential would log one of them out permanently.
static CLAUDE_REFRESH_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

fn claude_token_expired(expires_at_ms: i64) -> bool {
    expires_at_ms <= Utc::now().timestamp_millis() + CLAUDE_EXPIRY_SKEW_MS
}

/// Ensure a Claude account has a non-expired access token.
///
/// The ACTIVE account's credential is owned by Claude Code — refreshing it here
/// would rotate the refresh_token out from under a running Claude Code session
/// and log it out. For the active account we only re-sync from the live
/// credentials file (Claude Code keeps it fresh while running). Inactive
/// accounts are refreshed directly and the rotated pair is persisted.
pub async fn ensure_claude_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    let expires_at = match &account.auth_data {
        AuthData::ClaudeOAuth { expires_at, .. } => *expires_at,
        _ => return Ok(account.clone()),
    };

    if !claude_token_expired(expires_at) {
        return Ok(account.clone());
    }

    let store = load_accounts()?;
    if store.active_claude_account_id.as_deref() == Some(account.id.as_str()) {
        let _ = crate::auth::storage::sync_claude_tokens_from_file(&account.id);
        let reloaded = load_accounts()?
            .accounts
            .into_iter()
            .find(|a| a.id == account.id)
            .context("Claude account disappeared during token sync")?;
        return Ok(reloaded);
    }

    refresh_claude_tokens(account).await
}

/// Force-refresh Claude OAuth tokens for an INACTIVE account and persist the
/// rotated token pair. Never call this for the active account (see above).
pub async fn refresh_claude_tokens(account: &StoredAccount) -> Result<StoredAccount> {
    let lock = CLAUDE_REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    // Another task may have refreshed this account while we waited for the lock.
    let current = load_accounts()?
        .accounts
        .into_iter()
        .find(|a| a.id == account.id)
        .with_context(|| format!("Claude account not found: {}", account.name))?;

    let (refresh_token, expires_at) = match &current.auth_data {
        AuthData::ClaudeOAuth {
            refresh_token,
            expires_at,
            ..
        } => (refresh_token.clone(), *expires_at),
        _ => anyhow::bail!("Account {} is not a Claude OAuth account", current.name),
    };

    if !claude_token_expired(expires_at) {
        return Ok(current);
    }

    if refresh_token.trim().is_empty() {
        anyhow::bail!("Missing Claude refresh token for account {}", current.name);
    }

    println!(
        "[Auth] Refreshing Claude tokens for account {}",
        current.name
    );

    let client = reqwest::Client::new();
    let response = client
        .post(CLAUDE_TOKEN_URL)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLAUDE_CLIENT_ID,
        }))
        .send()
        .await
        .context("Failed to send Claude token refresh request")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Claude token refresh failed: {status} - {body}");
    }

    let refreshed: ClaudeRefreshResponse = response
        .json()
        .await
        .context("Failed to parse Claude token refresh response")?;

    let next_refresh_token = refreshed.refresh_token.unwrap_or(refresh_token);
    let next_expires_at = Utc::now().timestamp_millis()
        + refreshed
            .expires_in
            .unwrap_or(CLAUDE_DEFAULT_EXPIRES_IN_SECONDS)
            * 1000;

    update_account_claude_tokens(
        &current.id,
        refreshed.access_token,
        next_refresh_token,
        next_expires_at,
    )
}

fn token_expired_or_near_expiry(access_token: &str) -> bool {
    match parse_jwt_exp(access_token) {
        Some(expiry) => expiry <= Utc::now().timestamp() + EXPIRY_SKEW_SECONDS,
        None => false,
    }
}

fn parse_jwt_exp(token: &str) -> Option<i64> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    json.get("exp").and_then(|v| v.as_i64())
}

async fn refresh_tokens_with_refresh_token(refresh_token: &str) -> Result<RefreshTokenResponse> {
    let client = reqwest::Client::new();
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding::encode(refresh_token),
        urlencoding::encode(CLIENT_ID),
    );

    let mut last_send_error = None;
    let mut response = None;

    for attempt in 1..=3u8 {
        match client
            .post(format!("{DEFAULT_ISSUER}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body.clone())
            .send()
            .await
        {
            Ok(resp) => {
                response = Some(resp);
                break;
            }
            Err(err) => {
                last_send_error = Some(err);
                if attempt < 3 {
                    sleep(Duration::from_millis(250 * u64::from(attempt))).await;
                }
            }
        }
    }

    let response = match response {
        Some(resp) => resp,
        None => {
            let err = last_send_error.context("Failed to send token refresh request")?;
            return Err(err.into());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Token refresh failed: {status} - {body}");
    }

    response
        .json::<RefreshTokenResponse>()
        .await
        .context("Failed to parse token refresh response")
}
