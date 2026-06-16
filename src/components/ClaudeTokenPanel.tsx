import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyRound, Plus, Check, Copy, Trash2, RefreshCcw, AlertTriangle, Loader2, Pencil, X,
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
  /** Reports the current account count up to the tab badge. */
  onCountChange?: (n: number) => void;
}

export function ClaudeTokenPanel({ language, onCountChange }: Props) {
  const lang = language;
  const [accounts, setAccounts] = useState<ClaudeTokenAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const onCountRef = useRef(onCountChange);
  onCountRef.current = onCountChange;

  const load = useCallback(async () => {
    try {
      const list = await invokeBackend<ClaudeTokenAccountInfo[]>("list_claude_token_accounts");
      setAccounts(list);
      setError(null);
      onCountRef.current?.(list.length);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activate = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await invokeBackend("activate_claude_token_account", { id });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const remove = useCallback(async (id: string, name: string) => {
    if (!window.confirm(L(lang, `Удалить токен-аккаунт «${name}»?`, `Delete token account "${name}"?`))) return;
    setBusyId(id);
    try {
      await invokeBackend("delete_claude_token_account", { id });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }, [lang, load]);

  const rename = useCallback(async (id: string, current: string) => {
    const next = window.prompt(L(lang, "Новое имя:", "New name:"), current);
    if (!next || next.trim() === current) return;
    try {
      await invokeBackend("rename_claude_token_account", { id, name: next.trim() });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }, [lang, load]);

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

  const createViaSetupToken = useCallback(async () => {
    const name = window.prompt(L(lang, "Имя для нового аккаунта:", "Name for the new account:"));
    if (!name || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await invokeBackend("create_claude_token_account", { name: name.trim(), planLabel: null });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }, [lang, load]);

  return (
    <div className="token-panel" style={{ flex: 1, overflow: "auto", padding: "16px 18px" }}>
      {/* Header / actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <KeyRound size={16} style={{ opacity: 0.8 }} />
        <b style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
          {L(lang, "Claude CLI — долгоживущие токены", "Claude CLI — long-lived tokens")}
        </b>
        <span style={{ flex: 1 }} />
        <button type="button" className="chip chip--add" onClick={() => void createViaSetupToken()} disabled={creating}
          title="claude setup-token">
          {creating ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{" "}
          {L(lang, "Создать токен", "Create token")}
        </button>
        <button type="button" className="chip chip--add" onClick={() => setShowAdd((v) => !v)}>
          <Plus size={13} /> {L(lang, "Добавить готовый", "Add existing")}
        </button>
      </div>

      {showAdd && (
        <AddExistingForm
          lang={lang}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); void load(); }}
          onError={setError}
        />
      )}

      {error && (
        <div style={{
          display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", marginBottom: 12,
          background: "var(--bad)18", border: "1px solid var(--bad)55", borderRadius: 8,
          color: "var(--bad)", fontFamily: "var(--mono)", fontSize: 12, whiteSpace: "pre-wrap",
        }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="icon-btn icon-btn--xs" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Rows */}
      {loading ? (
        <div style={{ padding: "28px 0", textAlign: "center", color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
          <RefreshCcw size={18} className="spin" />
        </div>
      ) : accounts.length === 0 ? (
        <div style={{ padding: "28px 12px", textAlign: "center", color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.7 }}>
          {L(lang, "Нет токен-аккаунтов.", "No token accounts yet.")}<br />
          {L(lang,
            "Создай через «claude setup-token» или вставь готовый токен.",
            "Create one via “claude setup-token” or paste an existing token.")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {accounts.map((a) => {
            const days = daysUntil(a.expires_at);
            const expiring = days <= 30;
            const expired = days < 0;
            return (
              <div key={a.id} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                borderRadius: 8, fontFamily: "var(--mono)", fontSize: 12.5,
                background: a.is_active ? "var(--accent)14" : "transparent",
                border: a.is_active ? "1px solid var(--accent)55" : "1px solid transparent",
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: a.is_active ? "var(--ok, #16a34a)" : "var(--text-3)",
                }} />
                <span style={{ fontWeight: 600, minWidth: 110 }}>{a.name}</span>
                <span style={{ color: "var(--text-3)", minWidth: 54 }}>{a.plan_label || "—"}</span>
                <span style={{ color: "var(--text-3)" }} title={a.token_masked}>{a.token_masked}</span>
                <span style={{ flex: 1 }} />
                <span style={{
                  color: expired ? "var(--bad)" : expiring ? "var(--warn, #ca8a04)" : "var(--text-3)",
                  display: "inline-flex", alignItems: "center", gap: 4,
                }} title={new Date(a.expires_at).toLocaleDateString()}>
                  {(expiring || expired) && <AlertTriangle size={12} />}
                  {expired ? L(lang, "истёк", "expired") : L(lang, `${days}д`, `${days}d`)}
                </span>

                {a.is_active ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ok, #16a34a)" }}>
                    <Check size={13} /> {L(lang, "активен", "active")}
                  </span>
                ) : (
                  <button type="button" className="chip" disabled={busyId === a.id} onClick={() => void activate(a.id)}>
                    {busyId === a.id ? <Loader2 size={12} className="spin" /> : L(lang, "Активир.", "Activate")}
                  </button>
                )}

                <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Копировать export", "Copy export")}
                  onClick={() => void copyExport(a.id)}>
                  {copiedId === a.id ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Переименовать", "Rename")}
                  onClick={() => void rename(a.id, a.name)}>
                  <Pencil size={13} />
                </button>
                <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Удалить", "Delete")}
                  onClick={() => void remove(a.id, a.name)}>
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 14, color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.7 }}>
        {L(lang,
          "Активный токен подставляется в CLAUDE_CODE_OAUTH_TOKEN. На Windows — для новых терминалов автоматически; на macOS/Linux нажми «Копировать export» и вставь в свой shell.",
          "The active token is injected into CLAUDE_CODE_OAUTH_TOKEN. On Windows it applies to new terminals automatically; on macOS/Linux use “Copy export” and paste it into your shell.")}
        <br />
        {L(lang, "⚠ = токен скоро истечёт — пересоздай через «claude setup-token».",
          "⚠ = token expiring soon — regenerate via “claude setup-token”.")}
      </div>
    </div>
  );
}

function AddExistingForm({
  lang, onClose, onAdded, onError,
}: {
  lang: Lang;
  onClose: () => void;
  onAdded: () => void;
  onError: (e: string) => void;
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
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: 12, marginBottom: 12,
      border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface-2, #0000000a)",
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
        <button type="button" className="chip chip--add" disabled={saving || !name.trim() || !token.trim()}
          onClick={() => void submit()}>
          {saving ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {L(lang, "Добавить", "Add")}
        </button>
      </div>
    </div>
  );
}
