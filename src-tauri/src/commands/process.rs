//! Process detection commands

use std::process::Command;

#[cfg(windows)]
use anyhow::Context;

#[cfg(windows)]
use std::collections::HashSet;

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
    parent_process_id: u32,
    #[serde(default)]
    executable_path: String,
    #[serde(default)]
    command_line: String,
    #[serde(default)]
    main_window_title: String,
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
        let mut active_roots = processes
            .iter()
            .filter(|process| is_windows_codex_root_process(process))
            .filter(|process| {
                let command = process.command_line.to_ascii_lowercase();
                if is_ide_plugin_process(&command) {
                    return false;
                }

                let has_window = !process.main_window_title.trim().is_empty();
                let has_renderer =
                    windows_has_descendant_matching(process.process_id, &processes, |child| {
                        child
                            .command_line
                            .to_ascii_lowercase()
                            .contains("--type=renderer")
                    });
                let has_app_server =
                    windows_has_descendant_matching(process.process_id, &processes, |child| {
                        let command = child.command_line.to_ascii_lowercase();
                        command.contains("resources\\codex.exe") && command.contains("app-server")
                    });

                has_window || has_renderer || has_app_server
            })
            .cloned()
            .collect::<Vec<_>>();

        active_roots.sort_by_key(|process| process.process_id);
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
            let status = Command::new("kill").args(["-9", &pid.to_string()]).status()?;
            if !status.success() {
                anyhow::bail!("Failed to terminate Codex process {pid}");
            }
        }

        #[cfg(windows)]
        {
            let status = Command::new("taskkill")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["/F", "/PID", &pid.to_string()])
                .status()?;
            if !status.success() {
                anyhow::bail!("Failed to terminate Codex process {pid}");
            }
        }
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
                    &format!("Start-Process -FilePath '{}'", executable.replace("'", "''")),
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

#[cfg(windows)]
fn find_windows_codex_processes() -> anyhow::Result<(Vec<u32>, usize)> {
    let processes = query_windows_codex_processes()?;

    let mut active_pids = Vec::new();
    let mut ignored_count = 0;

    for process in processes
        .iter()
        .filter(|process| is_windows_codex_root_process(process))
    {
        let command = process.command_line.to_ascii_lowercase();
        if is_ide_plugin_process(&command) {
            ignored_count += 1;
            continue;
        }

        let has_window = !process.main_window_title.trim().is_empty();
        let has_renderer =
            windows_has_descendant_matching(process.process_id, &processes, |child| {
                child
                    .command_line
                    .to_ascii_lowercase()
                    .contains("--type=renderer")
            });
        let has_app_server =
            windows_has_descendant_matching(process.process_id, &processes, |child| {
                let command = child.command_line.to_ascii_lowercase();
                command.contains("resources\\codex.exe") && command.contains("app-server")
            });

        if has_window || has_renderer || has_app_server {
            active_pids.push(process.process_id);
        } else {
            // Ignore stale helper trees left behind after the window has already closed.
            ignored_count += 1;
        }
    }

    active_pids.sort_unstable();
    active_pids.dedup();

    Ok((active_pids, ignored_count))
}

#[cfg(windows)]
fn query_windows_codex_processes() -> anyhow::Result<Vec<WindowsCodexProcess>> {
    const POWERSHELL_SCRIPT: &str = r#"
$windowTitles = @{}
Get-Process -Name Codex -ErrorAction SilentlyContinue | ForEach-Object {
  $windowTitles[[uint32]$_.Id] = $_.MainWindowTitle
}

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq 'Codex.exe' -or $_.Name -ieq 'codex.exe' } |
  ForEach-Object {
    [PSCustomObject]@{
      Name = $_.Name
      ProcessId = [uint32]$_.ProcessId
      ParentProcessId = [uint32]$_.ParentProcessId
      ExecutablePath = if ($_.ExecutablePath) { $_.ExecutablePath } else { '' }
      CommandLine = if ($_.CommandLine) { $_.CommandLine } else { '' }
      MainWindowTitle = if ($windowTitles.ContainsKey([uint32]$_.ProcessId)) {
        [string]$windowTitles[[uint32]$_.ProcessId]
      } else {
        ''
      }
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
fn query_windows_codex_processes_from_output(stdout: &[u8]) -> anyhow::Result<Vec<WindowsCodexProcess>> {
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
fn is_windows_codex_root_process(process: &WindowsCodexProcess) -> bool {
    let name = process.name.to_ascii_lowercase();
    let command = process.command_line.to_ascii_lowercase();

    name == "codex.exe"
        && !command.contains("codex-switcher")
        && !command.contains("--type=")
        && !command.contains("resources\\codex.exe")
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
  Where-Object { $_.Name -ieq 'Codex' -or $_.Name -like '*Codex*' } |
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

#[cfg(windows)]
fn windows_has_descendant_matching<F>(
    root_pid: u32,
    processes: &[WindowsCodexProcess],
    mut predicate: F,
) -> bool
where
    F: FnMut(&WindowsCodexProcess) -> bool,
{
    let mut queue = vec![root_pid];
    let mut visited = HashSet::new();

    while let Some(parent_pid) = queue.pop() {
        for process in processes
            .iter()
            .filter(|process| process.parent_process_id == parent_pid)
        {
            if !visited.insert(process.process_id) {
                continue;
            }

            if predicate(process) {
                return true;
            }

            queue.push(process.process_id);
        }
    }

    false
}
