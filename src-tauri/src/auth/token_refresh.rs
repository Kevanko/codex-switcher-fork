//! ChatGPT and Claude OAuth token refresh helpers

use anyhow::{Context, Result};
use chrono::Utc;
use tokio::time::{sleep, Duration};

use super::{load_accounts, switch_to_account, update_account_chatgpt_tokens};
use crate::types::{parse_chatgpt_id_token_claims, parse_jwt_expiry, AuthData, StoredAccount};

const DEFAULT_ISSUER: &str = "https://auth.openai.com";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Claude expiresAt is stored in milliseconds.
const CLAUDE_EXPIRY_SKEW_MS: i64 = 120_000;

#[derive(Debug, serde::Deserialize)]
struct RefreshTokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// "Powered-off PC" safety model for ChatGPT/Codex (mirrors the Claude model).
///
/// OpenAI rotates refresh tokens with reuse detection: presenting an already-
/// rotated (one-shot) refresh token returns `refresh_token_reused` and logs that
/// holder out. So the switcher must NEVER rotate a ChatGPT refresh token in the
/// background — doing so for an account another client also holds (a running
/// Codex CLI, the VS Code extension, or another machine) forks the chain and
/// kicks that client out. OpenAI's own docs spell this out: "one auth.json per
/// serialized stream; do not share it across concurrent jobs or machines".
///
/// - ACTIVE account: adopt whatever the running Codex CLI last wrote to
///   auth.json, then — only if that token is still expired — do the ONE forward
///   refresh. Safe: the active account is the single owner on this machine.
/// - INACTIVE (parked) account: stays frozen, like a powered-off PC. Returned
///   as-is; never rotated in the background (that's what forks the chain and
///   logs out another holder).
pub async fn ensure_chatgpt_tokens_fresh(account: &StoredAccount) -> Result<StoredAccount> {
    match &account.auth_data {
        AuthData::ApiKey { .. } | AuthData::ClaudeOAuth { .. } => Ok(account.clone()),
        AuthData::ChatGPT { .. } => {
            let store = load_accounts()?;
            let is_active = store.active_account_id.as_deref() == Some(account.id.as_str());
            if !is_active {
                // Parked account: never touch its token chain. Return it frozen.
                return Ok(account.clone());
            }

            // Active: prefer whatever the Codex CLI wrote; refresh once only if
            // that token is actually expired (switching into a long-parked
            // account leaves its access token stale and unusable otherwise).
            let _ = crate::auth::storage::sync_codex_tokens_from_file(&account.id);
            let synced = load_accounts()?
                .accounts
                .into_iter()
                .find(|a| a.id == account.id)
                .unwrap_or_else(|| account.clone());
            match &synced.auth_data {
                AuthData::ChatGPT { access_token, .. } if chatgpt_token_expired(access_token) => {
                    refresh_chatgpt_tokens(&synced).await
                }
                _ => Ok(synced),
            }
        }
    }
}

/// True when the JWT access token is expired or within 60s of expiry.
fn chatgpt_token_expired(access_token: &str) -> bool {
    match parse_jwt_expiry(access_token) {
        Some(exp) => exp <= Utc::now() + chrono::Duration::seconds(60),
        None => false,
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

pub fn claude_token_expired(expires_at_ms: i64) -> bool {
    expires_at_ms <= Utc::now().timestamp_millis() + CLAUDE_EXPIRY_SKEW_MS
}

const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

#[derive(Debug, serde::Deserialize)]
struct ClaudeRefreshResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

/// Force-refresh a Claude account's OAuth tokens. Anthropic rotates the
/// refresh_token on every call with no grace period, so this must only ever be
/// called in the one safe window: right before switching INTO a parked account,
/// when nothing else on this machine can be concurrently holding/refreshing the
/// same credential (Claude Code only owns whichever account is *currently*
/// active in ~/.claude/.credentials.json — and that's not this one yet).
pub async fn refresh_claude_tokens(account: &StoredAccount) -> Result<StoredAccount> {
    let refresh_token = match &account.auth_data {
        AuthData::ClaudeOAuth { refresh_token, .. } => refresh_token.clone(),
        _ => return Ok(account.clone()),
    };
    if refresh_token.trim().is_empty() {
        anyhow::bail!("Missing refresh token for account {}", account.name);
    }

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

    let expires_at = Utc::now().timestamp_millis() + refreshed.expires_in * 1000;
    super::storage::update_account_claude_tokens(
        &account.id,
        refreshed.access_token,
        refreshed.refresh_token,
        expires_at,
    )
}

/// Ensure the ACTIVE Claude account's in-DB tokens reflect the live credentials
/// file, WITHOUT ever calling Claude's token endpoint.
///
/// "Powered-off PC" safety model. Anthropic rotates and invalidates the
/// refresh_token on every refresh, so the switcher must never refresh a Claude
/// token itself — doing so for an account that is also live elsewhere (or whose
/// stored copy is stale) triggers refresh-token reuse detection and logs the
/// account out of ALL sessions.
///
/// - ACTIVE account: its credential file is owned by the running Claude Code,
///   which keeps it fresh. We only re-read (sync) whatever Claude Code wrote.
/// - INACTIVE (parked) account: stays frozen, exactly like a powered-off PC. We
///   return the stored credentials untouched; the (possibly expired) access
///   token will be refreshed by Claude Code itself — once, forward-only — the
///   next time this account is switched in and used.
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

    // Parked account: never touch its token chain. Return it frozen.
    Ok(account.clone())
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
