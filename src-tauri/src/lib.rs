//! Codex Switcher - Multi-account manager for Codex CLI

pub mod api;
pub mod auth;
pub mod commands;
pub mod types;
pub mod web;

use tauri::Manager;

use commands::{
    activate_claude_token_account, add_account_from_file, add_claude_account_from_active_session,
    add_claude_account_from_file, add_claude_token_account, cancel_login, check_claude_file_status,
    check_codex_file_status, check_codex_processes, clear_claude_active_session, complete_login,
    complete_reauth_login, add_codex_account_from_active_session,
    activate_gateway_account, add_gateway_account, create_claude_token_account,
    deactivate_claude_token, deactivate_gateway, delete_account, delete_claude_token_account,
    delete_gateway_account, export_accounts_full_encrypted_file, export_accounts_slim_text,
    get_active_account_info, get_claude_token_secret, get_gateway_key_secret,
    get_masked_account_ids, get_usage, import_accounts_full_encrypted_file,
    import_accounts_slim_text, list_accounts, list_claude_token_accounts, list_gateway_accounts,
    refresh_account_metadata, refresh_all_accounts_usage, refresh_tray_menu, rename_account,
    rename_claude_token_account, rename_gateway_account, set_masked_account_ids,
    set_tray_mode_enabled, setup_tray, start_login, switch_account,
    update_active_claude_account_from_file, warmup_account, warmup_all_accounts,
    list_zcode_accounts, capture_zcode_account, activate_zcode_account, delete_zcode_account,
    rename_zcode_account, import_zcode_account_from_file,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Tray mode hides the window instead of quitting, so clicking the
        // shortcut again used to start a second process — and a second tray
        // icon. Hand the launch to the instance already running instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Reconcile the Claude-auth environment with the selected state on
            // launch: if neither a gateway nor a CLI token is active, wipe any
            // stray override env var (a leftover ANTHROPIC_API_KEY from another
            // tool / shared folder, or vars left by a previous crash) so a regular
            // OAuth account isn't silently shadowed ("connectors disabled … takes
            // precedence"). Best-effort, off the UI thread.
            std::thread::spawn(|| {
                if let Ok(store) = crate::auth::load_accounts() {
                    if store.active_gateway_id.is_none()
                        && store.active_claude_token_id.is_none()
                    {
                        let _ = crate::commands::gateway::clear_claude_auth_overrides();
                    }
                }
            });

            #[cfg(desktop)]
            setup_tray(app)?;
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Account management
            list_accounts,
            get_active_account_info,
            add_account_from_file,
            add_claude_account_from_file,
            switch_account,
            delete_account,
            rename_account,
            export_accounts_slim_text,
            import_accounts_slim_text,
            export_accounts_full_encrypted_file,
            import_accounts_full_encrypted_file,
            // Masked accounts
            get_masked_account_ids,
            set_masked_account_ids,
            // Tray
            set_tray_mode_enabled,
            refresh_tray_menu,
            // OAuth
            start_login,
            complete_login,
            complete_reauth_login,
            cancel_login,
            // Usage
            get_usage,
            refresh_account_metadata,
            refresh_all_accounts_usage,
            warmup_account,
            warmup_all_accounts,
            // Process detection
            check_codex_processes,
            // Claude credentials reconciliation
            check_claude_file_status,
            check_codex_file_status,
            add_codex_account_from_active_session,
            add_claude_account_from_active_session,
            update_active_claude_account_from_file,
            clear_claude_active_session,
            // Claude CLI long-lived token accounts (setup-token)
            list_claude_token_accounts,
            add_claude_token_account,
            create_claude_token_account,
            rename_claude_token_account,
            delete_claude_token_account,
            activate_claude_token_account,
            deactivate_claude_token,
            get_claude_token_secret,
            // Anthropic-compatible gateway accounts (GLM via z.ai/OpenRouter)
            list_gateway_accounts,
            add_gateway_account,
            rename_gateway_account,
            delete_gateway_account,
            activate_gateway_account,
            deactivate_gateway,
            get_gateway_key_secret,
            // ZCode local sign-in snapshots
            list_zcode_accounts,
            capture_zcode_account,
            activate_zcode_account,
            delete_zcode_account,
            rename_zcode_account,
            import_zcode_account_from_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Take the tray icon down ourselves on the way out. Windows only
            // reaps an icon whose owner vanished when the shell next looks at
            // the notification area, which is why killed instances leave behind
            // ghosts that disappear one by one as the mouse passes over them.
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(tray) = app.tray_by_id("codex-switcher-tray") {
                    let _ = tray.set_visible(false);
                }
                app.remove_tray_by_id("codex-switcher-tray");
            }
        });
}
