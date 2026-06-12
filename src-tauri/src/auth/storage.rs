//! Account storage module - manages reading and writing accounts.json

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

use crate::types::{
    AccountProvider, AccountsStore, AuthData, StoredAccount, UsageInfo, ACCOUNTS_STORE_VERSION,
};

/// Get the path to the codex-switcher config directory
pub fn get_config_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    Ok(home.join(".codex-switcher"))
}

/// Get the path to accounts.json
pub fn get_accounts_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("accounts.json"))
}

/// Load the accounts store from disk
pub fn load_accounts() -> Result<AccountsStore> {
    let path = get_accounts_file()?;

    if !path.exists() {
        return Ok(AccountsStore::default());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read accounts file: {}", path.display()))?;

    let mut store: AccountsStore = match serde_json::from_str(&content) {
        Ok(store) => store,
        Err(parse_error) => {
            if let Some(repaired) = repair_known_trailing_json_corruption(&content) {
                let backup_path = path.with_file_name(format!(
                    "accounts.json.broken-{}",
                    Utc::now().format("%Y%m%d-%H%M%S")
                ));
                fs::write(&backup_path, &content).with_context(|| {
                    format!(
                        "Failed to backup broken accounts file: {}",
                        backup_path.display()
                    )
                })?;
                let store: AccountsStore = serde_json::from_str(&repaired).with_context(|| {
                    format!(
                        "Failed to parse repaired accounts file after backing up {}",
                        backup_path.display()
                    )
                })?;
                fs::write(&path, repaired).with_context(|| {
                    format!("Failed to write repaired accounts file: {}", path.display())
                })?;
                store
            } else {
                return Err(parse_error)
                    .with_context(|| format!("Failed to parse accounts file: {}", path.display()));
            }
        }
    };

    migrate_store(&mut store);

    Ok(store)
}

/// Save the accounts store to disk
pub fn save_accounts(store: &AccountsStore) -> Result<()> {
    let path = get_accounts_file()?;
    let mut normalized = store.clone();
    migrate_store(&mut normalized);

    // Ensure the config directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory: {}", parent.display()))?;
    }

    let content =
        serde_json::to_string_pretty(&normalized).context("Failed to serialize accounts store")?;

    let temp_path = path.with_file_name(format!(
        ".accounts.json.tmp-{}",
        Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| Utc::now().timestamp_micros() * 1_000)
    ));

    fs::write(&temp_path, content).with_context(|| {
        format!(
            "Failed to write temporary accounts file: {}",
            temp_path.display()
        )
    })?;

    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("Failed to replace accounts file: {}", path.display()))?;
    }

    fs::rename(&temp_path, &path).with_context(|| {
        format!(
            "Failed to move temporary accounts file {} to {}",
            temp_path.display(),
            path.display()
        )
    })?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms)?;
    }

    Ok(())
}

fn repair_known_trailing_json_corruption(content: &str) -> Option<String> {
    let trimmed = content.trim_end();
    if !trimmed.ends_with("}]\n}") && !trimmed.ends_with("}]\r\n}") {
        return None;
    }

    let mut repaired = trimmed.to_string();
    let marker = "}]\n}";
    if let Some(index) = repaired.rfind(marker) {
        repaired.replace_range(index.., "}");
        return Some(repaired);
    }

    let marker = "}]\r\n}";
    if let Some(index) = repaired.rfind(marker) {
        repaired.replace_range(index.., "}");
        return Some(repaired);
    }

    None
}

fn migrate_store(store: &mut AccountsStore) {
    if store.version < ACCOUNTS_STORE_VERSION {
        store.version = ACCOUNTS_STORE_VERSION;
    }
}

/// Add a new account to the store
pub fn add_account(account: StoredAccount) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    // Check for duplicate names within the same provider
    if store
        .accounts
        .iter()
        .any(|a| a.provider == account.provider && a.name == account.name)
    {
        anyhow::bail!("An account with name '{}' already exists", account.name);
    }

    let account_clone = account.clone();
    store.accounts.push(account);

    match account_clone.provider {
        AccountProvider::Codex => {
            if store.active_account_id.is_none() {
                store.active_account_id = Some(account_clone.id.clone());
            }
        }
        AccountProvider::Claude => {
            if store.active_claude_account_id.is_none() {
                store.active_claude_account_id = Some(account_clone.id.clone());
            }
        }
    }

    save_accounts(&store)?;
    Ok(account_clone)
}

/// Remove an account by ID
pub fn remove_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    let initial_len = store.accounts.len();
    store.accounts.retain(|a| a.id != account_id);

    if store.accounts.len() == initial_len {
        anyhow::bail!("Account not found: {account_id}");
    }

    if store.active_account_id.as_deref() == Some(account_id) {
        store.active_account_id = store
            .accounts
            .iter()
            .find(|a| a.provider == AccountProvider::Codex)
            .map(|a| a.id.clone());
    }

    if store.active_claude_account_id.as_deref() == Some(account_id) {
        store.active_claude_account_id = store
            .accounts
            .iter()
            .find(|a| a.provider == AccountProvider::Claude)
            .map(|a| a.id.clone());
    }

    save_accounts(&store)?;
    Ok(())
}

/// Update the active account ID
pub fn set_active_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    if !store
        .accounts
        .iter()
        .any(|a| a.id == account_id && a.provider == AccountProvider::Codex)
    {
        anyhow::bail!("Account not found: {account_id}");
    }

    store.active_account_id = Some(account_id.to_string());
    save_accounts(&store)?;
    Ok(())
}

pub fn set_active_claude_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    if !store
        .accounts
        .iter()
        .any(|a| a.id == account_id && a.provider == AccountProvider::Claude)
    {
        anyhow::bail!("Claude account not found: {account_id}");
    }

    store.active_claude_account_id = Some(account_id.to_string());
    save_accounts(&store)?;
    Ok(())
}

/// Get an account by ID
pub fn get_account(account_id: &str) -> Result<Option<StoredAccount>> {
    let store = load_accounts()?;
    Ok(store.accounts.into_iter().find(|a| a.id == account_id))
}

/// Get the currently active account
pub fn get_active_account() -> Result<Option<StoredAccount>> {
    let store = load_accounts()?;
    let active_id = match &store.active_account_id {
        Some(id) => id,
        None => return Ok(None),
    };
    Ok(store.accounts.into_iter().find(|a| a.id == *active_id))
}

/// Update an account's last_used_at timestamp
pub fn touch_account(account_id: &str) -> Result<()> {
    let mut store = load_accounts()?;

    if let Some(account) = store.accounts.iter_mut().find(|a| a.id == account_id) {
        account.last_used_at = Some(chrono::Utc::now());
        save_accounts(&store)?;
    }

    Ok(())
}

/// Update an account's metadata (name, email, plan_type, subscription expiry)
pub fn update_account_metadata(
    account_id: &str,
    name: Option<String>,
    email: Option<String>,
    plan_type: Option<String>,
    subscription_expires_at: Option<Option<DateTime<Utc>>>,
) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    // Check for duplicate names within the same provider (if renaming)
    if let Some(ref new_name) = name {
        let provider = store
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.provider);
        if let Some(provider) = provider {
            if store
                .accounts
                .iter()
                .any(|a| a.id != account_id && a.provider == provider && a.name == *new_name)
            {
                anyhow::bail!("An account with name '{new_name}' already exists");
            }
        }
    }

    // Now find and update the account
    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .context("Account not found")?;

    if let Some(new_name) = name {
        account.name = new_name;
    }

    if email.is_some() {
        account.email = email;
    }

    if plan_type.is_some() {
        account.plan_type = plan_type;
    }

    if let Some(subscription_expires_at) = subscription_expires_at {
        account.subscription_expires_at = subscription_expires_at;
    }

    let updated = account.clone();
    save_accounts(&store)?;
    Ok(updated)
}

/// Update ChatGPT OAuth tokens for an account and return the updated account.
pub fn update_account_chatgpt_tokens(
    account_id: &str,
    id_token: String,
    access_token: String,
    refresh_token: String,
    chatgpt_account_id: Option<String>,
    email: Option<String>,
    plan_type: Option<String>,
    subscription_expires_at: Option<DateTime<Utc>>,
) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .context("Account not found")?;

    match &mut account.auth_data {
        AuthData::ChatGPT {
            id_token: stored_id_token,
            access_token: stored_access_token,
            refresh_token: stored_refresh_token,
            account_id: stored_account_id,
        } => {
            *stored_id_token = id_token;
            *stored_access_token = access_token;
            *stored_refresh_token = refresh_token;
            if let Some(new_account_id) = chatgpt_account_id {
                *stored_account_id = Some(new_account_id);
            }
        }
        AuthData::ApiKey { .. } | AuthData::ClaudeOAuth { .. } => {
            anyhow::bail!("Cannot update ChatGPT OAuth tokens for this account type");
        }
    }

    if let Some(new_email) = email {
        account.email = Some(new_email);
    }

    if let Some(new_plan_type) = plan_type {
        account.plan_type = Some(new_plan_type);
    }

    if let Some(subscription_expires_at) = subscription_expires_at {
        account.subscription_expires_at = Some(subscription_expires_at);
    }

    let updated = account.clone();
    save_accounts(&store)?;
    Ok(updated)
}

/// Persist the last successful usage snapshot for an account.
pub fn update_account_usage_cache(account_id: &str, usage: &UsageInfo) -> Result<StoredAccount> {
    let mut store = load_accounts()?;

    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .context("Account not found")?;

    let should_update = account.cached_usage.as_ref() != Some(usage);
    if should_update {
        account.cached_usage = Some(usage.clone());
        account.cached_usage_updated_at = Some(Utc::now());
        let updated = account.clone();
        save_accounts(&store)?;
        return Ok(updated);
    }

    Ok(account.clone())
}

/// Sync a Claude account's stored tokens from the current .credentials.json file.
/// Called right before switching away from an account — saves whatever Claude wrote
/// to the file (including a rotated refresh_token) so the next switch back works.
pub fn sync_claude_tokens_from_file(account_id: &str) -> Result<()> {
    use crate::auth::switcher::get_claude_credentials_file;
    use crate::types::ClaudeCredentialsFile;

    let creds_path = get_claude_credentials_file()?;
    if !creds_path.exists() {
        return Ok(());
    }

    let file_content = match fs::read_to_string(&creds_path) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let file_creds: ClaudeCredentialsFile = match serde_json::from_str(&file_content) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };

    let mut store = load_accounts()?;

    // Sync ALL token fields and metadata — Claude rotates refresh_token on every
    // access-token refresh. We know the file belongs to this account because it
    // is currently the active one (caller guarantees this).
    if let Some(account) = store.accounts.iter_mut().find(|a| a.id == account_id) {
        if account.sync_claude_credentials(&file_creds) {
            save_accounts(&store)?;
        }
    }

    Ok(())
}

/// Sync a Codex (ChatGPT) account's stored tokens from the current ~/.codex/auth.json.
/// Called right before switching away from an account so the stored copy stays fresh.
pub fn sync_codex_tokens_from_file(account_id: &str) -> Result<()> {
    use crate::auth::switcher::read_current_auth;

    let auth = match read_current_auth()? {
        Some(a) => a,
        None => return Ok(()),
    };
    let tokens = match auth.tokens {
        Some(t) => t,
        None => return Ok(()), // API-key account — nothing to sync
    };

    let mut store = load_accounts()?;
    let account = store.accounts.iter_mut().find(|a| a.id == account_id);

    if let Some(account) = account {
        if let AuthData::ChatGPT {
            id_token,
            access_token,
            refresh_token,
            account_id: stored_account_id,
        } = &mut account.auth_data
        {
            // Verify this is the same user before overwriting (match by refresh_token or account_id).
            let same_by_refresh = *refresh_token == tokens.refresh_token;
            let same_by_id = stored_account_id.is_some()
                && tokens.account_id.is_some()
                && *stored_account_id == tokens.account_id;

            if same_by_refresh || same_by_id {
                let changed = *id_token != tokens.id_token
                    || *access_token != tokens.access_token
                    || *refresh_token != tokens.refresh_token;

                if changed {
                    *id_token = tokens.id_token;
                    *access_token = tokens.access_token;
                    *refresh_token = tokens.refresh_token;
                    if stored_account_id.is_none() {
                        *stored_account_id = tokens.account_id;
                    }
                    save_accounts(&store)?;
                }
            }
        }
    }

    Ok(())
}

/// Get the list of masked account IDs
pub fn get_masked_account_ids() -> Result<Vec<String>> {
    let store = load_accounts()?;
    Ok(store.masked_account_ids.clone())
}

/// Set the list of masked account IDs
pub fn set_masked_account_ids(ids: Vec<String>) -> Result<()> {
    let mut store = load_accounts()?;
    store.masked_account_ids = ids;
    save_accounts(&store)?;
    Ok(())
}
