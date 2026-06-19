import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyRound, Plus, Check, Copy, Trash2, RefreshCcw, AlertTriangle, Loader2, Pencil, X, Power,
} from "lucide-react";
import { invokeBackend } from "../lib/platform";
import type { ClaudeTokenAccountInfo } from "../types";

type Lang = "ru" | "en";
const L = (lang: Lang, ru: string, en: string) => (lang === "ru" ? ru : en);

/** Whole days until `iso`; negative if already expired. */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}

interface Props {
  language: Lang;
  /** Reports the current token list up to the parent (tab badge + stats). */
  onTokensChange?: (tokens: ClaudeTokenAccountInfo[]) => void;
}

export function ClaudeTokenPanel({ language, onTokensChange }: Props) {
  const lang = language;
  const [accounts, setAccounts] = useState<ClaudeTokenAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const onTokensRef = useRef(onTokensChange);
  onTokensRef.current = onTokensChange;

  const load = useCallback(async () => {
    try {
      const list = await invokeBackend<ClaudeTokenAccountInfo[]>("list_claude_token_accounts");
      setAccounts(list);
      setError(null);
      onTokensRef.current?.(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const activate = (id: string) => run(id, () => invokeBackend("activate_claude_token_account", { id }));
  const deactivate = () => run("__off__", () => invokeBackend("deactivate_claude_token"));

  const remove = (id: string, name: string) => {
    if (!window.confirm(L(lang, `Удалить токен-аккаунт «${name}»?`, `Delete token account "${name}"?`))) return;
    void run(id, () => invokeBackend("delete_claude_token_account", { id }));
  };

  const rename = useCallback(async (id: string, current: string) => {
    const next = window.prompt(L(lang, "Новое имя:", "New name:"), current);
    if (!next || next.trim() === current) return;
    await run(id, () => invokeBackend("rename_claude_token_account", { id, name: next.trim() }));
  }, [lang, run]);

  const copyExport = useCallback(async (id: string) => {
    try {
      const token = await invokeBackend<string>("get_claude_token_secret", { id });
      const isWin = navigator.userAgent.includes("Windows");
      const line = isWin
        ? `set CLAUDE_CODE_OAUTH_TOKEN=${token}`
        : `export CLAUDE_CODE_OAUTH_TOKEN=${token}`;
      await navigator.clipboard.writeText(line);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const active = accounts.find((a) => a.is_active) || null;

  return (
    <div className="token-panel">
      <div className="token-inner">
        {/* Header / actions */}
        <div className="token-head">
          <h2><KeyRound size={15} /> {L(lang, "Claude CLI — долгоживущие токены", "Claude CLI — long-lived tokens")}</h2>
          <span style={{ flex: 1 }} />
          <button type="button" className="chip chip--add" onClick={() => setShowCreate(true)} title="claude setup-token">
            <Plus size={13} /> {L(lang, "Создать токен", "Create token")}
          </button>
          <button type="button" className="chip chip--add" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={13} /> {L(lang, "Добавить готовый", "Add existing")}
          </button>
        </div>

        {/* Active banner + disable */}
        {active && (
          <div className="token-banner">
            <KeyRound size={14} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>
              {L(lang, "Активен токен", "Active token")}: <b>{active.name}</b>{" "}
              — {L(lang, "Claude CLI использует его вместо обычного входа.", "Claude CLI uses it instead of the regular login.")}
            </span>
            <button type="button" className="chip" disabled={busyId === "__off__"} onClick={() => void deactivate()}
              title={L(lang, "Вернуться к обычным аккаунтам", "Return to regular accounts")}>
              {busyId === "__off__" ? <Loader2 size={12} className="spin" /> : <Power size={12} />}{" "}
              {L(lang, "Отключить", "Turn off")}
            </button>
          </div>
        )}

        {showAdd && (
          <AddExistingForm lang={lang} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void load(); }} onError={setError} />
        )}

        {showCreate && (
          <CreateTokenModal
            lang={lang}
            onClose={() => setShowCreate(false)}
            onAdded={() => { setShowCreate(false); void load(); }}
            onError={setError}
          />
        )}

        {error && (
          <div style={{
            display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px",
            background: "color-mix(in oklab, var(--bad) 10%, transparent)",
            border: "1px solid color-mix(in oklab, var(--bad) 36%, transparent)", borderRadius: 8,
            color: "var(--bad)", font: "12px var(--mono)", whiteSpace: "pre-wrap",
          }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="icon-btn icon-btn--xs" onClick={() => setError(null)}><X size={12} /></button>
          </div>
        )}

        {/* Rows */}
        {loading ? (
          <div className="token-empty"><RefreshCcw size={18} className="spin" /></div>
        ) : accounts.length === 0 ? (
          <div className="token-empty">
            {L(lang, "Нет токен-аккаунтов.", "No token accounts yet.")}<br />
            {L(lang,
              "Создай через «claude setup-token» или вставь готовый токен — кнопки выше.",
              "Create one via “claude setup-token” or paste an existing token — buttons above.")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {accounts.map((a) => {
              const days = daysUntil(a.expires_at);
              const expiring = days <= 30;
              const expired = days < 0;
              return (
                <div key={a.id} className={"token-row" + (a.is_active ? " is-active" : "")}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.is_active ? "var(--ok, #16a34a)" : "var(--text-3)" }} />
                  <span className="tr-name" title={a.name}>{a.name}</span>
                  <span className="tr-dim">{a.plan_label || "—"}</span>
                  <span className="tr-dim" title={a.token_masked}>{a.token_masked}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: expired ? "var(--bad)" : expiring ? "var(--warn, #ca8a04)" : "var(--text-3)" }}
                    title={new Date(a.expires_at).toLocaleDateString()}>
                    {(expiring || expired) && <AlertTriangle size={12} />}
                    {expired ? L(lang, "истёк", "expired") : L(lang, `${days} дн`, `${days}d`)}
                  </span>
                  <span className="tr-actions">
                    {a.is_active ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ok, #16a34a)", marginRight: 2 }}>
                        <Check size={13} /> {L(lang, "активен", "active")}
                      </span>
                    ) : (
                      <button type="button" className="chip" disabled={busyId === a.id} onClick={() => void activate(a.id)}>
                        {busyId === a.id ? <Loader2 size={12} className="spin" /> : L(lang, "Активир.", "Activate")}
                      </button>
                    )}
                    <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Копировать export", "Copy export")} onClick={() => void copyExport(a.id)}>
                      {copiedId === a.id ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Переименовать", "Rename")} onClick={() => void rename(a.id, a.name)}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Удалить", "Delete")} onClick={() => remove(a.id, a.name)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="token-hint">
          {L(lang,
            "Активный токен подставляется в CLAUDE_CODE_OAUTH_TOKEN. Windows — для новых терминалов автоматически; macOS/Linux — «Копировать export» и вставить в shell.",
            "The active token is injected into CLAUDE_CODE_OAUTH_TOKEN. Windows: new terminals pick it up automatically; macOS/Linux: use “Copy export” and paste it into your shell.")}
          <br />
          {L(lang,
            "«Отключить» убирает токен и возвращает Claude к обычным аккаунтам (вкладка Claude). ⚠ = токен скоро истечёт.",
            "“Turn off” removes the token and returns Claude to the regular accounts (Claude tab). ⚠ = token expiring soon.")}
        </div>
      </div>
    </div>
  );
}

function AddExistingForm({
  lang, onClose, onAdded, onError, bare = false,
}: {
  lang: Lang;
  onClose: () => void;
  onAdded: () => void;
  onError: (e: string) => void;
  /** Drop the outer card styling when embedded inside a modal. */
  bare?: boolean;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [plan, setPlan] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = useCallback(async () => {
    if (!name.trim() || !token.trim()) return;
    setSaving(true);
    try {
      await invokeBackend("add_claude_token_account", {
        name: name.trim(),
        token: token.trim(),
        planLabel: plan.trim() || null,
      });
      onAdded();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }, [name, token, plan, onAdded, onError]);

  return (
    <div style={bare
      ? { display: "flex", flexDirection: "column", gap: 8 }
      : {
          display: "flex", flexDirection: "column", gap: 8, padding: 12,
          border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-2)",
        }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="ui-input" placeholder={L(lang, "Имя (напр. Work)", "Name (e.g. Work)")}
          value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 2 }} />
        <input className="ui-input" placeholder={L(lang, "План (напр. Max)", "Plan (e.g. Max)")}
          value={plan} onChange={(e) => setPlan(e.target.value)} style={{ flex: 1 }} />
      </div>
      <textarea className="ui-input" placeholder={L(lang, "Вставь токен из «claude setup-token» (sk-ant-…)", "Paste the token from “claude setup-token” (sk-ant-…)")}
        value={token} onChange={(e) => setToken(e.target.value)} rows={3}
        style={{ fontFamily: "var(--mono)", fontSize: 12, resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="chip" onClick={onClose}>{L(lang, "Отмена", "Cancel")}</button>
        <button type="button" className="chip chip--add" disabled={saving || !name.trim() || !token.trim()} onClick={() => void submit()}>
          {saving ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{" "}
          {bare ? L(lang, "Сохранить токен", "Save token") : L(lang, "Добавить", "Add")}
        </button>
      </div>
    </div>
  );
}

/**
 * "Create token" flow: instead of spawning `claude setup-token` ourselves (which
 * has no TTY in a GUI and was failing), show a short how-to and let the user paste
 * the token the CLI prints. The paste path is the reliable, store-only backend call.
 */
function CreateTokenModal({
  lang, onClose, onAdded, onError,
}: {
  lang: Lang;
  onClose: () => void;
  onAdded: () => void;
  onError: (e: string) => void;
}) {
  const [cmdCopied, setCmdCopied] = useState(false);

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText("claude setup-token");
      setCmdCopied(true);
      window.setTimeout(() => setCmdCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the command is shown for manual copy anyway */
    }
  };

  return (
    <div className="config-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="config-panel fade-up" onMouseDown={(e) => e.stopPropagation()}>
        <div className="config-header">
          <div>
            <h2>{L(lang, "Создать токен Claude CLI", "Create a Claude CLI token")}</h2>
            <p>{L(lang,
              "Сгенерируйте долгоживущий токен командой и вставьте его сюда.",
              "Generate a long-lived token with the CLI, then paste it here.")}</p>
          </div>
          <button type="button" className="icon-btn icon-btn--md" onClick={onClose} title={L(lang, "Закрыть", "Close")}>
            <X size={16} />
          </button>
        </div>
        <div className="config-body">
          <ol className="token-steps">
            <li>
              {L(lang, "Откройте терминал и выполните:", "Open a terminal and run:")}
              <div className="token-cmd">
                <code>claude setup-token</code>
                <button type="button" className="icon-btn icon-btn--xs" onClick={() => void copyCmd()} title={L(lang, "Копировать", "Copy")}>
                  {cmdCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </li>
            <li>{L(lang, "Войдите в аккаунт Claude (нужен Pro или Max).", "Sign in to Claude (Pro or Max required).")}</li>
            <li>{L(lang, "Скопируйте выданный токен (начинается с sk-ant-).", "Copy the token it prints (starts with sk-ant-).")}</li>
            <li>{L(lang, "Вставьте его ниже и задайте имя.", "Paste it below and give it a name.")}</li>
          </ol>
          <AddExistingForm lang={lang} bare onClose={onClose} onAdded={onAdded} onError={onError} />
        </div>
      </div>
    </div>
  );
}
