//! Snapshots of accounts.json. A restore first snapshots the current file, so the restore itself
//! can be undone. Codex's own state is not part of a snapshot.
//! Snapshots hold tokens and saved passwords in plain text, like accounts.json itself.

use crate::auth::{get_config_dir, with_store};
use crate::types::AccountsStore;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

const KEEP: usize = 30;
const ACCOUNTS: &str = "accounts.json";
const MANIFEST: &str = "manifest.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created: String,
    pub reason: String,
    pub accounts: usize,
    #[serde(default)]
    pub bound_accounts: Option<usize>,
}

fn root() -> Result<PathBuf> {
    #[cfg(test)]
    if std::env::var_os("CODEX_SWITCHER_HOME").is_some() {
        return Ok(get_config_dir()?.join("backups"));
    }
    Ok(dirs::data_local_dir()
        .context("Не найдена папка данных пользователя")?
        .join("com.lampese.codex-switcher")
        .join("account-backups"))
}

fn slug(reason: &str) -> String {
    reason
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn create(reason: &str) -> Result<BackupInfo> {
    with_store(|store| Ok((snapshot(store, reason, None)?, false)))
}

pub(crate) fn snapshot_on_startup() -> Result<()> {
    with_store(|store| {
        if !store.accounts.is_empty()
            || !store.claude_token_accounts.is_empty()
            || !store.gateway_accounts.is_empty()
            || !store.zcode_accounts.is_empty()
        {
            checkpoint(store, "automatic")?;
        }
        Ok(((), false))
    })
}

pub(crate) fn checkpoint(store: &AccountsStore, reason: &str) -> Result<()> {
    let base = root()?;
    let bytes = serde_json::to_vec_pretty(store)?;
    if ids(&base)?.iter().any(|id| {
        id.ends_with(&format!("-{reason}"))
            && fs::read(base.join(id).join(ACCOUNTS)).ok().as_deref() == Some(bytes.as_slice())
    }) {
        return Ok(());
    }
    snapshot(store, reason, None)?;
    Ok(())
}

pub(crate) fn bindings(store: &AccountsStore) -> std::collections::BTreeMap<String, Value> {
    store
        .accounts
        .iter()
        .filter_map(|account| {
            let fields: serde_json::Map<String, Value> = SHARE_BINDINGS
                .iter()
                .filter_map(|key| {
                    account
                        .extra
                        .get(*key)
                        .map(|value| (key.to_string(), value.clone()))
                })
                .collect();
            (!fields.is_empty()).then(|| (account.id.clone(), Value::Object(fields)))
        })
        .collect()
}

pub(crate) const SHARE_BINDINGS: &[&str] = &["mail_login", "login_password", "totp_secret"];

pub(crate) fn snapshot(
    store: &AccountsStore,
    reason: &str,
    protect: Option<&str>,
) -> Result<BackupInfo> {
    use std::io::Write;

    let now = chrono::Local::now();
    let id = format!(
        "{}-{}-{}",
        now.format("%Y%m%d-%H%M%S-%3f"),
        uuid::Uuid::new_v4(),
        slug(reason)
    );
    let base = root()?;
    fs::create_dir_all(&base)?;
    let staging = tempfile::Builder::new()
        .prefix(".pending-")
        .tempdir_in(&base)?;
    let mut data = tempfile::NamedTempFile::new_in(staging.path())?;
    data.write_all(&serde_json::to_vec_pretty(store)?)?;
    data.as_file().sync_all()?;
    data.persist(staging.path().join(ACCOUNTS))?;
    let info = BackupInfo {
        id: id.clone(),
        created: now.format("%d.%m.%Y %H:%M:%S").to_string(),
        reason: reason.to_owned(),
        bound_accounts: Some(bindings(store).len()),
        accounts: store.accounts.len()
            + store.claude_token_accounts.len()
            + store.gateway_accounts.len()
            + store.zcode_accounts.len(),
    };
    fs::write(
        staging.path().join(MANIFEST),
        serde_json::to_vec_pretty(&info)?,
    )?;
    fs::rename(staging.path(), base.join(&id))?;
    prune(protect)?;
    Ok(info)
}

fn prune(protect: Option<&str>) -> Result<()> {
    let base = root()?;
    let all = ids(&base)?;
    for automatic in [true, false] {
        for old in all
            .iter()
            .filter(|id| id.ends_with("-automatic") == automatic)
            .skip(KEEP)
            .filter(|old| Some(old.as_str()) != protect)
        {
            let _ = fs::remove_dir_all(base.join(old));
        }
    }
    Ok(())
}

/// Snapshot folder names, newest first. Names start with a timestamp, so sorting them works.
fn ids(base: &Path) -> Result<Vec<String>> {
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut ids: Vec<String> = fs::read_dir(base)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            !entry.file_name().to_string_lossy().starts_with('.')
                && entry.path().join(MANIFEST).is_file()
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    Ok(ids)
}

pub(crate) fn list() -> Result<Vec<BackupInfo>> {
    let base = root()?;
    let legacy = get_config_dir()?.join("backups");
    let mut out = Vec::new();
    for path in std::iter::once(&base).chain((legacy != base).then_some(&legacy)) {
        for id in ids(path)? {
            let Ok(bytes) = fs::read(path.join(&id).join(MANIFEST)) else {
                continue;
            };
            if let Ok(mut info) = serde_json::from_slice::<BackupInfo>(&bytes) {
                info.id = id;
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// The folder of a snapshot. Only names this module created are accepted, so nothing else can be
/// read or deleted through an id.
fn folder(id: &str) -> Result<PathBuf> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        bail!("Неверный бэкап");
    }
    for base in [root()?, get_config_dir()?.join("backups")] {
        let dir = base.join(id);
        if dir.join(MANIFEST).is_file() {
            return Ok(dir);
        }
    }
    bail!("Бэкап не найден")
}

/// Removes one snapshot. The current accounts are not touched.
pub(crate) fn delete(id: &str) -> Result<()> {
    fs::remove_dir_all(folder(id)?).context("Не смог удалить бэкап")
}

/// Merges the snapshot's accounts back. Codex is not touched.
///
/// Accounts missing from the current list are added. An account present in both keeps its
/// current tokens, usage and extra fields (they may have been refreshed since the snapshot);
/// only fields it lacks are filled from the snapshot. The active accounts are not changed.
pub(crate) fn restore(id: &str) -> Result<()> {
    let bytes = fs::read(folder(id)?.join(ACCOUNTS)).context("В бэкапе нет accounts.json")?;
    let restored: AccountsStore =
        serde_json::from_slice(&bytes).context("Бэкап повреждён: accounts.json не читается")?;
    with_store(|store| {
        // Keep the accounts we are about to change, so the restore itself can be undone.
        snapshot(store, "before-restore", Some(id))?;
        Ok(((), merge(store, restored)))
    })
}

/// Adds the snapshot's accounts to `store` (current values win). Returns whether it changed.
pub(crate) fn merge(store: &mut AccountsStore, restored: AccountsStore) -> bool {
    let mut changed = false;
    for old in restored.accounts {
        let Some(current) = store
            .accounts
            .iter_mut()
            .find(|a| a.id == old.id && a.provider == old.provider)
        else {
            if store.accounts.iter().any(|a| a.id == old.id) {
                continue;
            }
            let mut old = old;
            if store
                .accounts
                .iter()
                .any(|a| a.provider == old.provider && a.name == old.name)
            {
                let base = old.name.clone();
                old.name = (2..)
                    .map(|i| format!("{base} ({i})"))
                    .find(|name| {
                        !store
                            .accounts
                            .iter()
                            .any(|a| a.provider == old.provider && &a.name == name)
                    })
                    .expect("available account name");
            }
            store.accounts.push(old);
            changed = true;
            continue;
        };
        macro_rules! fill {
            ($($field:ident),*) => {$(
                if current.$field.is_none() && old.$field.is_some() {
                    current.$field = old.$field;
                    changed = true;
                }
            )*};
        }
        fill!(email, plan_type, subscription_expires_at, last_used_at);
        for (key, value) in old.extra {
            if current.extra.get(&key).is_none_or(Value::is_null) {
                current.extra.insert(key, value);
                changed = true;
            }
        }
    }
    macro_rules! merge_profiles {
        ($($field:ident),*) => {$(
            for profile in restored.$field {
                if !store.$field.iter().any(|current| current.id == profile.id) {
                    store.$field.push(profile);
                    changed = true;
                }
            }
        )*};
    }
    merge_profiles!(claude_token_accounts, gateway_accounts, zcode_accounts);
    for id in restored.masked_account_ids {
        if !store.masked_account_ids.contains(&id) {
            store.masked_account_ids.push(id);
            changed = true;
        }
    }
    for (key, value) in restored.extra {
        if let serde_json::map::Entry::Vacant(entry) = store.extra.entry(key) {
            entry.insert(value);
            changed = true;
        }
    }
    changed
}

#[tauri::command]
pub(crate) async fn list_backups() -> Result<Vec<BackupInfo>, String> {
    list().map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub(crate) async fn create_backup() -> Result<Vec<BackupInfo>, String> {
    create("manual").map_err(|error| format!("{error:#}"))?;
    list().map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub(crate) async fn restore_backup(id: String) -> Result<Vec<BackupInfo>, String> {
    restore(&id).map_err(|error| format!("{error:#}"))?;
    list().map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub(crate) async fn delete_backup(id: String) -> Result<Vec<BackupInfo>, String> {
    delete(&id).map_err(|error| format!("{error:#}"))?;
    list().map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Points CODEX_SWITCHER_HOME at a fixture and puts it back when the test ends, even on panic.
    struct HomeGuard(Option<std::ffi::OsString>);
    impl HomeGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::var_os("CODEX_SWITCHER_HOME");
            std::env::set_var("CODEX_SWITCHER_HOME", path);
            Self(previous)
        }
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("CODEX_SWITCHER_HOME", value),
                None => std::env::remove_var("CODEX_SWITCHER_HOME"),
            }
        }
    }

    fn account(id: &str, key: &str) -> Value {
        json!({
            "id": id, "name": id, "email": null, "plan_type": null,
            "auth_mode": "api_key", "auth_data": {"type": "api_key", "key": key},
            "created_at": "2026-11-12T00:00:00Z"
        })
    }

    #[test]
    fn restore_merges_a_snapshot_without_overwriting_fresh_accounts() -> Result<()> {
        // A temporary data folder: the real accounts file is never touched.
        let _env = crate::TEST_ENV
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let fixture = tempfile::tempdir()?;
        let _home = HomeGuard::set(fixture.path());
        let mut old = account("acc-1", "sk-old");
        old["email"] = json!("a@example.com");
        old["totp_secret"] = json!("GEZDGNBV");
        old["mail_login"] = json!({"address": "mail@example.com", "password": "fixture-mail"});
        old["login_password"] = json!("fixture-login");
        let store = json!({"version": 1, "accounts": [old, account("acc-2", "sk-2")], "active_account_id": "acc-2"});
        fs::write(fixture.path().join(ACCOUNTS), serde_json::to_vec(&store)?)?;

        let info = create("test")?;
        assert_eq!(info.accounts, 2);
        // Since the snapshot: acc-1 got a fresh key, acc-2 was removed, acc-3 added and made active.
        let now = json!({"version": 1, "accounts": [account("acc-1", "sk-new"), account("acc-3", "sk-3")], "active_account_id": "acc-3"});
        fs::write(fixture.path().join(ACCOUNTS), serde_json::to_vec(&now)?)?;

        restore(&info.id)?;
        let merged = crate::auth::load_accounts()?;
        let ids: Vec<&str> = merged.accounts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["acc-1", "acc-3", "acc-2"]);
        let acc1 = &merged.accounts[0];
        assert!(
            serde_json::to_string(&acc1.auth_data)?.contains("sk-new"),
            "current token wins"
        );
        assert_eq!(
            acc1.email.as_deref(),
            Some("a@example.com"),
            "a missing field is filled"
        );
        assert_eq!(acc1.extra["totp_secret"], "GEZDGNBV");
        assert_eq!(acc1.extra["mail_login"]["password"], "fixture-mail");
        assert_eq!(acc1.extra["login_password"], "fixture-login");
        assert_eq!(merged.active_account_id.as_deref(), Some("acc-3"));

        let backups = list()?;
        assert!(backups.iter().any(|item| item.id == info.id));
        assert!(backups.iter().any(|item| item.reason == "before-restore"));
        assert!(restore("../escape").is_err());

        // A broken manifest hides only its own snapshot.
        let broken = root()?.join("19990101-000000-000-broken");
        fs::create_dir_all(&broken)?;
        fs::write(broken.join(MANIFEST), b"not json")?;
        assert_eq!(list()?.len(), backups.len());
        Ok(())
    }

    #[tokio::test]
    async fn copied_account_imports_with_only_the_selected_credentials() -> Result<()> {
        use crate::commands::{export_account_json, import_account_json};

        let _env = crate::TEST_ENV
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let source = tempfile::tempdir()?;
        let _home = HomeGuard::set(source.path());
        let account = json!({
            "id": "fixture", "name": "Fixture", "provider": "claude", "auth_mode": "claude_oauth",
            "auth_data": {
                "type": "claude_oauth", "access_token": "fixture-access",
                "refresh_token": "fixture-refresh", "expires_at": 1790000000000_i64
            },
            "created_at": "2026-11-12T00:00:00Z",
            "mail_login": {"address": "a@example.com", "password": "fixture-mail"},
            "login_password": "fixture-login",
            "totp_secret": "GEZDGNBV",
            "local_setting": "fixture-local"
        });
        fs::write(
            source.path().join(ACCOUNTS),
            serde_json::to_vec(&json!({"accounts": [account]}))?,
        )?;
        let with_bindings = export_account_json("fixture".into(), Some(true))
            .await
            .map_err(anyhow::Error::msg)?;
        let sign_in_only = export_account_json("fixture".into(), Some(false))
            .await
            .map_err(anyhow::Error::msg)?;

        let destination = tempfile::tempdir()?;
        let _receiver = HomeGuard::set(destination.path());
        import_account_json(with_bindings, None)
            .await
            .map_err(anyhow::Error::msg)?;
        import_account_json(sign_in_only, None)
            .await
            .map_err(anyhow::Error::msg)?;
        let restored = crate::auth::load_accounts()?;
        assert_eq!(
            restored.accounts[0].extra["mail_login"]["password"],
            "fixture-mail"
        );
        assert_eq!(
            restored.accounts[0].extra["login_password"],
            "fixture-login"
        );
        assert_eq!(restored.accounts[0].extra["totp_secret"], "GEZDGNBV");
        assert!(!restored.accounts[0].extra.contains_key("local_setting"));
        assert!(restored.accounts[1].extra.is_empty());
        assert!(list()?
            .iter()
            .any(|backup| backup.reason == "automatic" && backup.bound_accounts == Some(1)));
        Ok(())
    }

    #[test]
    fn prune_keeps_the_snapshot_being_restored() -> Result<()> {
        let _env = crate::TEST_ENV
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let fixture = tempfile::tempdir()?;
        let _home = HomeGuard::set(fixture.path());
        let empty = br#"{"version":1,"accounts":[],"active_account_id":null}"#;
        fs::write(fixture.path().join(ACCOUNTS), empty)?;
        for n in 0..KEEP {
            let dir = root()?.join(format!("20000101-000000-{n:03}-old"));
            fs::create_dir_all(&dir)?;
            fs::write(dir.join(MANIFEST), b"{}")?;
            fs::write(dir.join(ACCOUNTS), empty)?;
        }
        let oldest = "20000101-000000-000-old";
        restore(oldest)?;
        assert!(root()?.join(oldest).is_dir());
        assert_eq!(ids(&root()?)?.len(), KEEP + 1);
        Ok(())
    }
}
