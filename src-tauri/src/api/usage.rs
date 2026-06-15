//! Usage API client for fetching rate limits and credits

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures::{stream, StreamExt};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, USER_AGENT},
    StatusCode,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::auth::{
    ensure_chatgpt_tokens_fresh, ensure_claude_tokens_fresh, load_accounts, refresh_chatgpt_tokens,
};
use crate::types::{
    AuthData, CreditStatusDetails, RateLimitDetails, RateLimitStatusPayload, RateLimitWindow,
    StoredAccount, UsageInfo,
};

const CHATGPT_BACKEND_API: &str = "https://chatgpt.com/backend-api";
const CHATGPT_ACCOUNTS_CHECK_API: &str =
    "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_CODEX_RESPONSES_API: &str = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_API: &str = "https://api.openai.com/v1";
const CODEX_USER_AGENT: &str = "codex-cli/1.0.0";

const CLAUDE_OAUTH_USAGE_API: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_PRIMARY_WINDOW_MINUTES: i64 = 5 * 60;
const CLAUDE_SECONDARY_WINDOW_MINUTES: i64 = 7 * 24 * 60;

/// Default cooldown after a 429 when the server does not send Retry-After.
const RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS: i64 = 300;
const RATE_LIMIT_MAX_COOLDOWN_SECONDS: i64 = 3600;

/// Per-account cooldown gate: after a 429 no further requests are sent for
/// that account until the deadline passes; callers get a rate_limited
/// UsageInfo instantly instead.
static RATE_LIMIT_GATE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, i64>>> =
    std::sync::OnceLock::new();

fn rate_limit_gate() -> &'static std::sync::Mutex<HashMap<String, i64>> {
    RATE_LIMIT_GATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Seconds remaining in this account's cooldown, if any.
fn rate_limit_remaining(account_id: &str) -> Option<i64> {
    let map = rate_limit_gate().lock().ok()?;
    let until = *map.get(account_id)?;
    let now = Utc::now().timestamp();
    if until > now {
        Some(until - now)
    } else {
        None
    }
}

fn start_rate_limit_cooldown(account_id: &str, seconds: i64) {
    let seconds = seconds.clamp(
        RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS,
        RATE_LIMIT_MAX_COOLDOWN_SECONDS,
    );
    if let Ok(mut map) = rate_limit_gate().lock() {
        map.insert(account_id.to_string(), Utc::now().timestamp() + seconds);
    }
    println!("[Usage] Account {account_id} rate limited, cooling down for {seconds}s");
}

fn retry_after_seconds(response: &reqwest::Response) -> i64 {
    response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS)
}

/// If the response is a 429, start the cooldown and return the rate_limited
/// UsageInfo to hand back to the UI.
fn handle_rate_limited_response(
    account_id: &str,
    response: &reqwest::Response,
) -> Option<UsageInfo> {
    if response.status() != StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let seconds = retry_after_seconds(response);
    start_rate_limit_cooldown(account_id, seconds);
    Some(UsageInfo::rate_limited(account_id.to_string(), seconds))
}

#[derive(Debug, Clone)]
pub struct ChatGptAccountMetadata {
    pub plan_type: Option<String>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckResponse {
    #[serde(default)]
    accounts: HashMap<String, AccountsCheckEntry>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntry {
    #[serde(default)]
    account: Option<AccountsCheckAccount>,
    #[serde(default)]
    entitlement: Option<AccountsCheckEntitlement>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckAccount {
    #[serde(default)]
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntitlement {
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
}

/// Get usage information for an account
pub async fn get_account_usage(account: &StoredAccount) -> Result<UsageInfo> {
    // Honor an active 429 cooldown without touching the network.
    if let Some(remaining) = rate_limit_remaining(&account.id) {
        println!(
            "[Usage] Account {} still cooling down ({remaining}s left), skipping fetch",
            account.name
        );
        return Ok(UsageInfo::rate_limited(account.id.clone(), remaining));
    }

    println!("[Usage] Fetching usage for account: {}", account.name);

    match &account.auth_data {
        AuthData::ApiKey { .. } => {
            println!("[Usage] API key accounts don't support usage info");
            Ok(UsageInfo {
                account_id: account.id.clone(),
                plan_type: Some("api_key".to_string()),
                primary_used_percent: None,
                primary_window_minutes: None,
                primary_resets_at: None,
                secondary_used_percent: None,
                secondary_window_minutes: None,
                secondary_resets_at: None,
                has_credits: None,
                unlimited_credits: None,
                credits_balance: None,
                error: Some("Usage info not available for API key accounts".to_string()),
                rate_limited: None,
            })
        }
        AuthData::ChatGPT { .. } => get_usage_with_chatgpt_auth(account).await,
        AuthData::ClaudeOAuth { .. } => get_usage_with_claude_auth(account).await,
    }
}

/// Send a minimal authenticated request to warm up account traffic paths.
pub async fn warmup_account(account: &StoredAccount) -> Result<()> {
    println!(
        "[Warmup] Sending warm-up request for account: {}",
        account.name
    );

    match &account.auth_data {
        AuthData::ApiKey { key } => warmup_with_api_key(key).await,
        AuthData::ChatGPT { .. } => warmup_with_chatgpt_auth(account).await,
        AuthData::ClaudeOAuth { .. } => {
            anyhow::bail!("Claude warm-up is not supported in this version")
        }
    }
}

pub async fn fetch_chatgpt_account_metadata(
    account: &StoredAccount,
) -> Result<ChatGptAccountMetadata> {
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(account)?;
    let response =
        send_chatgpt_get_request(CHATGPT_ACCOUNTS_CHECK_API, access_token, chatgpt_account_id)
            .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Accounts check API error: {status} - {body}");
    }

    let payload: AccountsCheckResponse = response
        .json()
        .await
        .context("Failed to parse accounts check response")?;

    let selected_entry = chatgpt_account_id
        .and_then(|account_id| payload.accounts.get(account_id))
        .or_else(|| payload.accounts.get("default"))
        .or_else(|| payload.accounts.values().next())
        .context("Accounts check response did not include an account entry")?;

    Ok(ChatGptAccountMetadata {
        plan_type: selected_entry
            .account
            .as_ref()
            .and_then(|account| account.plan_type.clone()),
        subscription_expires_at: selected_entry
            .entitlement
            .as_ref()
            .and_then(|entitlement| entitlement.expires_at),
    })
}

async fn get_usage_with_chatgpt_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let response = send_chatgpt_usage_request(access_token, chatgpt_account_id).await?;
    if let Some(limited) = handle_rate_limited_response(&fresh_account.id, &response) {
        return Ok(limited);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Usage] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        let retry_response = send_chatgpt_usage_request(retry_token, retry_account_id).await?;
        if let Some(limited) = handle_rate_limited_response(&refreshed_account.id, &retry_response)
        {
            return Ok(limited);
        }
        return parse_usage_response(
            &refreshed_account.id,
            &refreshed_account.name,
            retry_response,
        )
        .await;
    }

    parse_usage_response(&fresh_account.id, &fresh_account.name, response).await
}

async fn parse_usage_response(
    account_id: &str,
    account_name: &str,
    response: reqwest::Response,
) -> Result<UsageInfo> {
    let status = response.status();
    println!("[Usage] Response status: {status}");

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        println!("[Usage] Error response: {body}");
        return Ok(UsageInfo::error(
            account_id.to_string(),
            format!("API error: {status}"),
        ));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read response body")?;
    println!(
        "[Usage] Response body: {}",
        &body_text[..body_text.len().min(200)]
    );

    let payload: RateLimitStatusPayload =
        serde_json::from_str(&body_text).context("Failed to parse usage response")?;

    println!("[Usage] Parsed plan_type: {}", payload.plan_type);

    let usage = convert_payload_to_usage_info(account_id, payload);
    println!(
        "[Usage] {} - primary: {:?}%, plan: {:?}",
        account_name, usage.primary_used_percent, usage.plan_type
    );

    Ok(usage)
}

/// One rate-limit window from https://api.anthropic.com/api/oauth/usage.
/// `resets_at` is an ISO 8601 string on this endpoint, but other Claude Code
/// surfaces emit epoch seconds — accept both.
#[derive(Debug, Deserialize)]
struct ClaudeUsageWindow {
    utilization: f64,
    #[serde(default)]
    resets_at: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsageResponse {
    #[serde(default)]
    five_hour: Option<ClaudeUsageWindow>,
    #[serde(default)]
    seven_day: Option<ClaudeUsageWindow>,
}

fn extract_claude_access_token(account: &StoredAccount) -> Result<String> {
    match &account.auth_data {
        AuthData::ClaudeOAuth { access_token, .. } => Ok(access_token.clone()),
        _ => anyhow::bail!("Account is not using Claude OAuth"),
    }
}

async fn get_usage_with_claude_auth(account: &StoredAccount) -> Result<UsageInfo> {
    // "Powered-off PC" safety model: a parked (inactive) Claude account must
    // NEVER be contacted by the switcher. Anthropic rotates and invalidates the
    // refresh_token on every token refresh, so any request that needs a fresh
    // token would risk refresh-token reuse detection and log the account out of
    // ALL sessions. Inactive accounts therefore serve the last cached usage
    // snapshot (which already carries the window reset timestamps the UI shows),
    // with zero network I/O. Only the ACTIVE account — whose credential file is
    // owned and kept fresh by the running Claude Code — is fetched live.
    let store = load_accounts()?;
    let is_active = store.active_claude_account_id.as_deref() == Some(account.id.as_str());
    if !is_active {
        return Ok(parked_claude_usage(account));
    }

    // Active account: re-read whatever Claude Code wrote to the live credentials
    // file. ensure_claude_tokens_fresh syncs only — it never rotates the token.
    let fresh_account = match ensure_claude_tokens_fresh(account).await {
        Ok(acc) => acc,
        Err(err) => {
            let message = err.to_string();
            // The token endpoint rate-limits too; treat it the same way.
            if message.contains("429") {
                start_rate_limit_cooldown(&account.id, RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS);
                return Ok(UsageInfo::rate_limited(
                    account.id.clone(),
                    RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS,
                ));
            }
            return Ok(UsageInfo::error(
                account.id.clone(),
                format!("Claude token refresh failed: {message}"),
            ));
        }
    };

    let access_token = extract_claude_access_token(&fresh_account)?;
    let response = send_claude_usage_request(&access_token).await?;
    if let Some(limited) = handle_rate_limited_response(&fresh_account.id, &response) {
        return Ok(limited);
    }

    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        println!(
            "[Usage] Claude token rejected for account {}, re-syncing from live file",
            fresh_account.name
        );
        // Never rotate the token ourselves — the active account's credential is
        // owned by Claude Code. Re-read whatever the live file has and retry once.
        let _ = crate::auth::storage::sync_claude_tokens_from_file(&fresh_account.id);
        let retried_account = load_accounts()?
            .accounts
            .into_iter()
            .find(|a| a.id == fresh_account.id);

        if let Some(retried) = retried_account {
            let retry_token = extract_claude_access_token(&retried)?;
            if retry_token != access_token {
                let retry_response = send_claude_usage_request(&retry_token).await?;
                if let Some(limited) = handle_rate_limited_response(&retried.id, &retry_response) {
                    return Ok(limited);
                }
                return parse_claude_usage_response(&retried, retry_response).await;
            }
        }

        return Ok(UsageInfo::error(
            fresh_account.id.clone(),
            "Claude session token rejected — open Claude Code to refresh the login".to_string(),
        ));
    }

    parse_claude_usage_response(&fresh_account, response).await
}

/// Last-known usage for a parked (inactive) Claude account, served WITHOUT any
/// network request so the account's refresh-token chain stays frozen — exactly
/// like a powered-off PC. The cached snapshot already contains the window reset
/// timestamps, so the UI keeps showing the last value and its reset countdown.
fn parked_claude_usage(account: &StoredAccount) -> UsageInfo {
    match &account.cached_usage {
        Some(snapshot) if snapshot.error.is_none() => {
            let mut snapshot = snapshot.clone();
            snapshot.account_id = account.id.clone();
            snapshot.rate_limited = None;
            snapshot
        }
        // Never fetched yet (or last fetch errored): neutral empty bar, not an error.
        _ => UsageInfo::empty(account.id.clone()),
    }
}

async fn send_claude_usage_request(access_token: &str) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    println!("[Usage] Requesting: {CLAUDE_OAUTH_USAGE_API}");

    client
        .get(CLAUDE_OAUTH_USAGE_API)
        .header(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {access_token}"))
                .context("Invalid Claude access token")?,
        )
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        .header("Accept", "application/json")
        .send()
        .await
        .context("Failed to send Claude usage request")
}

async fn parse_claude_usage_response(
    account: &StoredAccount,
    response: reqwest::Response,
) -> Result<UsageInfo> {
    let status = response.status();
    println!("[Usage] Claude response status: {status}");

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        println!("[Usage] Claude error response: {body}");
        return Ok(UsageInfo::error(
            account.id.clone(),
            format!("Claude usage API error: {status}"),
        ));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read Claude usage response body")?;
    let payload: ClaudeUsageResponse =
        serde_json::from_str(&body_text).context("Failed to parse Claude usage response")?;

    let primary = payload.five_hour.as_ref();
    let secondary = payload.seven_day.as_ref();

    let usage = UsageInfo {
        account_id: account.id.clone(),
        plan_type: account.plan_type.clone(),
        primary_used_percent: primary.map(|w| w.utilization.clamp(0.0, 100.0)),
        primary_window_minutes: primary.map(|_| CLAUDE_PRIMARY_WINDOW_MINUTES),
        primary_resets_at: primary.and_then(claude_window_reset_at),
        secondary_used_percent: secondary.map(|w| w.utilization.clamp(0.0, 100.0)),
        secondary_window_minutes: secondary.map(|_| CLAUDE_SECONDARY_WINDOW_MINUTES),
        secondary_resets_at: secondary.and_then(claude_window_reset_at),
        has_credits: None,
        unlimited_credits: None,
        credits_balance: None,
        error: None,
        rate_limited: None,
    };

    println!(
        "[Usage] {} (Claude) - 5h: {:?}%, 7d: {:?}%",
        account.name, usage.primary_used_percent, usage.secondary_used_percent
    );

    Ok(usage)
}

fn claude_window_reset_at(window: &ClaudeUsageWindow) -> Option<i64> {
    match window.resets_at.as_ref()? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.timestamp()),
        _ => None,
    }
}

async fn warmup_with_chatgpt_auth(account: &StoredAccount) -> Result<()> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let mut response = send_chatgpt_warmup_request(access_token, chatgpt_account_id, true).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Warmup] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        response = send_chatgpt_warmup_request(retry_token, retry_account_id, true).await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        println!("[Warmup] ChatGPT warm-up error response: {body}");
        anyhow::bail!("ChatGPT warm-up failed with status {status}");
    }

    let body = response.text().await.unwrap_or_default();
    log_warmup_response("ChatGPT", &body, true);

    Ok(())
}

async fn warmup_with_api_key(api_key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let payload = build_warmup_payload(false, true);
    let response = client
        .post(format!("{OPENAI_API}/responses"))
        .header(USER_AGENT, CODEX_USER_AGENT)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .json(&payload)
        .send()
        .await
        .context("Failed to send API key warm-up request")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        println!("[Warmup] API key warm-up error response: {body}");
        anyhow::bail!("API key warm-up failed with status {status}");
    }

    let body = response.text().await.unwrap_or_default();
    log_warmup_response("API key", &body, false);

    Ok(())
}

fn build_warmup_payload(stream: bool, include_max_output_tokens: bool) -> serde_json::Value {
    let mut payload = json!({
        "model": "gpt-5.4-mini",
        "instructions": "You are Codex.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "Hi"
                    }
                ]
            }
        ],
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "reasoning": {
            "effort": "low"
        },
        "store": false,
        "stream": stream
    });

    if include_max_output_tokens {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("max_output_tokens".to_string(), json!(1));
        }
    }

    payload
}

fn build_chatgpt_headers(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_USER_AGENT));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}")).context("Invalid access token")?,
    );

    if let Some(acc_id) = chatgpt_account_id {
        println!("[Usage] Using ChatGPT Account ID: {acc_id}");
        if let Ok(header_name) = HeaderName::from_bytes(b"chatgpt-account-id") {
            if let Ok(header_value) = HeaderValue::from_str(acc_id) {
                headers.insert(header_name, header_value);
            }
        }
    }

    Ok(headers)
}

fn extract_chatgpt_auth(account: &StoredAccount) -> Result<(&str, Option<&str>)> {
    match &account.auth_data {
        AuthData::ChatGPT {
            access_token,
            account_id,
            ..
        } => Ok((access_token.as_str(), account_id.as_deref())),
        AuthData::ApiKey { .. } | AuthData::ClaudeOAuth { .. } => {
            anyhow::bail!("Account is not using ChatGPT OAuth")
        }
    }
}

async fn send_chatgpt_usage_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    send_chatgpt_get_request(
        &format!("{CHATGPT_BACKEND_API}/wham/usage"),
        access_token,
        chatgpt_account_id,
    )
    .await
}

async fn send_chatgpt_get_request(
    url: &str,
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    println!("[Usage] Requesting: {url}");

    client
        .get(url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("Failed to send GET request to {url}"))
}

async fn send_chatgpt_warmup_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
    stream: bool,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    let payload = build_warmup_payload(stream, false);

    client
        .post(CHATGPT_CODEX_RESPONSES_API)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .context("Failed to send ChatGPT warm-up request")
}

fn log_warmup_response(source: &str, body: &str, is_sse: bool) {
    if body.trim().is_empty() {
        println!("[Warmup] {source} warm-up response was empty");
        return;
    }

    let preview = truncate_text(body, 300);
    println!("[Warmup] {source} warm-up response preview: {preview}");

    let extracted = if is_sse {
        extract_text_from_sse(body)
    } else {
        extract_text_from_json(body)
    };

    if let Some(message) = extracted {
        let message_preview = truncate_text(&message, 200);
        println!("[Warmup] {source} warm-up message: {message_preview}");
    }
}

fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    let mut out = text[..max_len].to_string();
    out.push_str("...");
    out
}

fn extract_text_from_sse(body: &str) -> Option<String> {
    let mut last_text: Option<String> = None;
    for line in body.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let data = line.trim_start_matches("data:").trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if let Some(text) = extract_last_text_from_value(&value) {
                last_text = Some(text);
            }
        }
    }
    last_text.filter(|text| !text.trim().is_empty())
}

fn extract_text_from_json(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    extract_last_text_from_value(&value)
}

fn extract_last_text_from_value(value: &Value) -> Option<String> {
    let mut last: Option<String> = None;
    collect_last_text(value, &mut last);
    last
}

fn collect_last_text(value: &Value, last: &mut Option<String>) {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                if matches!(key.as_str(), "text" | "delta" | "output_text") {
                    if let Value::String(text) = val {
                        if !text.is_empty() {
                            *last = Some(text.clone());
                        }
                    }
                }
                collect_last_text(val, last);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_last_text(item, last);
            }
        }
        _ => {}
    }
}

/// Convert API response to UsageInfo
fn convert_payload_to_usage_info(account_id: &str, payload: RateLimitStatusPayload) -> UsageInfo {
    let (primary, secondary) = extract_rate_limits(payload.rate_limit);
    let credits = extract_credits(payload.credits);

    UsageInfo {
        account_id: account_id.to_string(),
        plan_type: Some(payload.plan_type),
        primary_used_percent: primary.as_ref().map(|w| w.used_percent),
        primary_window_minutes: primary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        primary_resets_at: primary.as_ref().and_then(|w| w.reset_at),
        secondary_used_percent: secondary.as_ref().map(|w| w.used_percent),
        secondary_window_minutes: secondary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        secondary_resets_at: secondary.as_ref().and_then(|w| w.reset_at),
        has_credits: credits.as_ref().map(|c| c.has_credits),
        unlimited_credits: credits.as_ref().map(|c| c.unlimited),
        credits_balance: credits.and_then(|c| c.balance),
        error: None,
        rate_limited: None,
    }
}

fn extract_rate_limits(
    rate_limit: Option<RateLimitDetails>,
) -> (Option<RateLimitWindow>, Option<RateLimitWindow>) {
    match rate_limit {
        Some(details) => (details.primary_window, details.secondary_window),
        None => (None, None),
    }
}

fn extract_credits(credits: Option<CreditStatusDetails>) -> Option<CreditStatusDetails> {
    credits
}

/// Refresh all account usage
pub async fn refresh_all_usage(accounts: &[StoredAccount]) -> Vec<UsageInfo> {
    println!("[Usage] Refreshing usage for {} accounts", accounts.len());

    let concurrency = accounts.len().min(10).max(1);
    let results: Vec<UsageInfo> = stream::iter(accounts.iter().cloned())
        .map(|account| async move {
            match get_account_usage(&account).await {
                Ok(info) => info,
                Err(e) => {
                    println!("[Usage] Error for {}: {}", account.name, e);
                    UsageInfo::error(account.id.clone(), e.to_string())
                }
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    println!("[Usage] Refresh complete");
    results
}
