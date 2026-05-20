import { useCallback, useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { ArrowUpCircle, Download, RefreshCcw, X } from "lucide-react";
import { isTauriRuntime } from "../lib/platform";

type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateChecker() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async () => {
    if (!isTauriRuntime()) return;

    try {
      setStatus({ kind: "checking" });
      setDismissed(false);
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      setStatus(update ? { kind: "available", update } : { kind: "idle" });
    } catch (err) {
      console.error("Update check failed:", err);
      setStatus({ kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void checkForUpdate();
  }, [checkForUpdate]);

  const handleDownloadAndInstall = async () => {
    if (status.kind !== "available") return;

    try {
      if (!isTauriRuntime()) return;
      let downloaded = 0;
      let total: number | null = null;

      await status.update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setStatus({ kind: "downloading", downloaded: 0, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setStatus({ kind: "downloading", downloaded, total });
            break;
          case "Finished":
            setStatus({ kind: "ready" });
            break;
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Update install failed:", err);
      setStatus({ kind: "error", message });
    }
  };

  const handleRelaunch = async () => {
    try {
      if (!isTauriRuntime()) return;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("Relaunch failed:", err);
    }
  };

  if (!isTauriRuntime()) return null;
  if (status.kind === "idle" || status.kind === "checking" || dismissed) return null;

  return (
    <div className="app-toast-stack" aria-live="polite">
      <div className="app-toast fade-up">
        {status.kind === "available" && (
          <>
            <ArrowUpCircle size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Update available: v{status.update.version}</div>
              {status.update.body && (
                <div style={{ color: "var(--text-secondary)", fontSize: "0.84rem" }}>
                  {status.update.body}
                </div>
              )}
            </div>
            <button type="button" className="ui-action-button is-ghost" onClick={() => setDismissed(true)}>
              Later
            </button>
            <button type="button" className="ui-action-button is-primary" onClick={handleDownloadAndInstall}>
              <Download size={16} />
              Update
            </button>
          </>
        )}

        {status.kind === "downloading" && (
          <>
            <Download size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Downloading update</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.84rem" }}>
                {formatBytes(status.downloaded)}
                {status.total ? ` / ${formatBytes(status.total)}` : ""}
              </div>
              <div className="usage-track" style={{ marginTop: 10 }}>
                <div
                  className="usage-fill is-accent"
                  style={{
                    width:
                      status.total && status.total > 0
                        ? `${Math.min(100, (status.downloaded / status.total) * 100)}%`
                        : "50%",
                  }}
                />
              </div>
            </div>
          </>
        )}

        {status.kind === "ready" && (
          <>
            <RefreshCcw size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Update ready</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.84rem" }}>
                Restart the app to apply the new build.
              </div>
            </div>
            <button type="button" className="ui-action-button is-ghost" onClick={() => setDismissed(true)}>
              Later
            </button>
            <button type="button" className="ui-action-button is-primary" onClick={handleRelaunch}>
              Restart
            </button>
          </>
        )}

        {status.kind === "error" && (
          <>
            <X size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Update failed</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.84rem" }}>
                {status.message}
              </div>
            </div>
            <button type="button" className="ui-action-button is-ghost" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}
