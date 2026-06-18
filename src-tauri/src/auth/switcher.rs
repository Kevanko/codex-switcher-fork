//! Account switching logic - writes credentials to ~/.codex/auth.json

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::Utc;

use crate::auth::storage::with_store;
use crate::types::{
    parse_chatgpt_id_token_claims, AuthData, AuthDotJson, ClaudeAiOauthCredentials,
    ClaudeCredentialsFile, StoredAccount, TokenData,
};

/// Get the official Codex home directory
pub fn get_codex_home() -> Result<PathBuf> {
    // Check for CODEX_HOME environment variable first
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return Ok(PathBuf::from(codex_home));
    }

    let home = dirs::home_dir().context("Could not find home directory")?;
    Ok(home.join(".codex"))
}

/// Get the path to the official auth.json file
pub fn get_codex_auth_file() -> Result<PathBuf> {
    Ok(get_codex_home()?.join("auth.json"))
}

/// Get the official Claude credentials file path.
pub fn get_claude_credentials_file() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    Ok(home.join(".claude").join(".credentials.json"))
}

/// Result of reconciling the active Claude account with the live credentials file.
#[derive(Debug)]
pub enum ClaudeReconcileResult {
    /// ~/.claude/.credentials.json does not exist — no active Claude session.
    FileNotFound,
    /// File matches a known stored account (returns its id).
    MatchedAccount(String),
    /// File exists but credentials don't match any stored account (external login).
    UnknownCredentials,
}

/// Reconcile the stored active Claude account with ~/.claude/.credentials.json.
/// Mirrors reconcile_active_account_with_current_auth() for Codex.
pub fn reconcile_active_claude_account() -> Result<ClaudeReconcileResult> {
    let creds_path = get_claude_credentials_file()?;

    if !creds_path.exists() {
        return with_store(|store| {
            let changed = if store.active_claude_account_id.is_some() {
                store.active_claude_account_id = None;
                true
            } else {
                false
            };
            Ok((ClaudeReconcileResult::FileNotFound, changed))
        });
    }

    let content = match fs::read_to_string(&creds_path) {
        Ok(c) => c,
        Err(_) => return Ok(ClaudeReconcileResult::UnknownCredentials),
    };
    let file_creds: ClaudeCredentialsFile = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => return Ok(ClaudeReconcileResult::UnknownCredentials),
    };

    with_store(|store| {
        // Find a stored Claude account whose refresh_token matches the file.
        let matched_id = store
            .accounts
            .iter()
            .find(|a| {
                if let AuthData::ClaudeOAuth { refresh_token, .. } = &a.auth_data {
                    refresh_token == &file_creds.claude_ai_oauth.refresh_token
                } else {
                    false
                }
            })
            .map(|a| a.id.clone());

        match matched_id {
            Some(id) => {
                let mut changed = false;

                // Update active pointer if needed.
                if store.active_claude_account_id.as_deref() != Some(id.as_str()) {
                    store.active_claude_account_id = Some(id.clone());
                    changed = true;
                }

                // Sync ALL token fields and metadata — Claude rotates refresh_token
                // on every use and subscription/tier can change server-side.
                if let Some(account) = store.accounts.iter_mut().find(|a| a.id == id) {
                    if account.sync_claude_credentials(&file_creds) {
                        changed = true;
                    }
                }

                Ok((ClaudeReconcileResult::MatchedAccount(id), changed))
            }
            None => {
                // No account matched by refresh_token — Claude most likely rotated it.
                // Adopt the live credentials into the active account so the next switch
                // back uses valid tokens, but only when the organization UUID does not
                // contradict (guards against an external login into a different account
                // silently overwriting this one).
                if let Some(active_id) = store.active_claude_account_id.clone() {
                    let adopted = store
                        .accounts
                        .iter_mut()
                        .find(|a| a.id == active_id)
                        .filter(|a| a.claude_org_matches(&file_creds))
                        .map(|account| account.sync_claude_credentials(&file_creds));
                    if let Some(changed) = adopted {
                        return Ok((ClaudeReconcileResult::MatchedAccount(active_id), changed));
                    }
                }
                Ok((ClaudeReconcileResult::UnknownCredentials, false))
            }
        }
    })
}

/// Switch to a specific account by writing its credentials to ~/.codex/auth.json
pub fn switch_to_account(account: &StoredAccount) -> Result<()> {
    let codex_home = get_codex_home()?;

    // Ensure the codex home directory exists
    fs::create_dir_all(&codex_home)
        .with_context(|| format!("Failed to create codex home: {}", codex_home.display()))?;

    let auth_json = create_auth_json(account)?;

    let auth_path = codex_home.join("auth.json");
    let content =
        serde_json::to_string_pretty(&auth_json).context("Failed to serialize auth.json")?;

    fs::write(&auth_path, content)
        .with_context(|| format!("Failed to write auth.json: {}", auth_path.display()))?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&auth_path, perms)?;
    }

    Ok(())
}

/// Switch Claude Code to a specific account by writing ~/.claude/.credentials.json.
pub fn switch_to_claude_account(account: &StoredAccount) -> Result<()> {
    let mut credentials = create_claude_credentials(account)?;
    let credentials_path = get_claude_credentials_file()?;

    // If the current file already belongs to this account (same refresh_token) and
    // has a fresher access token (Claude Code auto-refreshes), use it instead of
    // overwriting with our stale stored copy.
    if credentials_path.exists() {
        if let Ok(existing_content) = fs::read_to_string(&credentials_path) {
            if let Ok(existing) =
                serde_json::from_str::<ClaudeCredentialsFile>(&existing_content)
            {
                if existing.claude_ai_oauth.refresh_token
                    == credentials.claude_ai_oauth.refresh_token
                    && existing.claude_ai_oauth.expires_at
                        > credentials.claude_ai_oauth.expires_at
                {
                    credentials.claude_ai_oauth.access_token =
                        existing.claude_ai_oauth.access_token;
                    credentials.claude_ai_oauth.expires_at =
                        existing.claude_ai_oauth.expires_at;
                }
            }
        }
    }

    let claude_home = credentials_path
        .parent()
        .context("Claude credentials path has no parent directory")?;

    fs::create_dir_all(claude_home)
        .with_context(|| format!("Failed to create Claude home: {}", claude_home.display()))?;

    let content = serde_json::to_string_pretty(&credentials)
        .context("Failed to serialize Claude credentials")?;
    let temp_path = claude_home.join(format!(
        ".credentials.json.tmp-{}",
        Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000)
    ));

    fs::write(&temp_path, content).with_context(|| {
        format!(
            "Failed to write temporary Claude credentials: {}",
            temp_path.display()
        )
    })?;
    if credentials_path.exists() {
        fs::remove_file(&credentials_path).with_context(|| {
            format!(
                "Failed to replace Claude credentials: {}",
                credentials_path.display()
            )
        })?;
    }
    fs::rename(&temp_path, &credentials_path).with_context(|| {
        format!(
            "Failed to move temporary Claude credentials {} to {}",
            temp_path.display(),
            credentials_path.display()
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&credentials_path, perms)?;
    }

    Ok(())
}

/// Create an AuthDotJson structure from a StoredAccount
fn create_auth_json(account: &StoredAccount) -> Result<AuthDotJson> {
    match &account.auth_data {
        AuthData::ApiKey { key } => Ok(AuthDotJson {
            openai_api_key: Some(key.clone()),
            tokens: None,
            last_refresh: None,
        }),
        AuthData::ChatGPT {
            id_token,
            access_token,
            refresh_token,
            account_id,
        } => Ok(AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: id_token.clone(),
                access_token: access_token.clone(),
                refresh_token: refresh_token.clone(),
                account_id: account_id.clone(),
            }),
            last_refresh: Some(Utc::now()),
        }),
        AuthData::ClaudeOAuth { .. } => {
            anyhow::bail!("Claude accounts cannot be written to Codex auth.json")
        }
    }
}

fn create_claude_credentials(account: &StoredAccount) -> Result<ClaudeCredentialsFile> {
    match &account.auth_data {
        AuthData::ClaudeOAuth {
            access_token,
            refresh_token,
            expires_at,
            scopes,
            subscription_type,
            rate_limit_tier,
            organization_uuid,
        } => Ok(ClaudeCredentialsFile {
            claude_ai_oauth: ClaudeAiOauthCredentials {
                access_token: access_token.clone(),
                refresh_token: refresh_token.clone(),
                expires_at: *expires_at,
                scopes: scopes.clone(),
                subscription_type: subscription_type.clone(),
                rate_limit_tier: rate_limit_tier.clone(),
            },
            organization_uuid: organization_uuid.clone(),
        }),
        _ => anyhow::bail!("Account is not a Claude OAuth account"),
    }
}

/// Import an account from an existing auth.json file
pub fn import_from_auth_json(path: &str, account_name: String) -> Result<StoredAccount> {
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read auth.json: {path}"))?;

    import_from_auth_json_contents(&content, account_name)
        .with_context(|| format!("Failed to parse auth.json: {path}"))
}

/// Import an account from auth.json file contents.
pub fn import_from_auth_json_contents(
    content: &str,
    account_name: String,
) -> Result<StoredAccount> {
    let auth: AuthDotJson =
        serde_json::from_str(&content).context("Failed to parse auth.json contents")?;

    // Determine auth mode and create account
    if let Some(api_key) = auth.openai_api_key {
        Ok(StoredAccount::new_api_key(account_name, api_key))
    } else if let Some(tokens) = auth.tokens {
        let claims = parse_chatgpt_id_token_claims(&tokens.id_token);

        Ok(StoredAccount::new_chatgpt(
            account_name,
            claims.email,
            claims.plan_type,
            claims.subscription_expires_at,
            tokens.id_token,
            tokens.access_token,
            tokens.refresh_token,
            claims.account_id.or(tokens.account_id),
        ))
    } else {
        anyhow::bail!("auth.json contains neither API key nor tokens");
    }
}

/// Import a Claude account from an existing .credentials.json file.
pub fn import_from_claude_credentials(path: &str, account_name: String) -> Result<StoredAccount> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("Failed to read Claude credentials: {path}"))?;

    import_from_claude_credentials_contents(&content, account_name)
        .with_context(|| format!("Failed to parse Claude credentials: {path}"))
}

pub fn import_from_claude_credentials_contents(
    content: &str,
    account_name: String,
) -> Result<StoredAccount> {
    let credentials: ClaudeCredentialsFile =
        serde_json::from_str(content).context("Failed to parse Claude credentials contents")?;

    validate_claude_credentials(&credentials)?;
    Ok(StoredAccount::new_claude(account_name, credentials))
}

fn validate_claude_credentials(credentials: &ClaudeCredentialsFile) -> Result<()> {
    if credentials.claude_ai_oauth.access_token.trim().is_empty() {
        anyhow::bail!("Claude accessToken is missing");
    }
    if credentials.claude_ai_oauth.refresh_token.trim().is_empty() {
        anyhow::bail!("Claude refreshToken is missing");
    }
    if credentials.claude_ai_oauth.expires_at <= 0 {
        anyhow::bail!("Claude expiresAt is missing");
    }
    Ok(())
}

/// Read the current auth.json file if it exists
pub fn read_current_auth() -> Result<Option<AuthDotJson>> {
    let path = get_codex_auth_file()?;

    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read auth.json: {}", path.display()))?;

    let auth: AuthDotJson = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse auth.json: {}", path.display()))?;

    Ok(Some(auth))
}

/// Check if there is an active Codex login
pub fn has_active_login() -> Result<bool> {
    match read_current_auth()? {
        Some(auth) => Ok(auth.openai_api_key.is_some() || auth.tokens.is_some()),
        None => Ok(false),
    }
}

/// Reconcile the stored active account with the real Codex auth.json file.
pub fn reconcile_active_account_with_current_auth() -> Result<Option<String>> {
    let current_auth = match read_current_auth()? {
        Some(auth) => auth,
        None => return Ok(None),
    };

    with_store(|store| {
        let matched_id = store
            .accounts
            .iter()
            .find(|account| account_matches_auth(account, &current_auth))
            .map(|account| account.id.clone());

        let mut changed = false;
        if let Some(ref matched_id) = matched_id {
            if store.active_account_id.as_deref() != Some(matched_id.as_str()) {
                store.active_account_id = Some(matched_id.clone());
                changed = true;
            }
        }

        Ok((matched_id, changed))
    })
}

fn account_matches_auth(account: &StoredAccount, auth: &AuthDotJson) -> bool {
    match (
        &account.auth_data,
        auth.openai_api_key.as_ref(),
        auth.tokens.as_ref(),
    ) {
        (AuthData::ApiKey { key }, Some(active_key), _) => key == active_key,
        (
            AuthData::ChatGPT {
                id_token,
                access_token,
                refresh_token,
                account_id,
            },
            _,
            Some(tokens),
        ) => {
            if refresh_token == &tokens.refresh_token {
                return true;
            }

            if let (Some(stored_account_id), Some(active_account_id)) =
                (account_id.as_ref(), tokens.account_id.as_ref())
            {
                if stored_account_id == active_account_id {
                    return true;
                }
            }

            id_token == &tokens.id_token
                && access_token == &tokens.access_token
                && refresh_token == &tokens.refresh_token
        }
        (AuthData::ClaudeOAuth { .. }, _, _) => false,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::import_from_claude_credentials_contents;
    use crate::types::{AccountProvider, AuthData};

    #[test]
    fn imports_valid_claude_credentials_contents() {
        let payload = r#"{
            "claudeAiOauth": {
                "accessToken": "access",
                "refreshToken": "refresh",
                "expiresAt": 1893456000000,
                "scopes": [],
                "subscriptionType": "max",
                "rateLimitTier": "tier_2"
            },
            "organizationUuid": "org_123"
        }"#;

        let account =
            import_from_claude_credentials_contents(payload, "Claude Work".to_string()).unwrap();

        assert_eq!(account.provider, AccountProvider::Claude);
        assert!(matches!(account.auth_data, AuthData::ClaudeOAuth { .. }));
        assert_eq!(account.plan_type.as_deref(), Some("max"));
    }

    #[test]
    fn rejects_incomplete_claude_credentials_contents() {
        let payload = r#"{
            "claudeAiOauth": {
                "accessToken": "",
                "refreshToken": "refresh",
                "expiresAt": 1893456000000
            }
        }"#;

        let error = import_from_claude_credentials_contents(payload, "Broken".to_string())
            .unwrap_err()
            .to_string();

        assert!(error.contains("accessToken"));
    }
}
