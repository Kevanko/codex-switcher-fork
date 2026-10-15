use anyhow::{Context, Result};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use std::{fs, path::PathBuf, process::Command};
use uuid::Uuid;

use crate::auth::storage::{load_accounts, save_accounts};
use crate::types::{ZcodeAccount, ZcodeAccountInfo, ZcodeBalance, ZcodePlanEntry, ZcodePlanInfo};

fn zcode_dir() -> Result<PathBuf> { Ok(dirs::home_dir().context("Could not find home directory")?.join(".zcode").join("v2")) }
fn files() -> Result<(PathBuf, PathBuf)> { let dir = zcode_dir()?; Ok((dir.join("credentials.json"), dir.join("config.json"))) }
fn info(a: &ZcodeAccount, active: Option<&str>) -> ZcodeAccountInfo { ZcodeAccountInfo { id:a.id.clone(), name:a.name.clone(), is_active: active == Some(a.id.as_str()), created_at:a.created_at, plan:a.plan.clone(), entitlement: entitlement(&a.config_json).into() } }

/// Which Z.ai plan a snapshot holds, read from its own `config.json`.
///
/// ZCode writes the answer there when it signs in: the provider it may use is
/// left `enabled`, the others carry a `systemDisabledReason` such as
/// `coding_plan_not_entitled`. That makes this the one plan fact that is
/// per-account by construction — unlike ZCode's log, which pools every account
/// into one file and can only ever say what the live session holds.
///
/// ponytail: three states, not a tier. Lite/Pro/Max is shown only by a z.ai
/// webview, so nothing on disk distinguishes them; add that here if the desktop
/// app ever starts fetching it over an API it logs.
fn entitlement(config_json: &str) -> &'static str {
    let Ok(config) = serde_json::from_str::<serde_json::Value>(config_json) else { return "none" };
    let enabled = |id: &str| {
        config
            .pointer(&format!("/provider/builtin:{id}"))
            .is_some_and(|p| {
                p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
                    && p.get("systemDisabledReason").is_none()
            })
    };
    if enabled("zai-coding-plan") { "coding" } else if enabled("zai-start-plan") { "start" } else { "none" }
}

#[tauri::command]
pub async fn list_zcode_accounts() -> Result<Vec<ZcodeAccountInfo>, String> {
 let mut s=load_accounts().map_err(|e|e.to_string())?;
 let mut dirty=false;
 // Resolve the active badge from the actual on-disk ZCode session on every
 // launch, including profiles created by an earlier app version.
 if let Ok((credentials,config))=read_live_snapshot() {
   let detected=s.zcode_accounts.iter().find(|a|a.credentials_json==credentials && a.config_json==config).map(|a|a.id.clone());
   // A match is proof; the absence of one is not. ZCode rotates tokens inside
   // credentials.json while it runs, so the live files stop matching the
   // snapshot we activated within minutes — that must not clear the badge.
   if detected.is_some() && s.active_zcode_account_id != detected { s.active_zcode_account_id=detected; dirty=true; }
 }
 // Plans recorded before snapshots carried an activation time cannot be
 // attributed to an account, so they are dropped rather than trusted.
 for a in s.zcode_accounts.iter_mut() {
   if a.activated_at.is_none() && a.plan.is_some() { a.plan = None; dirty = true; }
 }
 // Plan and token balances only move for the account ZCode is actually signed
 // into, and only from log entries written since it went live.
 if let Some(active_id) = s.active_zcode_account_id.clone() {
   if let Some(active) = s.zcode_accounts.iter_mut().find(|a| a.id == active_id) {
     // A snapshot that predates activation stamps starts its window now: log
     // entries from here on are provably this account's, earlier ones are not.
     if active.activated_at.is_none() { active.activated_at = Some(Utc::now()); dirty = true; }
     if let Some(plan) = active.activated_at.and_then(read_live_plan) {
       active.plan = Some(plan);
       dirty = true;
     }
   }
 }
 if dirty { save_accounts(&s).map_err(|e|e.to_string())?; }
 Ok(s.zcode_accounts.iter().map(|a|info(a,s.active_zcode_account_id.as_deref())).collect())
}
#[tauri::command]
pub async fn capture_zcode_account(name:String) -> Result<ZcodeAccountInfo,String> {
 let name=name.trim().to_string(); if name.is_empty(){return Err("Account name is empty".into())}
 let (cred,config)=files().map_err(|e|e.to_string())?;
 let credentials_json=fs::read_to_string(&cred).with_context(||format!("ZCode credentials not found: {}",cred.display())).map_err(|e|e.to_string())?;
 let config_json=fs::read_to_string(&config).with_context(||format!("ZCode config not found: {}",config.display())).map_err(|e|e.to_string())?;
 serde_json::from_str::<serde_json::Value>(&credentials_json).context("ZCode credentials.json is invalid").map_err(|e|e.to_string())?;
 serde_json::from_str::<serde_json::Value>(&config_json).context("ZCode config.json is invalid").map_err(|e|e.to_string())?;
 let mut s=load_accounts().map_err(|e|e.to_string())?; if s.zcode_accounts.iter().any(|a|a.name.eq_ignore_ascii_case(&name)){return Err("An account with this name already exists".into())}
 let now=Utc::now();
 let a=ZcodeAccount{id:Uuid::new_v4().to_string(),name,credentials_json,config_json,created_at:now,plan:None,activated_at:Some(now)};
 // Capturing means "this is the sign-in I am on right now", so the new snapshot
 // becomes the active one. Without this the badge would depend on the live files
 // still matching byte for byte, which stops being true as ZCode rotates tokens.
 s.active_zcode_account_id=Some(a.id.clone());
 let out=info(&a,s.active_zcode_account_id.as_deref()); s.zcode_accounts.push(a); save_accounts(&s).map_err(|e|e.to_string())?; Ok(out)
}
#[tauri::command]
pub async fn activate_zcode_account(id:String) -> Result<(),String> {
 let mut s=load_accounts().map_err(|e|e.to_string())?;
 // Preserve tokens/config ZCode may have rotated since the last activation
 // before replacing the live files with another profile.
 if let Some(active_id)=s.active_zcode_account_id.as_deref() { if active_id != id { if let Ok((live_credentials,live_config))=read_live_snapshot() { if let Some(active)=s.zcode_accounts.iter_mut().find(|a|a.id==active_id) { active.credentials_json=live_credentials; active.config_json=live_config; active.plan=active.activated_at.and_then(read_live_plan).or_else(||active.plan.clone()); } } } }
 // The window reopens, but the grants recorded last time this account was
 // live are its own — keep them on screen until a fresh reading replaces them.
 if let Some(incoming)=s.zcode_accounts.iter_mut().find(|a|a.id==id) { incoming.activated_at=Some(Utc::now()); }
 let a=s.zcode_accounts.iter().find(|a|a.id==id).cloned().ok_or("ZCode account not found")?; let restart_target=zcode_executable(); close_zcode().map_err(|e|e.to_string())?;
 let (cred,config)=files().map_err(|e|e.to_string())?; let dir=cred.parent().ok_or("Invalid ZCode path")?; fs::create_dir_all(dir).map_err(|e|e.to_string())?;
 atomic_write(&cred,&a.credentials_json).map_err(|e|e.to_string())?; atomic_write(&config,&a.config_json).map_err(|e|e.to_string())?; s.active_zcode_account_id=Some(id); save_accounts(&s).map_err(|e|e.to_string())?; start_zcode(restart_target.as_deref()).map_err(|e|e.to_string())
}
fn read_live_snapshot() -> Result<(String,String)> { let (cred,config)=files()?; Ok((fs::read_to_string(cred)?,fs::read_to_string(config)?)) }
#[tauri::command]
pub async fn delete_zcode_account(id:String)->Result<(),String>{let mut s=load_accounts().map_err(|e|e.to_string())?;let n=s.zcode_accounts.len();s.zcode_accounts.retain(|a|a.id!=id);if n==s.zcode_accounts.len(){return Err("ZCode account not found".into())}if s.active_zcode_account_id.as_deref()==Some(id.as_str()){s.active_zcode_account_id=None}save_accounts(&s).map_err(|e|e.to_string())}
#[tauri::command]
pub async fn rename_zcode_account(id:String,name:String)->Result<(),String>{let mut s=load_accounts().map_err(|e|e.to_string())?;let name=name.trim().to_string();if name.is_empty(){return Err("Account name is empty".into())}let a=s.zcode_accounts.iter_mut().find(|a|a.id==id).ok_or("ZCode account not found")?;a.name=name;save_accounts(&s).map_err(|e|e.to_string())}
fn atomic_write(path:&std::path::Path,data:&str)->Result<()>{let tmp=path.with_extension("switcher.tmp");fs::write(&tmp,data)?;if path.exists(){fs::remove_file(path)?}fs::rename(tmp,path)?;Ok(())}
#[cfg(windows)] fn close_zcode()->Result<()>{let _=Command::new("taskkill").args(["/F","/T","/IM","ZCode.exe"]).status();std::thread::sleep(std::time::Duration::from_millis(700));Ok(())}
#[cfg(not(windows))] fn close_zcode()->Result<()>{Ok(())}
#[cfg(windows)] fn zcode_executable()->Option<String>{ let out=Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Path"]).output().ok()?;let path=String::from_utf8_lossy(&out.stdout).trim().to_string();(!path.is_empty()).then_some(path) }
#[cfg(not(windows))] fn zcode_executable()->Option<String>{None}
#[cfg(windows)] fn start_zcode(path:Option<&str>)->Result<()>{if let Some(path)=path.filter(|p|!p.trim().is_empty()){Command::new(path).spawn()?;}else{Command::new("cmd").args(["/c","start","","ZCode"]).spawn()?;}Ok(())}
#[cfg(not(windows))] fn start_zcode(_:Option<&str>)->Result<()>{Ok(())}

// ── Z.ai plan + token balances ───────────────────────────────────────────────
//
// ZCode asks https://zcode.z.ai/api/v1/zcode-plan/billing/balance for this and
// writes the parsed answer into its own daily log. We read that back rather than
// calling the API ourselves: the OAuth token lives in credentials.json, which
// ZCode encrypts with a device-bound key we deliberately never decrypt.
//
// ponytail: log scraping, keyed on the first field of the object ZCode logs.
// Anchoring on the URL instead would match the `"url"` field near the object's
// end and parse whatever came after it. Swap this for a direct billing call if
// that endpoint's query parameters ever get documented.
const BALANCE_LOG_MARKER: &str = "{\"balanceCount\"";

fn zcode_log_dir() -> Result<PathBuf> { Ok(zcode_dir()?.join("logs")) }

/// Newest ZCode log files first, capped at a few days so a long-idle install
/// does not make us read a hundred megabytes.
fn recent_zcode_logs() -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(zcode_log_dir()?)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
        .collect();
    // The names are ISO dates (2026-09-17.log), so lexical order is chronological.
    files.sort();
    files.reverse();
    files.truncate(3);
    Ok(files)
}

/// The JSON object that starts at `from`, respecting strings and escapes.
fn json_object_at(text: &str, from: usize) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = from + text[from..].find('{')?;
    let (mut depth, mut in_string, mut escaped) = (0i32, false, false);
    for index in start..bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped { escaped = false; }
            else if byte == b'\\' { escaped = true; }
            else if byte == b'"' { in_string = false; }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 { return text.get(start..=index); }
            }
            _ => {}
        }
    }
    None
}

/// The timestamp of the log line containing `idx`. ZCode prefixes every line
/// with `[YYYY-MM-DD HH:MM:SS.mmm]` in local time.
fn entry_time(text: &str, idx: usize) -> Option<DateTime<Local>> {
    let line_start = text[..idx].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let stamp = text.get(line_start..)?.strip_prefix('[')?.get(..23)?;
    let naive = NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S%.3f").ok()?;
    Local.from_local_datetime(&naive).single()
}

/// Newest non-empty balance response in one log, falling back to the newest
/// response of any kind so an account with genuinely no plan still reports that
/// rather than looking unread.
fn newest_balance_in(
    text: &str,
    since: DateTime<Local>,
) -> Option<(Vec<ZcodePlanEntry>, Vec<ZcodeBalance>)> {
    let mut search_end = text.len();
    let mut newest: Option<(Vec<ZcodePlanEntry>, Vec<ZcodeBalance>)> = None;

    for _ in 0..40 {
        let Some(start) = text[..search_end].rfind(BALANCE_LOG_MARKER) else { break };
        search_end = start;
        // Entries written before this snapshot went live belong to whoever was
        // signed in then. Reading past that point is how a parked account ended
        // up wearing another account's plan.
        match entry_time(text, start) {
            Some(at) if at >= since => {}
            Some(_) => break,
            None => continue,
        }
        let Some(raw) = json_object_at(text, start) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else { continue };

        let balances = value
            .get("balances")
            .or_else(|| value.pointer("/payload/data/balances"))
            .and_then(|v| serde_json::from_value::<Vec<ZcodeBalance>>(v.clone()).ok())
            .unwrap_or_default();
        let plans = value
            .pointer("/payload/data/plans")
            .and_then(|v| serde_json::from_value::<Vec<ZcodePlanEntry>>(v.clone()).ok())
            .unwrap_or_default();

        if !plans.is_empty() || !balances.is_empty() {
            return Some((plans, balances));
        }
        newest.get_or_insert((plans, balances));
    }

    newest
}

fn read_live_plan(since: DateTime<Utc>) -> Option<ZcodePlanInfo> {
    let since = since.with_timezone(&Local);
    for path in recent_zcode_logs().ok()? {
        let Ok(text) = fs::read_to_string(&path) else { continue };
        // Walk this log's balance responses newest-first and take the first that
        // actually carries plans. ZCode's most recent call is regularly empty
        // (a transient answer, or one made before the session settled), and
        // taking it at face value hid plans the account really holds.
        let Some((plans, balances)) = newest_balance_in(&text, since) else { continue };
        return Some(ZcodePlanInfo { plans, balances, captured_at: Some(Utc::now()) });
    }
    None
}

/// Import a snapshot from a `credentials.json` saved elsewhere (another
/// profile, a backup). `config.json` is taken from the same folder when it is
/// there; otherwise the live one is reused, which is enough because it holds
/// provider settings rather than the sign-in itself.
#[tauri::command]
pub async fn import_zcode_account_from_file(name: String, path: String) -> Result<ZcodeAccountInfo, String> {
    let name = name.trim().to_string();
    if name.is_empty() { return Err("Account name is empty".into()) }

    let credentials_path = PathBuf::from(&path);
    let credentials_json = fs::read_to_string(&credentials_path)
        .map_err(|e| format!("Could not read {}: {e}", credentials_path.display()))?;
    serde_json::from_str::<serde_json::Value>(&credentials_json)
        .map_err(|_| "That file is not valid JSON — pick ~/.zcode/v2/credentials.json".to_string())?;

    let sibling = credentials_path.with_file_name("config.json");
    let config_json = match fs::read_to_string(&sibling) {
        Ok(text) => text,
        Err(_) => {
            let (_, live_config) = files().map_err(|e| e.to_string())?;
            fs::read_to_string(&live_config)
                .map_err(|_| "No config.json next to that file and none in ~/.zcode/v2".to_string())?
        }
    };
    serde_json::from_str::<serde_json::Value>(&config_json)
        .map_err(|_| "config.json is not valid JSON".to_string())?;

    let mut store = load_accounts().map_err(|e| e.to_string())?;
    if store.zcode_accounts.iter().any(|a| a.name.eq_ignore_ascii_case(&name)) {
        return Err("An account with this name already exists".into());
    }
    let account = ZcodeAccount {
        id: Uuid::new_v4().to_string(),
        name,
        credentials_json,
        config_json,
        created_at: Utc::now(),
        // Imported snapshots have no local balance history to read.
        plan: None,
        activated_at: None,
    };
    let out = info(&account, store.active_zcode_account_id.as_deref());
    store.zcode_accounts.push(account);
    save_accounts(&store).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::entitlement;

    /// The three shapes ZCode writes, taken from real config.json snapshots.
    #[test]
    fn entitlement_reads_the_enabled_provider() {
        let coding = r#"{"provider":{"builtin:zai-coding-plan":{"enabled":true},
            "builtin:zai-start-plan":{"enabled":false,"systemDisabledReason":"coding_plan_not_entitled"}}}"#;
        let start = r#"{"provider":{"builtin:zai-coding-plan":{"enabled":false,"systemDisabledReason":"coding_plan_not_entitled"},
            "builtin:zai-start-plan":{"enabled":true}}}"#;
        let bare = r#"{"provider":{}}"#;

        assert_eq!(entitlement(coding), "coding");
        assert_eq!(entitlement(start), "start");
        assert_eq!(entitlement(bare), "none");
        assert_eq!(entitlement("not json"), "none");
    }
}
