import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes, Plus, Check, Copy, Trash2, RefreshCcw, AlertTriangle, Loader2, Pencil, X, Power,
} from "lucide-react";
import { invokeBackend } from "../lib/platform";
import type { GatewayAccountInfo } from "../types";

type Lang = "ru" | "en";
const L = (lang: Lang, ru: string, en: string) => (lang === "ru" ? ru : en);

/** Built-in presets: pick one to fill base URL + a sensible default model. */
const PRESETS: { id: string; label: string; baseUrl: string; model: string }[] = [
  { id: "zai", label: "z.ai (GLM Coding Plan)", baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.2" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api", model: "z-ai/glm-5.2" },
  { id: "fireworks", label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference", model: "accounts/fireworks/models/glm-5p2" },
  { id: "custom", label: "Custom", baseUrl: "", model: "" },
];

interface Props {
  language: Lang;
  onGatewaysChange?: (gw: GatewayAccountInfo[]) => void;
}

export function GatewayPanel({ language, onGatewaysChange }: Props) {
  const lang = language;
  const [accounts, setAccounts] = useState<GatewayAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const onChangeRef = useRef(onGatewaysChange);
  onChangeRef.current = onGatewaysChange;

  const load = useCallback(async () => {
    try {
      const list = await invokeBackend<GatewayAccountInfo[]>("list_gateway_accounts");
      setAccounts(list);
      setError(null);
      onChangeRef.current?.(list);
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

  const activate = (id: string) => run(id, () => invokeBackend("activate_gateway_account", { id }));
  const deactivate = () => run("__off__", () => invokeBackend("deactivate_gateway"));

  const remove = (id: string, name: string) => {
    if (!window.confirm(L(lang, `Удалить gateway-аккаунт «${name}»?`, `Delete gateway account "${name}"?`))) return;
    void run(id, () => invokeBackend("delete_gateway_account", { id }));
  };

  const rename = useCallback(async (id: string, current: string) => {
    const next = window.prompt(L(lang, "Новое имя:", "New name:"), current);
    if (!next || next.trim() === current) return;
    await run(id, () => invokeBackend("rename_gateway_account", { id, name: next.trim() }));
  }, [lang, run]);

  const copyExport = useCallback(async (a: GatewayAccountInfo) => {
    try {
      const key = await invokeBackend<string>("get_gateway_key_secret", { id: a.id });
      const isWin = navigator.userAgent.includes("Windows");
      const set = isWin ? "set" : "export";
      const lines = [
        `${set} ANTHROPIC_BASE_URL=${a.base_url}`,
        `${set} ANTHROPIC_AUTH_TOKEN=${key}`,
        ...(a.model ? [`${set} ANTHROPIC_MODEL=${a.model}`] : []),
      ].join("\n");
      await navigator.clipboard.writeText(lines);
      setCopiedId(a.id);
      window.setTimeout(() => setCopiedId((c) => (c === a.id ? null : c)), 1500);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const active = accounts.find((a) => a.is_active) || null;

  return (
    <div className="token-panel">
      <div className="token-inner">
        <div className="token-head">
          <h2><Boxes size={15} /> {L(lang, "GLM / Anthropic-совместимые шлюзы", "GLM / Anthropic-compatible gateways")}</h2>
          <span style={{ flex: 1 }} />
          <button type="button" className="chip chip--add" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={13} /> {L(lang, "Добавить шлюз", "Add gateway")}
          </button>
        </div>

        {active && (
          <div className="token-banner">
            <Boxes size={14} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>
              {L(lang, "Активен шлюз", "Active gateway")}: <b>{active.name}</b>
              {active.model ? <> — <code>{active.model}</code></> : null}{" "}
              — {L(lang, "Claude Code обращается к нему вместо Anthropic.", "Claude Code routes to it instead of Anthropic.")}
            </span>
            <button type="button" className="chip" disabled={busyId === "__off__"} onClick={() => void deactivate()}
              title={L(lang, "Вернуться к обычным аккаунтам", "Return to regular accounts")}>
              {busyId === "__off__" ? <Loader2 size={12} className="spin" /> : <Power size={12} />}{" "}
              {L(lang, "Отключить", "Turn off")}
            </button>
          </div>
        )}

        {showAdd && (
          <AddGatewayForm lang={lang} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void load(); }} onError={setError} />
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

        {loading ? (
          <div className="token-empty"><RefreshCcw size={18} className="spin" /></div>
        ) : accounts.length === 0 ? (
          <div className="token-empty">
            {L(lang, "Нет шлюзов.", "No gateways yet.")}<br />
            {L(lang,
              "Добавь GLM (z.ai Coding Plan) или OpenRouter — кнопка выше. Нужен только API-ключ.",
              "Add GLM (z.ai Coding Plan) or OpenRouter — button above. Only an API key is needed.")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {accounts.map((a) => (
              <div key={a.id} className={"token-row" + (a.is_active ? " is-active" : "")}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.is_active ? "var(--ok, #16a34a)" : "var(--text-3)" }} />
                <span className="tr-name" title={a.name}>{a.name}</span>
                <span className="tr-dim" title={a.base_url}>{a.model || "—"}</span>
                <span className="tr-dim" title={a.key_masked}>{a.key_masked}</span>
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
                  <button type="button" className="icon-btn icon-btn--xs" title={L(lang, "Копировать export", "Copy export")} onClick={() => void copyExport(a)}>
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
            ))}
          </div>
        )}

        <div className="token-hint">
          {L(lang,
            "Активный шлюз подставляет ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_MODEL) и убирает CLAUDE_CODE_OAUTH_TOKEN. Windows — для новых терминалов автоматически; macOS/Linux — «Копировать export».",
            "The active gateway injects ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_MODEL) and clears CLAUDE_CODE_OAUTH_TOKEN. Windows: new terminals pick it up automatically; macOS/Linux: use “Copy export”.")}
          <br />
          {L(lang,
            "Переключение на обычный Claude-аккаунт автоматически снимает шлюз.",
            "Switching to a regular Claude account automatically clears the gateway.")}
        </div>
      </div>
    </div>
  );
}

function AddGatewayForm({
  lang, onClose, onAdded, onError,
}: {
  lang: Lang;
  onClose: () => void;
  onAdded: () => void;
  onError: (e: string) => void;
}) {
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [model, setModel] = useState(PRESETS[0].model);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const pickPreset = (id: string) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (p && p.id !== "custom") { setBaseUrl(p.baseUrl); setModel(p.model); }
  };

  const submit = useCallback(async () => {
    if (!name.trim() || !key.trim() || !baseUrl.trim()) return;
    setSaving(true);
    try {
      await invokeBackend("add_gateway_account", {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        key: key.trim(),
        model: model.trim() || null,
      });
      onAdded();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }, [name, baseUrl, key, model, onAdded, onError]);

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: 12,
      border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-2)",
    }}>
      <div style={{ display: "flex", gap: 8 }}>
        <select className="ui-input" value={preset} onChange={(e) => pickPreset(e.target.value)} style={{ flex: 1 }}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input className="ui-input" placeholder={L(lang, "Имя (напр. GLM)", "Name (e.g. GLM)")}
          value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="ui-input" placeholder="https://api.z.ai/api/anthropic"
          value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
          style={{ flex: 2, fontFamily: "var(--mono)", fontSize: 12 }} />
        <input className="ui-input" placeholder={L(lang, "Модель (напр. glm-5.2)", "Model (e.g. glm-5.2)")}
          value={model} onChange={(e) => setModel(e.target.value)}
          style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12 }} />
      </div>
      <input className="ui-input" placeholder={L(lang, "API-ключ шлюза", "Gateway API key")}
        value={key} onChange={(e) => setKey(e.target.value)}
        style={{ fontFamily: "var(--mono)", fontSize: 12 }} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="chip" onClick={onClose}>{L(lang, "Отмена", "Cancel")}</button>
        <button type="button" className="chip chip--add" disabled={saving || !name.trim() || !key.trim() || !baseUrl.trim()} onClick={() => void submit()}>
          {saving ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{" "}
          {L(lang, "Добавить", "Add")}
        </button>
      </div>
    </div>
  );
}
