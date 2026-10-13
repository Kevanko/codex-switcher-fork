// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux_gtk;

fn main() {
    // appmenu-gtk-module overflows the stack while WebKitGTK starts (upstream
    // Lampese#176). Drop just that module, before Tauri touches GTK.
    #[cfg(target_os = "linux")]
    for variable in ["GTK_MODULES", "GTK3_MODULES"] {
        if let Some(filtered) = std::env::var_os(variable)
            .as_deref()
            .and_then(linux_gtk::without_appmenu_module)
        {
            std::env::set_var(variable, filtered);
        }
    }

    codex_switcher_lib::run()
}
