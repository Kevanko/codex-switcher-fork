//! Process detection commands

use std::process::Command;

/// Information about running Codex processes
#[derive(Debug, Clone, serde::Serialize)]
pub struct CodexProcessInfo {
    /// Number of running codex processes
    pub count: usize,
    /// Whether switching is allowed (no processes running)
    pub can_switch: bool,
    /// Process IDs of running codex processes
    pub pids: Vec<u32>,
}

/// Check for running Codex processes
#[tauri::command]
pub async fn check_codex_processes() -> Result<CodexProcessInfo, String> {
    let pids = find_codex_processes().map_err(|e| e.to_string())?;
    let count = pids.len();

    Ok(CodexProcessInfo {
        count,
        can_switch: count == 0,
        pids,
    })
}

/// Find all running codex processes
fn find_codex_processes() -> anyhow::Result<Vec<u32>> {
    let mut pids = Vec::new();

    #[cfg(unix)]
    {
        // Use pgrep to find codex processes (exact match for "codex" command)
        let output = Command::new("pgrep")
            .args(["-x", "codex"])  // -x for exact match
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if let Ok(pid) = line.trim().parse::<u32>() {
                        // Exclude our own process
                        if pid != std::process::id() {
                            pids.push(pid);
                        }
                    }
                }
            }
        }

        // Also try ps for more reliable detection
        let output = Command::new("ps")
            .args(["aux"])
            .output();

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let line_lower = line.to_lowercase();
                
                // Skip our own app and related processes
                if line_lower.contains("codex-switcher")
                    || line_lower.contains("codex switcher")
                    || line_lower.contains("grep")
                    || line_lower.contains("pgrep")
                {
                    continue;
                }
                
                // Look for codex CLI processes
                // Match "codex" as a standalone word (not part of another word)
                let has_codex = line_lower.split_whitespace().any(|word| {
                    word == "codex" || word.ends_with("/codex") || word.starts_with("codex ")
                }) || line_lower.contains("/codex ") || line_lower.contains("/codex\t");
                
                if has_codex {
                    // Extract PID (second column in ps aux output)
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() > 1 {
                        if let Ok(pid) = parts[1].parse::<u32>() {
                            if pid != std::process::id() && !pids.contains(&pid) {
                                pids.push(pid);
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        // Use tasklist on Windows
        let output = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq codex*", "/FO", "CSV", "/NH"])
            .output();

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                // CSV format: "name","pid",...
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() > 1 {
                    let pid_str = parts[1].trim_matches('"');
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if pid != std::process::id() {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
    }

    Ok(pids)
}
