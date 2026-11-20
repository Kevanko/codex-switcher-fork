import { useEffect, useRef, useState } from "react";
import { Archive, ChevronLeft, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { invokeBackend } from "../lib/platform";

const PAGE = 10;

export interface BackupItem {
  id: string;
  created: string;
  reason: string;
  accounts: number;
  boundAccounts?: number | null;
}

interface Props {
  ru: boolean;
  /** Called after a restore, when accounts.json has changed. */
  onRestored: () => void;
  onToast: (message: string, isError?: boolean, ms?: number) => void;
}

// Read by screen readers, not shown: the toast already shows the message.
const VISUALLY_HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

const REASONS:Record<string, [string, string]> = {
  automatic: ["автоматически", "automatic"],
  manual: ["вручную", "manual"],
  "before-restore": ["перед восстановлением", "before a restore"],
  "before-delete": ["перед удалением", "before a delete"],
  "before-import": ["перед импортом", "before an import"],
};

function reasonLabel(reason: string, ru: boolean) {
  const label = REASONS[reason];
  return label ? label[ru ? 0 : 1] : reason;
}

// The id starts with the local time it was made: YYYYMMDD-HHMMSS-mmm.
function createdLabel(item: BackupItem, ru: boolean) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(item.id);
  if (!m) return item.created;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, sec).toLocaleString(ru ? "ru-RU" : "en-US");
}

function pages(count: number, size: number) {
  return Math.max(1, Math.ceil(count / size));
}

function Pager({ page, total, onChange, ru }: { page: number; total: number; onChange: (page: number) => void; ru: boolean }) {
  if (total <= 1) return null;
  return (
    <div className="backup-pager">
      <button type="button" className="icon-btn icon-btn--sm" disabled={page <= 0} onClick={() => onChange(page - 1)} title={ru ? "Назад" : "Previous"} aria-label={ru ? "Назад" : "Previous"}>
        <ChevronLeft size={14} />
      </button>
      <span>{ru ? `стр. ${page + 1} / ${total}` : `page ${page + 1} / ${total}`}</span>
      <button type="button" className="icon-btn icon-btn--sm" disabled={page >= total - 1} onClick={() => onChange(page + 1)} title={ru ? "Вперёд" : "Next"} aria-label={ru ? "Вперёд" : "Next"}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

// Snapshots of accounts.json, newest first, ten per page.
export function BackupsList({ ru, onRestored, onToast }: Props) {
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; action: "restore" | "delete" } | null>(null);
  const [status, setStatus] = useState("");
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirm) yesRef.current?.focus();
  }, [confirm]);

  const say = (message: string, ms?: number) => {
    setStatus(message);
    onToast(message, false, ms);
  };

  const reportError = (err: unknown) => onToast(String(err), true, 6000);

  useEffect(() => {
    invokeBackend<BackupItem[]>("list_backups").then(setBackups).catch(reportError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createBackup = async () => {
    setBusy(true);
    try {
      setBackups(await invokeBackend<BackupItem[]>("create_backup"));
      setPage(0);
      say(ru ? "Бэкап создан" : "Backup created");
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    setBusy(true);
    setConfirm(null);
    try {
      setBackups(await invokeBackend<BackupItem[]>("restore_backup", { id }));
      onRestored();
      say(ru ? "Недостающие аккаунты и привязки восстановлены" : "Missing accounts and credentials restored", 5000);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setConfirm(null);
    try {
      const list = await invokeBackend<BackupItem[]>("delete_backup", { id });
      setBackups(list);
      setPage((current) => Math.min(current, pages(list.length, PAGE) - 1));
      say(ru ? "Бэкап удалён" : "Backup deleted");
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup-section">
      <button type="button" className="btn btn--ghost btn--md btn--full" disabled={busy} onClick={() => void createBackup()}>
        <Archive size={14} /> {ru ? "Создать локальный снимок" : "Create a local snapshot"}
      </button>
      <div className="setting-hint">
        {ru
          ? "Снимки создаются при запуске и изменении привязок. Новые снимки хранятся отдельно от программы. При восстановлении добавляются недостающие аккаунты и привязки."
          : "Snapshots are created at startup and when saved credentials change. New snapshots live outside the app folder. Restore adds missing accounts and credentials."}
      </div>
      <div className="setting-hint" role="note">
        {ru
          ? "Локальные снимки содержат токены и пароли в открытом виде. Для переноса используй файл копии с паролем."
          : "Local snapshots contain plain-text tokens and passwords. Use a password-protected backup file for transfer."}
      </div>
      <div aria-live="polite" role="status" style={VISUALLY_HIDDEN}>{status}</div>
      {backups.length === 0 && <div className="setting-hint">{ru ? "Бэкапов пока нет." : "No backups yet."}</div>}
      <div className="backup-list">
        {backups.slice(page * PAGE, page * PAGE + PAGE).map((item) => (
          <div className="backup-row" key={item.id}>
            <div className="backup-main">
              <span className="backup-name">{createdLabel(item, ru)}</span>
              <span className="backup-meta">
                {ru ? `аккаунтов ${item.accounts}` : `accounts ${item.accounts}`} · {reasonLabel(item.reason, ru)}
                {item.boundAccounts != null && (ru ? ` · с привязками ${item.boundAccounts}` : ` · with credentials ${item.boundAccounts}`)}
              </span>
            </div>
            {confirm?.id === item.id ? (
              <span className="backup-confirm">
                <span className="backup-confirm-text">
                  {confirm.action === "restore"
                    ? ru ? "Добавить недостающие данные?" : "Restore missing data?"
                    : ru ? "Удалить бэкап?" : "Delete this backup?"}
                </span>
                <button
                  ref={yesRef}
                  type="button"
                  className={"btn btn--sm " + (confirm.action === "restore" ? "btn--primary" : "btn--danger")}
                  disabled={busy}
                  onClick={() => void (confirm.action === "restore" ? restore(item.id) : remove(item.id))}
                >
                  {ru ? "Да" : "Yes"}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirm(null)}>
                  {ru ? "Нет" : "No"}
                </button>
              </span>
            ) : (
              <span className="backup-actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirm({ id: item.id, action: "restore" })}>
                  <RotateCcw size={12} /> {ru ? "Восстановить" : "Restore"}
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={busy}
                  onClick={() => setConfirm({ id: item.id, action: "delete" })}
                  title={ru ? "Удалить бэкап" : "Delete backup"}
                  aria-label={ru ? "Удалить бэкап" : "Delete backup"}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <Pager page={page} total={pages(backups.length, PAGE)} onChange={setPage} ru={ru} />
    </div>
  );
}
