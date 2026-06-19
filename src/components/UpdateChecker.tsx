import { useCallback, useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { ArrowUpCircle, Download, Loader2, RefreshCcw, X } from "lucide-react";
import { isTauriRuntime } from "../lib/platform";
import { translations, type Locale } from "../i18n";

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

export function UpdateChecker({ locale = "en" }: { locale?: Locale }) {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const t = translations[locale].update;

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
      const msg = err instanceof Error ? err.message : String(err);
      // Silently ignore network / missing-endpoint errors.
      // Only show an error toast for genuine update failures (download corruption, etc.).
      const isNetworkOrMissing =
        msg.toLowerCase().includes("fetch") ||
        msg.toLowerCase().includes("network") ||
        msg.toLowerCase().includes("release json") ||
        msg.toLowerCase().includes("404") ||
        msg.toLowerCase().includes("no data");
      if (!isNetworkOrMissing) {
        setStatus({ kind: "error", message: msg });
      } else {
        setStatus({ kind: "idle" });
      }
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void checkForUpdate();
    const interval = window.setInterval(() => {
      void checkForUpdate();
    }, 30 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

  const handleDownloadAndInstall = async () => {
    if (status.kind !== "available" || installing) return;

    try {
      if (!isTauriRuntime()) return;
      setInstalling(true);
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
      setStatus({ kind: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Update install failed:", err);
      setStatus({ kind: "error", message });
    } finally {
      setInstalling(false);
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
    <div className="app-toast-stack update-toast-stack" aria-live="polite">
      <div className="app-toast update-toast fade-up">
        {status.kind === "available" && (
          <>
            <ArrowUpCircle size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t.available}: v{status.update.version}</div>
              {status.update.body && (
                <div style={{ color: "var(--text-3)", fontSize: "0.84rem" }}>
                  {status.update.body}
                </div>
              )}
            </div>
            <button type="button" className="ui-action-button is-ghost" onClick={() => setDismissed(true)}>
              {t.later}
            </button>
            <button
              type="button"
              className="ui-action-button is-primary"
              onClick={handleDownloadAndInstall}
              disabled={installing}
            >
              {installing ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              {installing ? t.downloading : t.install}
            </button>
          </>
        )}

        {status.kind === "downloading" && (
          <>
            <Download size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t.downloading}</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.84rem" }}>
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
              <div style={{ fontWeight: 600 }}>{t.ready}</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.84rem" }}>
                {t.restartHint}
              </div>
            </div>
            <button type="button" className="ui-action-button is-ghost" onClick={() => setDismissed(true)}>
              {t.later}
            </button>
            <button type="button" className="ui-action-button is-primary" onClick={handleRelaunch}>
              {t.restart}
            </button>
          </>
        )}

        {status.kind === "error" && (
          <>
            <X size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t.failed}</div>
              <div style={{ color: "var(--text-3)", fontSize: "0.84rem" }}>
                {status.message}
              </div>
            </div>
            <button type="button" className="ui-action-button is-ghost" onClick={() => setDismissed(true)}>
              {t.dismiss}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
