import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  Boxes,
  Check,
  Clock,
  Coins,
  Crown,
  FolderInput,
  Loader2,
  PencilLine,
  Plus,
  RefreshCcw,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { invokeBackend, pickZcodeCredentialsFile } from "../lib/platform";
import { colorHex, type AccountLook } from "../lib/accountLooks";
import { LookIcon, LookPicker } from "./AccountLookPicker";
import type { ZcodeAccountInfo, ZcodePlanInfo } from "../types";

const ru_en = (ru: boolean, r: string, e: string) => (ru ? r : e);

function formatDate(iso: string, ru: boolean): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleDateString(ru ? "ru-RU" : "en-GB");
}


/** 53 564 538 -> "53.5M". Token grants run to nine digits; raw numbers are noise. */
function formatUnits(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1) + "M";
  if (value >= 1_000) return Math.round(value / 1_000) + "K";
  return String(value);
}

function formatEndsAt(endsAt: number | null | undefined, ru: boolean): string {
  if (!endsAt) return ru ? "без срока" : "no end date";
  const at = endsAt * 1000;
  const date = new Date(at).toLocaleDateString(ru ? "ru-RU" : "en-GB");
  const days = Math.ceil((at - Date.now()) / 86_400_000);
  if (days < 0) return ru ? `истёк ${date}` : `ended ${date}`;
  if (days === 0) return ru ? `сегодня · ${date}` : `today · ${date}`;
  return ru ? `ещё ${days} дн · ${date}` : `${days}d left · ${date}`;
}

/** "lite" -> "Lite". The tier is the headline fact about a Z.ai sign-in. */
function formatLevel(level: string | null | undefined): string | null {
  if (!level?.trim()) return null;
  return level.trim().charAt(0).toUpperCase() + level.trim().slice(1);
}

function formatRefreshAt(at: number | null | undefined, ru: boolean): string {
  if (!at) return "—";
  return new Date(at * 1000).toLocaleString(ru ? "ru-RU" : "en-GB", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Z.ai Coding Plan tiers wear the same metals as the Codex plans: a hollow
 * glacier crown for Lite, a solid gold one for Pro, a solid verdigris one for
 * Max. A snapshot with no tier gets no mark, exactly like a Free Codex account.
 */
function tierMark(level: string | null | undefined): { colorVar: string; solid: boolean } | null {
  const normalized = level?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized.includes("max")) return { colorVar: "--tier-team", solid: true };
  if (normalized.includes("pro")) return { colorVar: "--tier-pro", solid: true };
  return { colorVar: "--tier-plus", solid: false };
}

/** The `data-tier` value whose CSS paints the row outline. */
function zcodeTierName(level: string | null | undefined): "plus" | "pro" | "team" | undefined {
  const mark = tierMark(level);
  if (!mark) return undefined;
  return mark.colorVar === "--tier-pro" ? "pro" : mark.colorVar === "--tier-team" ? "team" : "plus";
}

function ZcodeMark({ level, size = 13 }: { level: string | null | undefined; size?: number }) {
  const mark = tierMark(level);
  if (!mark) return null;
  return (
    <span className="acc-mark" style={{ color: `var(${mark.colorVar})` }} title={formatLevel(level) ?? undefined}>
      <Crown size={size} fill={mark.solid ? "currentColor" : "none"} />
    </span>
  );
}

/** Tokens left across every entitlement on the snapshot. */
function totalRemaining(plan: ZcodePlanInfo | null | undefined): number | null {
  if (!plan?.balances?.length) return null;
  return plan.balances.reduce((sum, b) => sum + (b.remaining_units ?? 0), 0);
}

/** The plan a snapshot is on, preferring an active one over a lapsed one. */
function primaryPlan(plan: ZcodePlanInfo | null | undefined) {
  if (!plan?.plans?.length) return null;
  return plan.plans.find((p) => p.status === "active") ?? plan.plans[0];
}

/**
 * Z.ai / ZCode sign-in snapshots, laid out exactly like the Codex and Claude
 * account tabs: searchless account list on the left, detail card on the right,
 * same `.workbench` / `.acc-row` / `.dcard` classes.
 */
export function ZcodePanel({
  language,
  onAccountsChange,
  looks,
  onLookChange,
}: {
  language: "ru" | "en";
  onAccountsChange?: (accounts: ZcodeAccountInfo[]) => void;
  /** Shared with the Codex and Claude lists so one store owns every mark. */
  looks: Record<string, AccountLook>;
  onLookChange: (accountId: string, next: AccountLook) => void;
}) {
  const ru = language === "ru";
  const [items, setItems] = useState<ZcodeAccountInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const cancelNameRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await invokeBackend<ZcodeAccountInfo[]>("list_zcode_accounts");
      setItems(list);
      onAccountsChange?.(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [onAccountsChange]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await f();
      await load();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const selected = items.find((a) => a.id === selectedId) ?? items.find((a) => a.is_active) ?? items[0] ?? null;

  useEffect(() => {
    setNameDraft(selected?.name ?? "");
    setEditingName(false);
  }, [selected?.id, selected?.name]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  const commitName = () => {
    setEditingName(false);
    if (!selected) return;
    if (cancelNameRef.current) {
      cancelNameRef.current = false;
      setNameDraft(selected.name);
      return;
    }
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === selected.name) {
      setNameDraft(selected.name);
      return;
    }
    void run(selected.id, () => invokeBackend("rename_zcode_account", { id: selected.id, name: trimmed }));
  };

  const importFromFile = async () => {
    const path = await pickZcodeCredentialsFile();
    if (!path) return;
    const suggested = ru_en(ru, "Импорт", "Imported") + " " + new Date().toLocaleDateString(ru ? "ru-RU" : "en-GB");
    const name = window.prompt(ru_en(ru, "Название для импортированного аккаунта", "Name for the imported account"), suggested);
    if (!name?.trim()) return;
    await run("import", () => invokeBackend("import_zcode_account_from_file", { name: name.trim(), path }));
  };

  const capture = async () => {
    const name = draftName.trim();
    if (!name) return;
    const ok = await run("capture", () => invokeBackend("capture_zcode_account", { name }));
    if (ok) {
      setDraftName("");
      setCapturing(false);
    }
  };

  const menuTarget = menu ? items.find((a) => a.id === menu.id) ?? null : null;

  return (
    <div className="workbench">
      {menuTarget && menu && (
        <>
          <div className="ctx-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="ctx"
            role="menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 210),
              top: Math.min(menu.y, window.innerHeight - 190),
            }}
          >
            <div className="ctx-head">{menuTarget.name}</div>
            <button
              type="button"
              className="ctx-item"
              role="menuitem"
              disabled={menuTarget.is_active || busy !== null}
              onClick={() => {
                setMenu(null);
                void run(menuTarget.id, () => invokeBackend("activate_zcode_account", { id: menuTarget.id }));
              }}
            >
              <Zap size={14} /> {menuTarget.is_active ? ru_en(ru, "Активен", "Active") : ru_en(ru, "Переключить", "Switch")}
            </button>
            <button type="button" className="ctx-item" role="menuitem" onClick={() => { setMenu(null); setSelectedId(menuTarget.id); setEditingName(true); }}>
              <PencilLine size={14} /> {ru_en(ru, "Переименовать", "Rename")}
            </button>
            <button
              type="button"
              className="ctx-item"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => {
                setMenu(null);
                void run(menuTarget.id, () => invokeBackend("capture_zcode_account", { name: `${menuTarget.name} ${new Date().toLocaleTimeString(ru ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" })}` }));
              }}
              title={ru_en(ru, "Сохранить текущий вход ZCode как новый снимок", "Save the current ZCode sign-in as a new snapshot")}
            >
              <Plus size={14} /> {ru_en(ru, "Снять текущий вход", "Capture current sign-in")}
            </button>
            <div className="ctx-sep" />
            <button type="button" className="ctx-item" role="menuitem" onClick={() => { setMenu(null); void load(); }}>
              <RefreshCcw size={14} /> {ru_en(ru, "Обновить", "Refresh")}
            </button>
            <div className="ctx-sep" />
            <LookPicker
              look={looks[menuTarget.id]}
              ru={ru}
              onChange={(next) => onLookChange(menuTarget.id, next)}
            />
            <div className="ctx-sep" />
            <button
              type="button"
              className="ctx-item ctx-item--danger"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                if (!confirm(ru_en(ru, `Удалить «${menuTarget.name}»?`, `Delete "${menuTarget.name}"?`))) return;
                void run(menuTarget.id, () => invokeBackend("delete_zcode_account", { id: menuTarget.id }));
              }}
            >
              <Trash2 size={14} /> {ru_en(ru, "Удалить", "Delete")}
            </button>
          </div>
        </>
      )}
      {/* Left column: snapshot list */}
      <div className="col-list">
        <div className="list-head">
          <div className="filters">
            <span className="chip is-active" style={{ pointerEvents: "none" }}>
              <Boxes size={12} /> ZCode
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="chip" title={ru_en(ru, "Обновить", "Reload")} onClick={() => void load()}>
              <RefreshCcw size={12} />
            </button>
            <button
              type="button"
              className="chip"
              disabled={busy !== null}
              title={ru_en(ru, "Импортировать credentials.json", "Import a credentials.json")}
              onClick={() => void importFromFile()}
            >
              {busy === "import" ? <Loader2 size={12} className="spin" /> : <Upload size={12} />}
            </button>
            <button
              type="button"
              className={"chip chip--add" + (capturing ? " is-active" : "")}
              onClick={() => setCapturing((v) => !v)}
              title={ru_en(ru, "Сохранить текущий вход ZCode", "Capture the current ZCode sign-in")}
            >
              {capturing ? <X size={12} /> : <Plus size={12} />} {ru_en(ru, "аккаунт", "account")}
            </button>
          </div>
          {capturing && (
            <div className="search">
              <FolderInput size={14} />
              <input
                autoFocus
                value={draftName}
                placeholder={ru_en(ru, "имя текущего аккаунта…", "current account name…")}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void capture();
                  if (e.key === "Escape") { setCapturing(false); setDraftName(""); }
                }}
              />
              <button
                type="button"
                className="icon-btn icon-btn--xs"
                disabled={!draftName.trim() || busy !== null}
                onClick={() => void capture()}
              >
                {busy === "capture" ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
              </button>
            </div>
          )}
        </div>

        <div className="acc-list">
          {error && (
            <div style={{ padding: "12px 16px", color: "var(--bad)", fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          {items.length === 0 ? (
            <div style={{ padding: "26px 16px", color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.8 }}>
              <div style={{ color: "var(--text-2)", marginBottom: 8 }}>{ru_en(ru, "Снимков пока нет.", "No snapshots yet.")}</div>
              {ru_en(
                ru,
                "«+ аккаунт» сохраняет вход, в котором ZCode находится прямо сейчас. Кнопка импорта берёт готовый credentials.json — он лежит в ~/.zcode/v2 рядом с config.json, оба нужны для входа.",
                "“+ account” saves the sign-in ZCode is on right now. The import button takes an existing credentials.json — it sits in ~/.zcode/v2 next to config.json, and both are needed to sign in."
              )}
            </div>
          ) : (
            items.map((a) => {
              const dot = a.is_active ? "var(--accent)" : "var(--text-3)";
              const tint = colorHex(looks[a.id]?.color);
              return (
                <button
                  type="button"
                  key={a.id}
                  className={[
                    "acc-row",
                    selected?.id === a.id ? "is-selected" : "",
                    a.is_active ? "is-active-acc" : "",
                  ].join(" ")}
                  data-tier={zcodeTierName(a.plan?.level)}
                  data-tinted={tint ? "" : undefined}
                  style={tint ? ({ "--tint": tint } as CSSProperties) : undefined}
                  onClick={() => setSelectedId(a.id)}
                  onContextMenu={(event: ReactMouseEvent) => {
                    event.preventDefault();
                    setSelectedId(a.id);
                    setMenu({ id: a.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <span className="acc-gutter">
                    <span
                      className={"st-dot" + (a.is_active ? " st-dot--pulse" : "")}
                      style={{ width: 7, height: 7, background: dot, color: dot }}
                    />
                  </span>
                  <span className="acc-main">
                    <span className="acc-top">
                      <LookIcon icon={looks[a.id]?.icon} color={tint} />
                      <span className="acc-name">{a.name}</span>
                      <ZcodeMark level={a.plan?.level} />
                    </span>
                    <span className="acc-sub">
                      {formatLevel(a.plan?.level) ?? primaryPlan(a.plan)?.name ?? formatDate(a.created_at, ru)}
                    </span>
                  </span>
                  <span className="acc-right">
                    {(() => {
                      // Token grants first; an account on a tier with no grants
                      // still has an MCP quota worth showing. Neither means the
                      // snapshot has never been live, so show nothing at all.
                      const tokens = totalRemaining(a.plan);
                      if (tokens !== null) {
                        return (
                          <>
                            <span className="acc-pct" style={{ color: a.is_active ? "var(--accent)" : "var(--text)" }}>
                              {formatUnits(tokens)}
                            </span>
                            <span className="acc-sub" style={{ fontSize: 10 }}>{ru_en(ru, "токенов", "tokens")}</span>
                          </>
                        );
                      }
                      if (a.plan?.mcp_limit) {
                        return (
                          <>
                            <span className="acc-pct" style={{ color: a.is_active ? "var(--accent)" : "var(--text)" }}>
                              {formatUnits(a.plan.mcp_limit - (a.plan.mcp_used ?? 0))}
                            </span>
                            <span className="acc-sub" style={{ fontSize: 10 }}>MCP</span>
                          </>
                        );
                      }
                      return null;
                    })()}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right column: detail card */}
      <div className="col-detail">
        {!selected ? (
          <div className="detail-empty">
            <div style={{ textAlign: "center" }}>
              <Boxes size={32} style={{ opacity: 0.4, marginBottom: 10 }} />
              <div>
                {ru_en(
                  ru,
                  "войдите в нужный аккаунт в ZCode и сохраните снимок",
                  "sign in to an account in ZCode, then capture a snapshot"
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="detail">
            <div
              className="dcard"
              data-tinted={colorHex(looks[selected.id]?.color) ? "" : undefined}
              style={colorHex(looks[selected.id]?.color) ? ({ "--tint": colorHex(looks[selected.id]?.color) } as CSSProperties) : undefined}
            >
              <div className={"dcard-bar " + (selected.is_active ? "dcard-bar--accent" : "dcard-bar--ok")} />

              <div className="dhead">
                <span
                  className={"st-dot" + (selected.is_active ? " st-dot--pulse" : "")}
                  style={{
                    width: 9,
                    height: 9,
                    marginTop: 7,
                    flexShrink: 0,
                    background: selected.is_active ? "var(--accent)" : "var(--text-3)",
                    color: selected.is_active ? "var(--accent)" : "var(--text-3)",
                  }}
                />

                <div className="dhead-main">
                  <div className="dhead-eyebrow">
                    {selected.is_active
                      ? <><Check size={12} /> {ru_en(ru, "Текущий вход ZCode", "Current ZCode sign-in")}</>
                      : <>Z.ai · {ru_en(ru, "снимок входа", "sign-in snapshot")}</>}
                  </div>
                  <div className="dhead-name dhead-name-row">
                    {editingName ? (
                      <input
                        ref={nameInputRef}
                        className="dhead-name-edit"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={commitName}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); nameInputRef.current?.blur(); }
                          else if (e.key === "Escape") { e.preventDefault(); cancelNameRef.current = true; nameInputRef.current?.blur(); }
                        }}
                      />
                    ) : (
                      <>
                        <LookIcon icon={looks[selected.id]?.icon} size={18} color={colorHex(looks[selected.id]?.color)} />
                        <button type="button" className="dhead-name-btn" onClick={() => setEditingName(true)} title={ru_en(ru, "Переименовать", "Rename")}>
                          <span>{selected.name}</span>
                          <PencilLine size={15} className="edit-pencil" />
                        </button>
                        <ZcodeMark level={selected.plan?.level} size={18} />
                      </>
                    )}
                  </div>

                  <div className="dhead-tags">
                    {selected.is_active && (
                      <span className="tag tag--accent">
                        <span className="tag-dot" style={{ background: "var(--accent)" }} />
                        {ru_en(ru, "АКТИВНЫЙ", "ACTIVE")}
                      </span>
                    )}
                    <span className="tag tag--neutral">
                      <Boxes size={11} /> Z.ai / ZCode
                    </span>
                  </div>
                </div>

                <div className="dhead-actions">
                  {selected.is_active ? (
                    <button type="button" className="btn btn--ghost btn--md" disabled>
                      <Check size={15} /> {ru_en(ru, "Активен", "Active")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary btn--md"
                      disabled={busy !== null}
                      onClick={async () => {
                        const ok = await run(selected.id, () => invokeBackend("activate_zcode_account", { id: selected.id }));
                        if (ok) {
                          setNotice(ru_en(ru, "ZCode перезапущен с новым аккаунтом.", "ZCode restarted with the new account."));
                          setTimeout(() => setNotice(null), 3000);
                        }
                      }}
                    >
                      {busy === selected.id ? <RefreshCcw size={15} className="spin" /> : <Zap size={15} />}
                      {busy === selected.id ? ru_en(ru, "Переключение…", "Switching…") : ru_en(ru, "Переключить", "Switch")}
                    </button>
                  )}
                </div>
              </div>

              {error && (
                <div className="banner banner--bad">
                  <X size={17} />
                  <div className="banner-txt" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{error}</div>
                </div>
              )}
              {notice && (
                <div className="banner banner--warn">
                  <Check size={17} />
                  <div className="banner-txt">{notice}</div>
                </div>
              )}

              <div className="dbody">
                <div className="dbody-col">
                  <div className="sec-label">
                    <span className="sec-label-txt"><span className="sec-label-mark">//</span>{ru_en(ru, "Подписка и токены", "Plan and tokens")}</span>
                    <span className="sec-label-rule" />
                  </div>
                  {selected.plan?.level || selected.plan?.balances?.length || selected.plan?.plans?.length ? (
                    <div className="limit-block">
                      {selected.plan.level && (
                        <div className="limit-item">
                          <div className="limit-top">
                            <span className="limit-label">{ru_en(ru, "Тариф", "Tier")}</span>
                            <span
                              className="limit-pct"
                              style={{ color: `var(${tierMark(selected.plan.level)?.colorVar ?? "--text"})`, display: "inline-flex", alignItems: "center", gap: 6 }}
                            >
                              <ZcodeMark level={selected.plan.level} size={14} />
                              {formatLevel(selected.plan.level)}
                            </span>
                          </div>
                        </div>
                      )}
                      {selected.plan.mcp_limit ? (() => {
                        const left = (selected.plan.mcp_limit ?? 0) - (selected.plan.mcp_used ?? 0);
                        const pct = Math.max(0, Math.min(100, (left / (selected.plan.mcp_limit || 1)) * 100));
                        return (
                          <div className="limit-item">
                            <div className="limit-top">
                              {/* Named the way ZCode names it, so the two can be
                                  compared without translating between them. */}
                              <span className="limit-label">ZCode MCP</span>
                              <span className="limit-pct">{Math.round(pct)}%</span>
                            </div>
                            <span className="meter" style={{ height: 6 }}>
                              <span
                                className={"meter-fill meter-fill--" + (pct <= 15 ? "amber" : "accent")}
                                style={{ width: Math.max(2, pct) + "%" }}
                              />
                            </span>
                            <div className="limit-eta">
                              <Coins size={12} /> {formatUnits(left)} {ru_en(ru, "из", "of")} {formatUnits(selected.plan.mcp_limit)}
                              {selected.plan.mcp_next_refresh_at
                                ? ` · ${ru_en(ru, "сброс", "resets")} ${formatRefreshAt(selected.plan.mcp_next_refresh_at, ru)}`
                                : ""}
                            </div>
                          </div>
                        );
                      })() : null}
                      {selected.plan.plans.map((plan) => (
                        <div className="limit-item" key={plan.name + String(plan.ends_at)}>
                          <div className="limit-top">
                            <span className="limit-label">{plan.name}</span>
                            <span className="limit-pct" style={{ fontSize: 12, color: plan.status === "active" ? "var(--ok)" : "var(--text-3)" }}>
                              {plan.status === "active" ? ru_en(ru, "активна", "active") : plan.status}
                            </span>
                          </div>
                          <div className="limit-eta">
                            <Clock size={12} /> {formatEndsAt(plan.ends_at, ru)}
                          </div>
                        </div>
                      ))}
                      {selected.plan.balances.map((balance) => {
                        const total = balance.total_units ?? 0;
                        const left = balance.remaining_units ?? 0;
                        const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : null;
                        return (
                          <div className="limit-item" key={balance.show_name + String(balance.total_units)}>
                            <div className="limit-top">
                              <span className="limit-label">{balance.show_name}</span>
                              <span className="limit-pct" style={{ fontSize: 14 }}>
                                {formatUnits(left)}
                              </span>
                            </div>
                            <span className="meter" style={{ height: 6 }}>
                              <span
                                className={"meter-fill meter-fill--" + (pct !== null && pct <= 15 ? "amber" : "accent")}
                                style={{ width: (pct !== null ? Math.max(2, pct) : 2) + "%" }}
                              />
                            </span>
                            <div className="limit-eta">
                              <Coins size={12} /> {ru_en(ru, "из", "of")} {formatUnits(balance.total_units)} · {ru_en(ru, "потрачено", "used")} {formatUnits(balance.used_units)}
                            </div>
                          </div>
                        );
                      })}
                      <p className="token-hint" style={{ margin: "2px 0 0" }}>
                        {ru_en(
                          ru,
                          "Окна «5 hours» и «Weekly» из ZCode здесь не показать: ZCode держит их только в памяти, на диск не пишет, а эндпоинт за капчей. Сверяйся с ними в самом ZCode.",
                          "ZCode's “5 hours” and “Weekly” windows cannot be shown here: ZCode keeps them in memory only, never writes them to disk, and the endpoint is behind a captcha. Check those in ZCode itself."
                        )}
                      </p>
                    </div>
                  ) : (
                    <p className="token-hint" style={{ margin: 0 }}>
                      {selected.plan?.captured_at
                        ? ru_en(
                            ru,
                            `Z.ai не вернула ни одного активного плана (проверено ${formatDate(selected.plan.captured_at, ru)}). Купи или продли Coding Plan — цифры появятся сами.`,
                            `Z.ai reported no active plan (checked ${formatDate(selected.plan.captured_at, ru)}). Buy or renew a Coding Plan and the figures appear on their own.`
                          )
                        : ru_en(
                            ru,
                            "Данных о подписке нет. Цифры берутся из того, что ZCode уже запросил у Z.ai — переключись на этот аккаунт и дай ZCode запуститься.",
                            "No plan data yet. The figures come from what ZCode has already fetched from Z.ai — switch to this account and let ZCode run."
                          )}
                    </p>
                  )}
                </div>

                <div className="dbody-col">
                  <div className="sec-label">
                    <span className="sec-label-txt"><span className="sec-label-mark">//</span>{ru_en(ru, "Параметры", "Details")}</span>
                    <span className="sec-label-rule" />
                  </div>
                  <div className="meta">
                    <div className="meta-row">
                      <span className="meta-key">{ru_en(ru, "Статус", "Status")}</span>
                      <span className="meta-val" style={{ color: selected.is_active ? "var(--accent)" : undefined }}>
                        {selected.is_active ? ru_en(ru, "активен", "active") : ru_en(ru, "припаркован", "parked")}
                      </span>
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">{ru_en(ru, "Снимок создан", "Captured")}</span>
                      <span className="meta-val">{formatDate(selected.created_at, ru)}</span>
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">{ru_en(ru, "Хранилище", "Storage")}</span>
                      <span className="meta-val">~/.zcode/v2</span>
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">{ru_en(ru, "Тариф", "Tier")}</span>
                      <span className="meta-val" style={selected.plan?.level ? { color: `var(${tierMark(selected.plan.level)?.colorVar ?? "--text"})` } : undefined}>
                        {formatLevel(selected.plan?.level) ?? "—"}
                      </span>
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">{ru_en(ru, "Токенов всего", "Tokens left")}</span>
                      <span className="meta-val">{formatUnits(totalRemaining(selected.plan))}</span>
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">{ru_en(ru, "Секреты", "Secrets")}</span>
                      <span className="meta-val">{ru_en(ru, "шифрует ZCode", "encrypted by ZCode")}</span>
                    </div>
                  </div>
                  <p className="token-hint" style={{ marginTop: 14 }}>
                    {ru_en(
                      ru,
                      "Переключение закрывает ZCode, подменяет credentials.json и config.json снимком этого аккаунта и запускает ZCode заново.",
                      "Switching closes ZCode, swaps credentials.json and config.json for this snapshot, then starts ZCode again."
                    )}
                  </p>
                </div>
              </div>

              <div className="dfoot">
                <button type="button" className="btn btn--ghost btn--md" disabled={busy !== null} onClick={() => void load()}>
                  <RefreshCcw size={14} /> {ru_en(ru, "Обновить", "Refresh")}
                </button>
                <span className="dfoot-note">
                  <Clock size={13} />
                  {ru_en(ru, "снимок того же ПК — секреты привязаны к устройству", "same-device snapshot — secrets are device-bound")}
                </span>
                <span className="dfoot-spacer" />
                <button
                  type="button"
                  className="icon-btn icon-btn--md"
                  title={ru_en(ru, "Удалить", "Delete")}
                  disabled={busy !== null}
                  onClick={() => {
                    if (!confirm(ru_en(ru, `Удалить «${selected.name}»?`, `Delete "${selected.name}"?`))) return;
                    void run(selected.id, () => invokeBackend("delete_zcode_account", { id: selected.id }));
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
