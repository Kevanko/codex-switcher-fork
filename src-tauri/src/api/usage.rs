//! Usage API client for fetching rate limits and credits

use anyhow::{Context, Result};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, USER_AGENT},
    StatusCode,
};

use crate::auth::{ensure_chatgpt_tokens_fresh, refresh_chatgpt_tokens};
use crate::types::{
    AuthData, CreditStatusDetails, RateLimitDetails, RateLimitStatusPayload, RateLimitWindow,
    StoredAccount, UsageInfo,
};

const CHATGPT_BACKEND_API: &str = "https://chatgpt.com/backend-api";
const OPENAI_API: &str = "https://api.openai.com/v1";
const CODEX_USER_AGENT: &str = "codex-cli/1.0.0";

/// Get usage information for an account
pub async fn get_account_usage(account: &StoredAccount) -> Result<UsageInfo> {
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
            })
        }
        AuthData::ChatGPT { .. } => get_usage_with_chatgpt_auth(account).await,
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
    }
}

async fn get_usage_with_chatgpt_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let response = send_chatgpt_usage_request(access_token, chatgpt_account_id).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Usage] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        let retry_response = send_chatgpt_usage_request(retry_token, retry_account_id).await?;
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

async fn warmup_with_chatgpt_auth(account: &StoredAccount) -> Result<()> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let mut response = send_chatgpt_usage_request(access_token, chatgpt_account_id).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Warmup] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        response = send_chatgpt_usage_request(retry_token, retry_account_id).await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        println!("[Warmup] ChatGPT warm-up error response: {body}");
        anyhow::bail!("ChatGPT warm-up failed with status {status}");
    }

    Ok(())
}

async fn warmup_with_api_key(api_key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{OPENAI_API}/models"))
        .header(USER_AGENT, CODEX_USER_AGENT)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .send()
        .await
        .context("Failed to send API key warm-up request")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        println!("[Warmup] API key warm-up error response: {body}");
        anyhow::bail!("API key warm-up failed with status {status}");
    }

    Ok(())
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
        AuthData::ApiKey { .. } => anyhow::bail!("Account is not using ChatGPT OAuth"),
    }
}

async fn send_chatgpt_usage_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    let url = format!("{CHATGPT_BACKEND_API}/wham/usage");
    println!("[Usage] Requesting: {url}");

    client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .context("Failed to send usage request")
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

    let mut results = Vec::with_capacity(accounts.len());
    for account in accounts {
        match get_account_usage(account).await {
            Ok(info) => results.push(info),
            Err(e) => {
                println!("[Usage] Error for {}: {}", account.name, e);
                results.push(UsageInfo::error(account.id.clone(), e.to_string()));
            }
        }
    }

    println!("[Usage] Refresh complete");
    results
}
