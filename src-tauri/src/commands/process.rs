//! Process detection commands

use std::process::Command;

#[cfg(windows)]
use anyhow::Context;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsCodexProcess {
    name: String,
    process_id: u32,
    #[serde(default)]
    executable_path: String,
    #[serde(default)]
    command_line: String,
}

#[derive(Debug, Clone)]
pub struct CodexRestartTarget {
    pub executable_path: Option<String>,
    pub app_user_model_id: Option<String>,
}

/// Information about running Codex processes
#[derive(Debug, Clone, serde::Serialize)]
pub struct CodexProcessInfo {
    /// Number of active Codex app instances
    pub count: usize,
    /// Number of ignored background/stale Codex-related processes
    pub background_count: usize,
    /// Whether switching is allowed (no active Codex app instances)
    pub can_switch: bool,
    /// Process IDs of active Codex app instances
    pub pids: Vec<u32>,
}

/// Check for running Codex processes
#[tauri::command]
pub async fn check_codex_processes() -> Result<CodexProcessInfo, String> {
    let (pids, bg_count) = find_codex_processes().map_err(|e| e.to_string())?;
    let count = pids.len();

    Ok(CodexProcessInfo {
        count,
        background_count: bg_count,
        can_switch: count == 0,
        pids,
    })
}

/// Find all running codex processes. Returns (active_pids, background_count)
fn find_codex_processes() -> anyhow::Result<(Vec<u32>, usize)> {
    #[cfg(unix)]
    {
        let mut pids = Vec::new();
        let mut bg_count = 0;

        // Include TTY so we can distinguish interactive CLI sessions from
        // background helper processes such as lingering app-server instances.
        let output = Command::new("ps")
            .args(["-axo", "pid=,tty=,command="])
            .output();

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                let mut parts = line.split_whitespace();
                let Some(pid_str) = parts.next() else {
                    continue;
                };
                let Some(tty) = parts.next() else {
                    continue;
                };
                let command = parts.collect::<Vec<_>>().join(" ");
                if command.is_empty() {
                    continue;
                }

                let lowercase_command = command.to_ascii_lowercase();
                let is_switcher = lowercase_command.contains("codex-switcher");

                if is_switcher {
                    continue;
                }

                // macOS app bundle paths can contain spaces (`Codex Helper.app`), so
                // splitting on whitespace can turn helper processes into false
                // positives for the main `Codex` app. Detect by full command shape
                // instead of relying on the first token.
                let first_token = command.split_whitespace().next().unwrap_or("");
                let is_codex_cli = first_token == "codex" || first_token.ends_with("/codex");
                let is_codex_desktop = command.contains(".app/Contents/MacOS/Codex")
                    && !command.contains("Codex Helper")
                    && !command.contains("CodexBar");

                if !is_codex_cli && !is_codex_desktop {
                    continue;
                }

                let Ok(pid) = pid_str.parse::<u32>() else {
                    continue;
                };

                if pid == std::process::id() || pids.contains(&pid) {
                    continue;
                }

                let is_ide_plugin = is_ide_plugin_process(&lowercase_command);
                let is_app_server = lowercase_command.contains("codex app-server");
                let has_tty = tty != "??" && tty != "?";

                if is_ide_plugin || is_app_server {
                    bg_count += 1;
                    continue;
                }

                if is_codex_desktop || has_tty {
                    pids.push(pid);
                } else {
                    // Headless or orphaned codex processes should not block switching.
                    bg_count += 1;
                }
            }
        }

        pids.sort_unstable();
        pids.dedup();

        return Ok((pids, bg_count));
    }

    #[cfg(windows)]
    {
        return find_windows_codex_processes();
    }

    #[allow(unreachable_code)]
    Ok((Vec::new(), 0))
}

pub fn snapshot_restart_target() -> anyhow::Result<(Vec<u32>, Option<CodexRestartTarget>)> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-axo", "pid=,tty=,command="])
            .output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut active_pids = Vec::new();
        let mut restart_target = None;

        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let mut parts = line.split_whitespace();
            let Some(pid_str) = parts.next() else {
                continue;
            };
            let Some(tty) = parts.next() else {
                continue;
            };
            let command = parts.collect::<Vec<_>>().join(" ");
            let lowercase_command = command.to_ascii_lowercase();
            if lowercase_command.contains("codex-switcher") {
                continue;
            }

            let first_token = command.split_whitespace().next().unwrap_or("");
            let is_codex_cli = first_token == "codex" || first_token.ends_with("/codex");
            let is_codex_desktop = command.contains(".app/Contents/MacOS/Codex")
                && !command.contains("Codex Helper")
                && !command.contains("CodexBar");
            if !is_codex_cli && !is_codex_desktop {
                continue;
            }

            let Ok(pid) = pid_str.parse::<u32>() else {
                continue;
            };
            if pid == std::process::id() {
                continue;
            }

            let is_ide_plugin = is_ide_plugin_process(&lowercase_command);
            let is_app_server = lowercase_command.contains("codex app-server");
            let has_tty = tty != "??" && tty != "?";

            if is_ide_plugin || is_app_server {
                continue;
            }

            if is_codex_desktop || has_tty {
                active_pids.push(pid);
                if restart_target.is_none() {
                    restart_target = Some(CodexRestartTarget {
                        executable_path: Some(first_token.to_string()),
                        app_user_model_id: None,
                    });
                }
            }
        }

        active_pids.sort_unstable();
        active_pids.dedup();
        return Ok((active_pids, restart_target));
    }

    #[cfg(windows)]
    {
        let processes = query_windows_codex_processes()?;
        // Same predicate as check_codex_processes. The two used to disagree:
        // the detector counted every Codex root, this one only counted roots
        // with a window/renderer/app-server child. A headless Codex CLI was
        // therefore reported as running but never terminated or restarted.
        let (active_roots, _) = windows_active_codex_roots(&processes);
        let restart_target = active_roots.first().map(|process| CodexRestartTarget {
            executable_path: (!process.executable_path.trim().is_empty())
                .then(|| process.executable_path.clone()),
            app_user_model_id: get_windows_codex_app_user_model_id(process),
        });
        let mut active_pids = active_roots
            .into_iter()
            .map(|process| process.process_id)
            .collect::<Vec<_>>();
        active_pids.sort_unstable();
        active_pids.dedup();
        return Ok((active_pids, restart_target));
    }

    #[allow(unreachable_code)]
    Ok((Vec::new(), None))
}

pub fn terminate_codex_processes(pids: &[u32]) -> anyhow::Result<()> {
    for pid in pids {
        #[cfg(unix)]
        {
            let status = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status()?;
            if !status.success() {
                anyhow::bail!("Failed to terminate Codex process {pid}");
            }
        }

        #[cfg(windows)]
        {
            let status = Command::new("taskkill")
                .creation_flags(CREATE_NO_WINDOW)
                // Electron's renderer and utility children otherwise survive
                // their root and can keep the old account session alive.
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .status()?;
            if !status.success() {
                anyhow::bail!("Failed to terminate Codex process {pid}");
            }
        }
    }

    // taskkill/kill return before the process tree has finished tearing down, and
    // restarting into a dying instance makes the new Codex bail on the
    // single-instance lock (or read a half-written auth.json).
    // ponytail: fixed settle delay; poll the pid list instead if it ever proves short.
    if !pids.is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(800));
    }

    Ok(())
}

pub fn restart_codex_process(target: Option<&CodexRestartTarget>) -> anyhow::Result<bool> {
    #[cfg(unix)]
    {
        let executable = target
            .and_then(|target| target.executable_path.as_ref())
            .filter(|path| !path.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| "codex".to_string());
        Command::new(executable).spawn()?;
        return Ok(true);
    }

    #[cfg(windows)]
    {
        if let Some(app_id) = target
            .and_then(|target| target.app_user_model_id.as_ref())
            .filter(|app_id| !app_id.trim().is_empty())
        {
            if Command::new("explorer.exe")
                .arg(format!("shell:AppsFolder\\{app_id}"))
                .spawn()
                .is_ok()
            {
                return Ok(true);
            }
        }

        if let Some(executable) = target
            .and_then(|target| target.executable_path.as_ref())
            .filter(|path| !path.trim().is_empty())
        {
            Command::new("powershell.exe")
                .creation_flags(CREATE_NO_WINDOW)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!(
                        "Start-Process -FilePath '{}'",
                        executable.replace("'", "''")
                    ),
                ])
                .spawn()?;
            return Ok(true);
        }

        if let Some(app_id) = find_windows_codex_app_user_model_id()? {
            if Command::new("explorer.exe")
                .arg(format!("shell:AppsFolder\\{app_id}"))
                .spawn()
                .is_ok()
            {
                return Ok(true);
            }
        }

        if Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/c", "start", "", "codex"])
            .spawn()
            .is_ok()
        {
            return Ok(true);
        }

        return Ok(false);
    }

    #[allow(unreachable_code)]
    Ok(false)
}

/// Single source of truth for "which Codex processes are live right now",
/// shared by the detector and by the switch/terminate/restart path.
///
/// A window-less Codex root is still a live instance — a headless CLI in a
/// terminal, a tray-minimized desktop app, an Electron restart in flight — so
/// every root counts. Only IDE-plugin trees are ignored.
#[cfg(windows)]
fn windows_active_codex_roots(
    processes: &[WindowsCodexProcess],
) -> (Vec<WindowsCodexProcess>, usize) {
    let mut active = Vec::new();
    let mut ignored = 0;

    for process in processes
        .iter()
        .filter(|process| is_windows_codex_root_process(process))
    {
        if is_ide_plugin_process(&process.command_line.to_ascii_lowercase()) {
            ignored += 1;
            continue;
        }
        active.push(process.clone());
    }

    // Desktop roots first: relaunching the packaged app by its AppUserModelId is
    // silent, while relaunching a CLI opens a console window. Ordering here is
    // what `snapshot_restart_target` reads as "the" restart target.
    active.sort_by_key(|process| {
        (
            !is_windows_codex_desktop_process(process),
            process.process_id,
        )
    });
    (active, ignored)
}

#[cfg(windows)]
fn find_windows_codex_processes() -> anyhow::Result<(Vec<u32>, usize)> {
    let processes = query_windows_codex_processes()?;
    let (active_roots, ignored_count) = windows_active_codex_roots(&processes);
    let mut active_pids = active_roots
        .into_iter()
        .map(|process| process.process_id)
        .collect::<Vec<_>>();
    active_pids.dedup();

    Ok((active_pids, ignored_count))
}

#[cfg(windows)]
fn query_windows_codex_processes() -> anyhow::Result<Vec<WindowsCodexProcess>> {
    const POWERSHELL_SCRIPT: &str = r#"
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq 'codex.exe' -or $_.Name -ieq 'ChatGPT.exe' } |
  ForEach-Object {
    [PSCustomObject]@{
      Name = $_.Name
      ProcessId = [uint32]$_.ProcessId
      ExecutablePath = if ($_.ExecutablePath) { $_.ExecutablePath } else { '' }
      CommandLine = if ($_.CommandLine) { $_.CommandLine } else { '' }
    }
  } |
  ConvertTo-Json -Compress
"#;

    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            POWERSHELL_SCRIPT,
        ])
        .output()
        .context("failed to query Windows process list")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("PowerShell process query failed: {}", stderr.trim());
    }

    query_windows_codex_processes_from_output(&output.stdout)
}

#[cfg(windows)]
fn query_windows_codex_processes_from_output(
    stdout: &[u8],
) -> anyhow::Result<Vec<WindowsCodexProcess>> {
    let stdout = String::from_utf8_lossy(stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value =
        serde_json::from_str(trimmed).context("failed to parse Windows process JSON")?;

    match value {
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value)
                    .context("failed to deserialize Windows Codex process entry")
            })
            .collect(),
        value => Ok(vec![serde_json::from_value(value)
            .context("failed to deserialize Windows Codex process entry")?]),
    }
}

#[cfg(windows)]
/// True for a process that owns a Codex session, as opposed to one of its
/// children.
///
/// Two shapes exist on Windows and they look nothing alike:
///
/// * the **desktop app** — an MSIX package whose main process is `ChatGPT.exe`
///   under `...\OpenAI.Codex_<version>__<publisher>\app\`. Electron's renderer
///   and utility children carry `--type=`, so only the main process survives
///   this filter. Older unpackaged builds shipped it as `Codex.exe`.
/// * the **CLI** — a bare `codex.exe` in a terminal.
///
/// Everything the desktop app spawns to do the actual work is skipped: it runs
/// `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe ... app-server`, which is named
/// `codex.exe` and has no `--type=`. Treating that core as a root is what made
/// switching relaunch it directly and pop a console window.
fn is_windows_codex_root_process(process: &WindowsCodexProcess) -> bool {
    let name = process.name.to_ascii_lowercase();
    let command = process.command_line.to_ascii_lowercase();
    let executable = process.executable_path.to_ascii_lowercase();

    if command.contains("--type=") {
        return false;
    }

    if is_windows_codex_desktop_process(process) {
        return true;
    }

    // No "codex-switcher" guard: the switcher's own binary is
    // codex-switcher.exe, which `name == "codex.exe"` already excludes, while
    // such a guard would drop a real Codex CLI whose arguments merely mention a
    // path containing "codex-switcher".
    name == "codex.exe"
        && !command.contains("app-server")
        && !command.contains("resources\\codex.exe")
        && !executable.contains("\\openai\\codex\\bin\\")
}

/// True for the Codex desktop app's main process (see above).
#[cfg(windows)]
fn is_windows_codex_desktop_process(process: &WindowsCodexProcess) -> bool {
    let name = process.name.to_ascii_lowercase();
    let executable = process.executable_path.to_ascii_lowercase();

    // `ChatGPT.exe` alone is not enough — the plain ChatGPT desktop app shares
    // the binary name. The package identity is what marks it as Codex.
    (name == "chatgpt.exe" || name == "codex.exe") && executable.contains("openai.codex")
}

#[cfg(windows)]
fn get_windows_codex_app_user_model_id(process: &WindowsCodexProcess) -> Option<String> {
    let executable = process.executable_path.to_ascii_lowercase();
    let marker = "\\windowsapps\\";
    let marker_index = executable.find(marker)?;
    let after_marker = &process.executable_path[marker_index + marker.len()..];
    let package_full_name = after_marker.split('\\').next()?.trim();
    if package_full_name.is_empty() {
        return None;
    }

    if let Some((package_name_and_version, publisher_id)) = package_full_name.split_once("__") {
        if let Some(package_name) = package_name_and_version.split('_').next() {
            if !package_name.is_empty() && !publisher_id.is_empty() {
                return Some(format!("{package_name}_{publisher_id}!App"));
            }
        }
    }

    Some(format!("{package_full_name}!App"))
}

#[cfg(windows)]
fn find_windows_codex_app_user_model_id() -> anyhow::Result<Option<String>> {
    const POWERSHELL_SCRIPT: &str = r#"
Get-StartApps |
  Where-Object { $_.AppID -like 'OpenAI.Codex*' -or $_.AppID -like 'OpenAI.ChatGPT*' } |
  Select-Object -First 1 -ExpandProperty AppID
"#;

    let output = Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            POWERSHELL_SCRIPT,
        ])
        .output()
        .context("failed to query Codex Start app")?;

    if !output.status.success() {
        return Ok(None);
    }

    let app_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!app_id.is_empty()).then_some(app_id))
}

#[cfg(any(unix, windows))]
fn is_ide_plugin_process(command: &str) -> bool {
    command.contains(".antigravity")
        || command.contains("openai.chatgpt")
        || command.contains(".vscode")
}
