//! System tray mode and quick account switching.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime, WindowEvent,
};

use crate::auth::load_accounts;
use crate::commands::account::switch_account;
use crate::types::{AccountProvider, StoredAccount, UsageInfo};

const TRAY_ID: &str = "codex-switcher-tray";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_REFRESH_ID: &str = "tray-refresh";
const TRAY_SWITCH_PREFIX: &str = "tray-switch:";

static TRAY_MODE_ENABLED: AtomicBool = AtomicBool::new(false);
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn set_tray_mode_enabled(enabled: bool) -> Result<(), String> {
    TRAY_MODE_ENABLED.store(enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn refresh_tray_menu(app: AppHandle) -> Result<(), String> {
    rebuild_tray_menu(&app).map_err(|error| error.to_string())
}

pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let menu = build_tray_menu(app.handle())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Codex Switcher")
        .on_menu_event(|app, event| {
            handle_tray_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;

    if let Some(window) = app.get_webview_window("main") {
        let window_to_hide = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if TRAY_MODE_ENABLED.load(Ordering::Relaxed) && !FORCE_QUIT.load(Ordering::Relaxed)
                {
                    api.prevent_close();
                    let _ = window_to_hide.hide();
                }
            }
        });
    }

    Ok(())
}

fn build_tray_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let mut builder = MenuBuilder::new(manager)
        .text(TRAY_OPEN_ID, "Открыть Codex Switcher")
        .text(TRAY_REFRESH_ID, "Обновить аккаунты")
        .separator();

    let store = load_accounts().ok();
    let active_id = store
        .as_ref()
        .and_then(|account_store| account_store.active_account_id.clone());
    let mut accounts = store
        .map(|account_store| account_store.accounts)
        .unwrap_or_default();

    let mut visible_accounts: Vec<_> = accounts
        .drain(..)
        .filter(|account| account.provider == AccountProvider::Codex)
        .filter_map(|account| {
            let remaining = effective_remaining_percent(&account)?;
            (remaining > 0).then_some((account, remaining))
        })
        .collect();

    visible_accounts.sort_by(|(a, a_remaining), (b, b_remaining)| {
        let a_active = active_id.as_deref() == Some(a.id.as_str());
        let b_active = active_id.as_deref() == Some(b.id.as_str());
        b_active
            .cmp(&a_active)
            .then_with(|| b_remaining.cmp(a_remaining))
            .then_with(|| b.last_used_at.cmp(&a.last_used_at))
            .then_with(|| a.name.cmp(&b.name))
    });

    if visible_accounts.is_empty() {
        builder = builder.item(&MenuItem::with_id(
            manager,
            "tray-empty",
            "Нет аккаунтов с лимитом",
            false,
            None::<&str>,
        )?);
    } else {
        for (account, remaining) in visible_accounts.into_iter().take(5) {
            let is_active = active_id.as_deref() == Some(account.id.as_str());
            let marker = if is_active { "* " } else { "" };
            let label = format!("{marker}{} - {remaining}%", account.name);
            builder = builder.text(format!("{TRAY_SWITCH_PREFIX}{}", account.id), label);
        }
    }

    builder.separator().text(TRAY_QUIT_ID, "Выход").build()
}

fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_tray_menu(app)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn handle_tray_menu_event(app: &AppHandle, id: &str) {
    match id {
        TRAY_OPEN_ID => {
            let _ = show_main_window(app);
        }
        TRAY_REFRESH_ID => {
            let _ = rebuild_tray_menu(app);
        }
        TRAY_QUIT_ID => {
            FORCE_QUIT.store(true, Ordering::Relaxed);
            app.exit(0);
        }
        id if id.starts_with(TRAY_SWITCH_PREFIX) => {
            let account_id = id.trim_start_matches(TRAY_SWITCH_PREFIX).to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if switch_account(account_id).await.is_ok() {
                    let _ = rebuild_tray_menu(&app);
                    let _ = app.emit("accounts-changed", ());
                    let _ = show_main_window(&app);
                }
            });
        }
        _ => {}
    }
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    }
    Ok(())
}

fn effective_remaining_percent(account: &StoredAccount) -> Option<i64> {
    let usage = account.cached_usage.as_ref()?;
    if usage.error.is_some() || has_no_credits(usage) {
        return None;
    }

    let mut remaining_windows = Vec::new();
    let is_premium = is_premium_plan(account.plan_type.as_deref().or(usage.plan_type.as_deref()));

    if is_premium {
        if let Some(used) = usage.primary_used_percent {
            remaining_windows.push(remaining_from_used(used));
        }
    }

    if let Some(used) = usage.secondary_used_percent {
        remaining_windows.push(remaining_from_used(used));
    } else if !is_premium {
        if let Some(used) = usage.primary_used_percent {
            remaining_windows.push(remaining_from_used(used));
        }
    }

    remaining_windows.into_iter().min()
}

fn remaining_from_used(used_percent: f64) -> i64 {
    (100.0 - used_percent).clamp(0.0, 100.0).round() as i64
}

fn has_no_credits(usage: &UsageInfo) -> bool {
    usage.has_credits == Some(false) && usage.unlimited_credits != Some(true)
}

fn is_premium_plan(plan: Option<&str>) -> bool {
    let normalized = plan.unwrap_or_default().trim().to_lowercase();
    normalized.contains("plus") || normalized.contains("pro") || normalized.contains("team")
}
