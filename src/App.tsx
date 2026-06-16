import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
} from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderInput,
  KeyRound,
  Monitor,
  Moon,
  PencilLine,
  RefreshCcw,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Upload,
  UserRound,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useAccounts } from "./hooks/useAccounts";
import { AddAccountModal, UpdateChecker, ClaudeTokenPanel } from "./components";
import type { AccountWithUsage, UsageInfo } from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  isTauriRuntime,
} from "./lib/platform";
import { getPlanVisual } from "./lib/accountVisuals";
import {
  getEffectiveRemainingPercent,
  getUsageRemaining,
  getVisibleLimitWindows,
  hasRecoverableAuthError,
} from "./lib/usageModel";
import {
  getSystemLocale,
  getSystemTheme,
  translations,
  type AppText,
  type LanguagePreference,
  type Locale,
  type ThemeMode,
  type ThemePreference,
} from "./i18n";
import "./App.css";

const THEME_STORAGE_KEY = "codex-switcher-theme";
const LANGUAGE_STORAGE_KEY = "codex-switcher-language";
const ACCENT_STORAGE_KEY = "codex-switcher-accent";
const WINDOW_SIZE_STORAGE_KEY = "codex-switcher-window-size";
const CARD_DENSITY_STORAGE_KEY = "codex-switcher-card-density";
const TRAY_MODE_STORAGE_KEY = "codex-switcher-tray-mode";
const AUTO_WARMUP_ALL_STORAGE_KEY = "codex-switcher-auto-warmup-all";
const AUTO_WARMUP_ACCOUNTS_STORAGE_KEY = "codex-switcher-auto-warmup-accounts";
const AUTO_WARMUP_LEDGER_STORAGE_KEY = "codex-switcher-auto-warmup-last-success";
const AUTO_WARMUP_CHECK_INTERVAL_MS = 30 * 1000;
const AUTO_WARMUP_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES = 5;
const DEFAULT_PRIMARY_WINDOW_MINUTES = 300;
const LIMIT_FULL_THRESHOLD = 99.5;
const NEAR_LIMIT_REMAINING_THRESHOLD = 10;

type AccentPreset = "green" | "cyan" | "blue" | "amber" | "rose";
type AutoWarmupLedger = Record<string, { lastSuccessfulWarmupAt?: number }>;
type ProviderTab = "codex" | "claude";
type ConfigModalMode = "slim_export" | "slim_import";
type CardDensity = "compact" | "comfortable" | "detailed";
type StatusFilter = "all" | "ready" | "limit" | "error";
type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const currentWindow = isTauriRuntime() ? getCurrentWindow() : null;
const isMacOs =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);

const accentPresets: Record<
  AccentPreset,
  { label: string; accent: string; soft: string; strong: string; border: string; glow: string; contrast: string }
> = {
  green:  { label: "Signal green",  accent: "#18a872", soft: "rgba(24,168,114,.15)", strong: "rgba(24,168,114,.24)", border: "rgba(24,168,114,.32)", glow: "rgba(24,168,114,.2)",  contrast: "#f7fffb" },
  cyan:   { label: "Cyan glass",    accent: "#18a0c8", soft: "rgba(24,160,200,.15)", strong: "rgba(24,160,200,.24)", border: "rgba(24,160,200,.32)", glow: "rgba(24,160,200,.2)",  contrast: "#f7fdff" },
  blue:   { label: "Control blue",  accent: "#3e7ce9", soft: "rgba(62,124,233,.15)", strong: "rgba(62,124,233,.24)", border: "rgba(62,124,233,.32)", glow: "rgba(62,124,233,.2)",  contrast: "#f8fbff" },
  amber:  { label: "Amber focus",   accent: "#d88b22", soft: "rgba(216,139,34,.16)", strong: "rgba(216,139,34,.24)", border: "rgba(216,139,34,.34)", glow: "rgba(216,139,34,.2)",  contrast: "#211305" },
  rose:   { label: "Rose pulse",    accent: "#d15a7d", soft: "rgba(209,90,125,.16)", strong: "rgba(209,90,125,.24)", border: "rgba(209,90,125,.34)", glow: "rgba(209,90,125,.21)", contrast: "#fff8fb" },
};

const cardDensityLabels: Record<CardDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  detailed: "Detailed",
};

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const s = window.localStorage.getItem(THEME_STORAGE_KEY);
    return s === "light" || s === "dark" || s === "system" ? s : "system";
  } catch { return "system"; }
}

function readLanguagePreference(): LanguagePreference {
  if (typeof window === "undefined") return "system";
  try {
    const s = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return s === "en" || s === "ru" || s === "system" ? s : "system";
  } catch { return "system"; }
}

function readStoredStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_WARMUP_LEDGER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, v]) => {
          const ts = v && typeof v === "object" && "lastSuccessfulWarmupAt" in v && typeof (v as { lastSuccessfulWarmupAt: unknown }).lastSuccessfulWarmupAt === "number"
            ? (v as { lastSuccessfulWarmupAt: number }).lastSuccessfulWarmupAt
            : undefined;
          return ts ? [id, { lastSuccessfulWarmupAt: ts }] : null;
        })
        .filter((e): e is [string, { lastSuccessfulWarmupAt: number }] => Boolean(e))
    );
  } catch { return {}; }
}

function resolveThemePreference(p: ThemePreference): ThemeMode {
  return p === "system" ? getSystemTheme() : p;
}

function resolveLanguagePreference(p: LanguagePreference): Locale {
  return p === "system" ? getSystemLocale() : p;
}

function formatResetWindowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes || minutes === 300) return fallback;
  if (minutes < 60) return `${minutes}m reset`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h reset`;
  return `${Math.floor(h / 24)}d reset`;
}

function isLimitFull(pct: number | null | undefined): boolean {
  return pct !== null && pct !== undefined && pct >= LIMIT_FULL_THRESHOLD;
}

function getPrimaryWindowMinutes(usage: UsageInfo): number {
  return usage.primary_window_minutes ?? DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function getPrimaryRemainingMs(usage: UsageInfo): number | null {
  if (!usage.primary_resets_at) return null;
  return usage.primary_resets_at * 1000 - Date.now();
}

function isPrimaryFullWindow(usage: UsageInfo): boolean {
  const ms = getPrimaryRemainingMs(usage);
  if (ms === null) return false;
  const threshold = Math.max(0, getPrimaryWindowMinutes(usage) - AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES);
  return ms >= threshold * 60 * 1000;
}

function getLastSuccessfulWarmupAt(ledger: AutoWarmupLedger, id: string): number | undefined {
  return ledger[id]?.lastSuccessfulWarmupAt;
}

function getRemainingPercent(account: AccountWithUsage) {
  return getEffectiveRemainingPercent(account);
}

function getLimitTone(remaining: number | null): "success" | "warning" | "danger" | "muted" {
  if (remaining === null) return "muted";
  if (remaining <= 0) return "danger";
  if (remaining <= NEAR_LIMIT_REMAINING_THRESHOLD) return "warning";
  return "success";
}

function formatResetCountdown(resetAt: number | null | undefined, locale: Locale): string {
  const t = translations[locale];
  if (!resetAt) return t.common.unknown;
  const diff = resetAt - Math.floor(Date.now() / 1000);
  if (diff <= 0) return t.common.now;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatAuthTokenCountdown(expiresAt: string | null | undefined, locale: Locale): {
  label: string; tone: "warning" | "danger" | "muted";
} {
  const t = translations[locale];
  if (!expiresAt) return { label: t.account.authTokenUnknown, tone: "muted" };
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return { label: t.account.authTokenUnknown, tone: "muted" };
  if (remainingMs <= 0) return { label: t.account.authTokenExpired, tone: "danger" };
  const secs = Math.floor(remainingMs / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const countdown = secs < 60 ? `${s}s` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { label: `${t.account.authTokenRefreshIn} ${countdown}`, tone: remainingMs <= 5 * 60 * 1000 ? "warning" : "muted" };
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return "—";
  const diff = Math.floor((Date.now() - new Date(lastUsedAt).getTime()) / 1000);
  if (diff < 5) return "сейчас";
  if (diff < 60) return `${diff}с`;
  if (diff < 3600) return `${Math.floor(diff / 60)}м`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}ч`;
  return `${Math.floor(diff / 86400)}дн`;
}

function isRateLimitedUsage(account: AccountWithUsage): boolean {
  return Boolean(account.usage?.rate_limited) || Boolean(account.usageWarning);
}

function getAccountHealthTone(account: AccountWithUsage): "success" | "warning" | "danger" | "muted" {
  if (account.usage?.error) return isRateLimitedUsage(account) ? "warning" : "danger";
  const r = getRemainingPercent(account);
  if (r === null) return "muted";
  if (r <= 0) return "danger";
  if (r <= NEAR_LIMIT_REMAINING_THRESHOLD) return "warning";
  return "success";
}

function getRowStatus(account: AccountWithUsage): StatusFilter {
  if (account.usage?.error && !isRateLimitedUsage(account)) return "error";
  const r = getRemainingPercent(account);
  if (r !== null && r <= 0) return "limit";
  return "ready";
}

function getInitials(name: string): string {
  return name.replace(/[^a-zA-Zа-яА-Я0-9]/g, "").slice(0, 2).toUpperCase() || "··";
}

function getMeterTone(remaining: number | null): string {
  if (remaining === null) return "accent";
  if (remaining <= 0) return "amber";
  if (remaining <= 30) return "amber";
  return "green";
}

function getDotColor(tone: "success" | "warning" | "danger" | "muted"): string {
  if (tone === "success") return "var(--ok)";
  if (tone === "warning") return "var(--warn)";
  if (tone === "danger") return "var(--bad)";
  return "var(--text-3)";
}

function getBarClass(tone: "success" | "warning" | "danger" | "muted"): string {
  if (tone === "warning") return "dcard-bar dcard-bar--warn";
  if (tone === "danger") return "dcard-bar dcard-bar--bad";
  if (tone === "success") return "dcard-bar dcard-bar--ok";
  return "dcard-bar dcard-bar--accent";
}

function getActiveResetItems(account: AccountWithUsage, locale: Locale) {
  const t = translations[locale];
  return getVisibleLimitWindows(account).map((w) => ({
    key: w.key,
    label: w.kind === "primary"
      ? formatResetWindowLabel(w.windowMinutes, t.account.reset5h)
      : w.kind === "rolling"
        ? formatResetWindowLabel(w.windowMinutes, t.account.reset)
        : t.account.reset7d,
    resetsAt: w.resetsAt,
    remaining: getUsageRemaining(w.usedPercent),
    tone: getLimitTone(getUsageRemaining(w.usedPercent)),
  }));
}

// ── Account Row (left panel list item) ────────────────────────────────────────
function AccountListRow({
  account,
  selected,
  isActiveAcc,
  masked,
  onClick,
}: {
  account: AccountWithUsage;
  selected: boolean;
  isActiveAcc: boolean;
  masked: boolean;
  onClick: () => void;
}) {
  const tone = getAccountHealthTone(account);
  const remaining = getRemainingPercent(account);
  const planVisual = getPlanVisual(account);
  const initials = account.provider === "claude" ? "CL" : getInitials(account.name);
  const dotColor = account.is_active ? "var(--accent)" : getDotColor(tone);
  const isPulse = account.is_active || tone === "warning";

  const maskEmail = (email: string) => {
    if (!masked) return email;
    const [u, d] = email.split("@");
    if (!u || !d) return email;
    return u.slice(0, 2) + "•".repeat(Math.max(3, u.length - 2)) + "@" + d;
  };

  return (
    <button
      type="button"
      className={[
        "acc-row",
        selected ? "is-selected" : "",
        isActiveAcc ? "is-active-acc" : "",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="acc-avatar">
        {initials}
        <span
          className={"st-dot" + (isPulse ? " st-dot--pulse" : "")}
          style={{ width: 9, height: 9, background: dotColor, color: dotColor }}
        />
      </span>
      <span className="acc-main">
        <span className="acc-top">
          <span className="acc-name">{account.name}</span>
          <span className={"tag " + (planVisual.premium ? "tag--accent" : "tag--neutral")}>
            {planVisual.shortLabel}
          </span>
        </span>
        {account.email && (
          <span className="acc-sub">{maskEmail(account.email)}</span>
        )}
      </span>
      <span className="acc-right">
        {account.usage?.error ? (
          account.usage?.rate_limited ? (
            <span className="acc-pct" style={{ color: "var(--warn)", fontSize: 10 }}>
              НЕ ОБНОВЛЕНО
            </span>
          ) : (
            <span className="acc-pct" style={{ color: "var(--bad)", fontSize: 11 }}>
              СБОЙ
            </span>
          )
        ) : (
          <>
            <span className="acc-pct" style={{ color: remaining !== null && remaining <= 15 ? "var(--warn)" : "var(--text)" }}>
              {remaining !== null ? `${Math.round(remaining)}%` : "—"}
            </span>
            <span className="acc-meter">
              <span className="meter" style={{ height: 4 }}>
                <span
                  className={"meter-fill meter-fill--" + getMeterTone(remaining)}
                  style={{ width: Math.max(2, remaining ?? 0) + "%" }}
                />
              </span>
            </span>
          </>
        )}
      </span>
    </button>
  );
}

// ── Account Detail Panel (right panel) ────────────────────────────────────────
function AccountDetailPanel({
  account,
  masked,
  onToggleMask,
  onCopyEmail,
  emailCopied,
  switching,
  warmingUp,
  autoWarmupEnabled,
  autoWarmupLabel,
  onSwitch,
  onWarmup,
  onRefresh,
  onDelete,
  onRename,
  onToggleAutoWarmup,
  onReauthorize,
  locale,
  t,
}: {
  account: AccountWithUsage;
  masked: boolean;
  onToggleMask: () => void;
  onCopyEmail: () => void;
  emailCopied: boolean;
  switching: boolean;
  warmingUp: boolean;
  autoWarmupEnabled: boolean;
  autoWarmupLabel: string;
  onSwitch: () => void;
  onWarmup: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  onRename: (newName: string) => Promise<void>;
  onToggleAutoWarmup: () => void;
  onReauthorize?: () => void;
  locale: Locale;
  t: AppText;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(account.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Set when Escape is pressed so the resulting blur cancels instead of saving.
  const cancelNameRef = useRef(false);

  // Reset the editor when a different account is selected.
  useEffect(() => {
    setNameDraft(account.name);
    setEditingName(false);
  }, [account.id, account.name]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  // Single commit path: Enter and Escape both blur the input, so save/cancel
  // always flow through here exactly once (no Enter+blur double fire).
  const commitName = () => {
    setEditingName(false);
    if (cancelNameRef.current) {
      cancelNameRef.current = false;
      setNameDraft(account.name);
      return;
    }
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === account.name) {
      setNameDraft(account.name);
      return;
    }
    void onRename(trimmed).catch(() => setNameDraft(account.name));
  };

  const tone = getAccountHealthTone(account);
  const remaining = getRemainingPercent(account);
  const planVisual = getPlanVisual(account);
  const initials = account.provider === "claude" ? "CL" : getInitials(account.name);
  const isCodex = account.provider === "codex";
  const resetItems = getActiveResetItems(account, locale);
  const tokenExpiry = formatAuthTokenCountdown(account.auth_token_expires_at, locale);
  const needsReauth = account.auth_mode === "chat_g_p_t" && hasRecoverableAuthError(account.usage);

  const maskEmail = (email: string) => {
    if (!masked) return email;
    const [u, d] = email.split("@");
    if (!u || !d) return email;
    return u.slice(0, 2) + "•".repeat(Math.max(3, u.length - 2)) + "@" + d;
  };

  const dotColor = account.is_active ? "var(--accent)" : getDotColor(tone);
  const barClass = getBarClass(account.is_active ? "success" : tone);

  const limitLevel = isCodex
    ? (account.usage?.plan_type || account.plan_type || "—")
    : (account.claude_rate_limit_tier || "—");

  const orgValue = isCodex ? "—" : (account.claude_organization_uuid
    ? account.claude_organization_uuid.length > 20
      ? account.claude_organization_uuid.slice(0, 20) + "…"
      : account.claude_organization_uuid
    : "—");

  return (
    <div className="detail">
      <div className="dcard">
        <div className={barClass} />

        <div className="dhead">
          <div className="dhead-id">
            {initials}
            <span
              className={"st-dot" + (account.is_active ? " st-dot--pulse" : "")}
              style={{ width: 11, height: 11, background: dotColor, color: dotColor }}
            />
          </div>

          <div className="dhead-main">
            <div className="dhead-eyebrow">
              {account.is_active
                ? <><Check size={12} /> {t.account.currentAccount}</>
                : <>{planVisual.label} · {t.account.currentAccount.replace("Текущий", "").trim() || "аккаунт"}</>
              }
            </div>
            <div className="dhead-name">
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
                <button
                  type="button"
                  className="dhead-name-btn"
                  onClick={() => setEditingName(true)}
                  title={t.account.rename}
                >
                  <span>{account.name}</span>
                  <PencilLine size={15} className="edit-pencil" />
                </button>
              )}
            </div>

            {account.email && (
              <div className="dhead-email">
                <UserRound size={13} />
                <span>{maskEmail(account.email)}</span>
                <button type="button" className="icon-btn icon-btn--xs" title={t.account.copyEmail} onClick={onCopyEmail}>
                  {emailCopied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <button type="button" className="icon-btn icon-btn--xs" title={masked ? "Показать" : "Скрыть"} onClick={onToggleMask}>
                  {masked ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
            )}

            <div className="dhead-tags">
              {account.is_active && (
                <span className="tag tag--accent">
                  <span className="tag-dot" style={{ background: "var(--accent)" }} />
                  АКТИВНЫЙ
                </span>
              )}
              <span className={"tag " + (planVisual.premium ? "tag--accent" : "tag--neutral")}>
                {planVisual.label}
              </span>
              <span className="tag tag--neutral">
                {account.provider === "codex" ? <Terminal size={11} /> : <Sparkles size={11} />}
                {account.provider === "codex" ? "Codex" : "Claude"}
              </span>
              {autoWarmupEnabled && (
                <span className="tag tag--accent">
                  <Zap size={11} /> АВТОПРОГРЕВ
                </span>
              )}
              {account.auth_mode === "chat_g_p_t" && tokenExpiry.tone !== "muted" && (
                <span className={"tag tag--" + (tokenExpiry.tone === "danger" ? "red" : "amber")}>
                  <KeyRound size={11} /> {tokenExpiry.label}
                </span>
              )}
            </div>
          </div>

          <div className="dhead-actions">
            {account.is_active
              ? (
                <button type="button" className="btn btn--ghost btn--md" disabled>
                  <Check size={15} /> {t.account.active}
                </button>
              )
              : (
                <button type="button" className="btn btn--primary btn--md" onClick={onSwitch} disabled={switching}>
                  {switching ? <RefreshCcw size={15} className="spin" /> : <Zap size={15} />}
                  {switching ? t.sidebar.switching : t.sidebar.switch}
                </button>
              )
            }
            {!account.is_active && !isCodex && (
              <span style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)", maxWidth: 160, lineHeight: 1.4, textAlign: "right" }}>
                {locale_label("перезапустите Claude Code после смены", "restart Claude Code after switch", locale)}
              </span>
            )}
          </div>
        </div>

        {/* Banners */}
        {account.usage?.error && !isRateLimitedUsage(account) && !needsReauth && (
          <div className="banner banner--bad">
            <AlertTriangle size={17} />
            <div className="banner-txt">
              {t.states.failedAccounts} · <strong style={{ fontFamily: "var(--mono)" }}>{account.usage.error}</strong>
            </div>
          </div>
        )}
        {isRateLimitedUsage(account) && !needsReauth && (
          <div className="banner banner--warn">
            <Clock size={17} />
            <div className="banner-txt">
              {locale_label(
                "Не удалось обновить — слишком много запросов (429). Показаны последние данные, повторим автоматически.",
                "Could not refresh — too many requests (429). Showing last known data, will retry automatically.",
                locale
              )}
            </div>
          </div>
        )}
        {needsReauth && (
          <div className="banner banner--bad">
            <KeyRound size={17} />
            <div className="banner-txt">{t.account.refreshLogin}</div>
            {onReauthorize && (
              <button type="button" className="btn btn--danger btn--sm" onClick={onReauthorize}>
                <KeyRound size={13} /> {t.account.refreshLogin}
              </button>
            )}
          </div>
        )}
        {!account.usage?.error && !needsReauth && remaining !== null && remaining <= 0 && (
          <div className="banner banner--warn">
            <AlertTriangle size={17} />
            <div className="banner-txt">{t.account.criticalLimit} — {t.account.waitingUsage}</div>
          </div>
        )}

        {/* Body */}
        <div className="dbody">
          <div className="dbody-col">
            <div className="sec-label">
              <span className="sec-label-txt"><span className="sec-label-mark">//</span>{locale_label("Лимиты использования", "Usage limits", locale)}</span>
              <span className="sec-label-rule" />
            </div>
            <div className="limit-block">
              {resetItems.length > 0 ? resetItems.map((item) => (
                <div key={item.key} className="limit-item">
                  <div className="limit-top">
                    <span className="limit-label">{item.label.toUpperCase()}</span>
                    <span className="limit-pct" style={{ color: item.tone === "danger" || item.tone === "warning" ? "var(--warn)" : "var(--text)" }}>
                      {item.remaining !== null ? `${Math.round(item.remaining)}%` : "—"}
                    </span>
                  </div>
                  <span className="meter" style={{ height: 6 }}>
                    <span
                      className={"meter-fill meter-fill--" + (item.tone === "danger" ? "red" : item.tone === "warning" ? "amber" : "accent")}
                      style={{ width: (item.remaining !== null ? Math.min(100, Math.max(2, 100 - item.remaining)) : 2) + "%" }}
                    />
                  </span>
                  {item.resetsAt && (
                    <div className="limit-eta">
                      <Clock size={12} /> {locale_label("сброс через", "resets in", locale)} {formatResetCountdown(item.resetsAt, locale)}
                    </div>
                  )}
                </div>
              )) : (
                <div style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
                  {t.account.waitingUsage}
                </div>
              )}
            </div>
            {!isCodex && (
              <div className="meta">
                <div className="meta-row">
                  <span className="meta-key">{locale_label("Подписка", "Subscription", locale)}</span>
                  <span className="meta-val">{account.claude_subscription_type || account.plan_type || "—"}</span>
                </div>
              </div>
            )}
          </div>

          <div className="dbody-col">
            <div className="sec-label">
              <span className="sec-label-txt"><span className="sec-label-mark">//</span>Параметры</span>
              <span className="sec-label-rule" />
            </div>
            <div className="meta">
              <div className="meta-row">
                <span className="meta-key">Токен</span>
                <span className="meta-val" style={{ color: !isCodex ? undefined : tokenExpiry.tone === "danger" ? "var(--bad)" : tokenExpiry.tone === "warning" ? "var(--warn)" : undefined }}>
                  {isCodex ? tokenExpiry.label : "OAuth / автообновление"}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-key">Уровень лимита</span>
                <span className="meta-val">{limitLevel}</span>
              </div>
              <div className="meta-row">
                <span className="meta-key">Организация</span>
                <span className="meta-val">{isCodex ? (account.plan_type || "—") : orgValue}</span>
              </div>
              <div className="meta-row">
                <span className="meta-key">Был активен</span>
                <span className="meta-val">{formatLastUsed(account.last_used_at)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dfoot">
          {isCodex && (
            <button type="button" className="btn btn--ghost btn--md" onClick={onWarmup} disabled={warmingUp}>
              <Zap size={14} className={warmingUp ? "pulse-soft" : undefined} /> Прогреть
            </button>
          )}
          {(isCodex || account.is_active) ? (
            <button type="button" className="btn btn--ghost btn--md" onClick={onRefresh}>
              <RefreshCcw size={14} /> {locale_label("Обновить", "Refresh", locale)}
            </button>
          ) : (
            <span
              className="dfoot-note"
              title={account.cached_usage_updated_at
                ? locale_label("Обновлено: ", "Updated: ", locale) + new Date(account.cached_usage_updated_at).toLocaleString()
                : undefined}
            >
              <Database size={13} />
              {locale_label(
                "Данные из кэша — обновляется только активный аккаунт",
                "Cached data — only the active account refreshes",
                locale
              )}
            </span>
          )}
          {isCodex && (
            <button
              type="button"
              className={"btn btn--ghost btn--md" + (autoWarmupEnabled ? " is-active" : "")}
              onClick={onToggleAutoWarmup}
            >
              <Activity size={14} /> {autoWarmupLabel}
            </button>
          )}
          <span className="dfoot-spacer" />
          <button type="button" className="icon-btn icon-btn--md" title={t.account.delete || "Удалить"} onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Settings Panel ─────────────────────────────────────────────────────────────
function SettingsPanel({
  themePreference,
  languagePreference,
  t,
  accentPreset,
  cardDensity,
  trayModeEnabled,
  isExportingFull,
  isImportingFull,
  hasAccounts,
  isWarmingAll,
  autoWarmupAllEnabled,
  onThemeChange,
  onLanguageChange,
  onAccentChange,
  onCardDensityChange,
  onTrayModeChange,
  onClose,
  onOpenImportSlim,
  onExportSlim,
  onImportFull,
  onExportFull,
  onWarmupAll,
  onToggleAutoWarmupAll,
}: {
  themePreference: ThemePreference;
  languagePreference: LanguagePreference;
  t: AppText;
  accentPreset: AccentPreset;
  cardDensity: CardDensity;
  trayModeEnabled: boolean;
  isExportingFull: boolean;
  isImportingFull: boolean;
  hasAccounts: boolean;
  isWarmingAll: boolean;
  autoWarmupAllEnabled: boolean;
  onThemeChange: (theme: ThemePreference) => void;
  onLanguageChange: (lang: LanguagePreference) => void;
  onAccentChange: (preset: AccentPreset) => void;
  onCardDensityChange: (d: CardDensity) => void;
  onTrayModeChange: (e: boolean) => void;
  onClose: () => void;
  onOpenImportSlim: () => void;
  onExportSlim: () => void;
  onImportFull: () => void;
  onExportFull: () => void;
  onWarmupAll: () => void;
  onToggleAutoWarmupAll: () => void;
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="panel" role="dialog" aria-label={t.settings.title}>
        <div className="panel-head">
          <div>
            <div className="panel-title">{t.settings.title}</div>
            <div className="panel-sub">{t.settings.subtitle}</div>
          </div>
          <button type="button" className="icon-btn icon-btn--md" onClick={onClose} title={t.common.close}>
            <X size={17} />
          </button>
        </div>
        <div className="panel-body">

          {/* Language */}
          <div className="setting">
            <div className="setting-label">{t.settings.language}</div>
            <div className="setting-hint">{t.settings.languageHint}</div>
            <div className="segmented">
              {([["system", t.common.auto], ["ru", t.settings.russian], ["en", t.settings.english]] as [LanguagePreference, string][]).map(([v, l]) => (
                <button key={v} type="button" className={"seg-opt" + (languagePreference === v ? " is-active" : "")} onClick={() => onLanguageChange(v)}>{l}</button>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div className="setting">
            <div className="setting-label">{t.settings.theme}</div>
            <div className="setting-hint">{t.settings.themeHint}</div>
            <div className="segmented">
              {([["system", t.common.auto, Monitor], ["light", t.common.light, Sun], ["dark", t.common.dark, Moon]] as [ThemePreference, string, ElementType][]).map(([v, l, Icon]) => (
                <button key={v} type="button" className={"seg-opt" + (themePreference === v ? " is-active" : "")} onClick={() => onThemeChange(v)}>
                  <Icon size={14} />{l}
                </button>
              ))}
            </div>
          </div>

          {/* Accent */}
          <div className="setting">
            <div className="setting-label">{t.settings.accent}</div>
            <div className="setting-hint">{t.settings.accentHint}</div>
            <div className="swatches">
              {(Object.entries(accentPresets) as [AccentPreset, typeof accentPresets[AccentPreset]][]).map(([preset, meta]) => (
                <button key={preset} type="button" className={"swatch-btn" + (accentPreset === preset ? " is-active" : "")} onClick={() => onAccentChange(preset)}>
                  <span className="swatch-dot" style={{ background: meta.accent }} />
                  {meta.label}
                </button>
              ))}
            </div>
          </div>

          {/* Density */}
          <div className="setting">
            <div className="setting-label">{t.settings.density}</div>
            <div className="setting-hint">{t.settings.densityHint}</div>
            <div className="segmented">
              {(Object.keys(cardDensityLabels) as CardDensity[]).map((d) => (
                <button key={d} type="button" className={"seg-opt" + (cardDensity === d ? " is-active" : "")} onClick={() => onCardDensityChange(d)}>
                  {t.density[d]}
                </button>
              ))}
            </div>
          </div>

          {/* Tray mode */}
          <div className="setting">
            <div className="setting-label">{t.settings.trayMode}</div>
            <div className="setting-hint">{t.settings.trayModeHint}</div>
            <button type="button" className={"seg-opt" + (trayModeEnabled ? " is-active" : "")} style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => onTrayModeChange(!trayModeEnabled)}>
              <Monitor size={14} /> {t.settings.minimizeToTray}
            </button>
          </div>

          {/* Warmup tools */}
          <div className="setting">
            <div className="setting-label">Инструменты</div>
            <div className="setting-hint">Массовые операции с аккаунтами.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" className="btn btn--ghost btn--md btn--full" onClick={onWarmupAll} disabled={isWarmingAll || !hasAccounts}>
                <Zap size={14} className={isWarmingAll ? "pulse-soft" : undefined} />
                {isWarmingAll ? "Прогрев…" : t.toolbar.warmAll}
              </button>
              <button type="button" className={"btn btn--ghost btn--md btn--full" + (autoWarmupAllEnabled ? " is-active" : "")} onClick={onToggleAutoWarmupAll} disabled={!hasAccounts}>
                <Activity size={14} /> {autoWarmupAllEnabled ? t.toolbar.autoWarmupOn : t.toolbar.autoWarmupOff}
              </button>
            </div>
          </div>

          {/* Account management */}
          <div className="setting">
            <div className="setting-label">{t.settings.accountManagement}</div>
            <div className="setting-hint">{t.settings.accountHint}</div>
            <div className="settings-actions-grid">
              <button type="button" className="btn btn--ghost btn--md" onClick={onExportSlim} disabled={!hasAccounts}>
                <Download size={14} /> {t.settings.exportSlim}
              </button>
              <button type="button" className="btn btn--ghost btn--md" onClick={onOpenImportSlim}>
                <Upload size={14} /> {t.settings.importSlim}
              </button>
              <button type="button" className="btn btn--ghost btn--md" onClick={onExportFull} disabled={isExportingFull || !hasAccounts}>
                <Database size={14} /> {isExportingFull ? t.settings.exportingBackup : t.settings.exportBackup}
              </button>
              <button type="button" className="btn btn--ghost btn--md" onClick={onImportFull} disabled={isImportingFull}>
                <FolderInput size={14} /> {isImportingFull ? t.settings.importingBackup : t.settings.importBackup}
              </button>
            </div>
          </div>

          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
            {t.settings.note}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Config Modal (export/import slim) ─────────────────────────────────────────
function ConfigModal({
  mode,
  payload,
  error,
  loading,
  copied,
  t,
  onClose,
  onPayloadChange,
  onSubmit,
  onCopy,
}: {
  mode: ConfigModalMode;
  payload: string;
  error: string | null;
  loading: boolean;
  copied: boolean;
  t: AppText;
  onClose: () => void;
  onPayloadChange: (v: string) => void;
  onSubmit: () => void;
  onCopy: () => void;
}) {
  const isExport = mode === "slim_export";
  return (
    <div className="config-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="config-panel fade-up" onMouseDown={(e) => e.stopPropagation()}>
        <div className="config-header">
          <div>
            <h2>{isExport ? t.config.exportTitle : t.config.importTitle}</h2>
            <p>{isExport ? t.config.exportHint : t.config.importHint}</p>
          </div>
          <button type="button" className="icon-btn icon-btn--md" onClick={onClose} title={t.common.close}><X size={16} /></button>
        </div>
        <div className="config-body">
          {!isExport && (
            <div className="inline-alert is-warning">
              <AlertTriangle size={15} /> {t.config.importWarning}
            </div>
          )}
          <textarea
            value={payload}
            onChange={(e) => onPayloadChange(e.target.value)}
            readOnly={isExport}
            placeholder={isExport ? (loading ? t.config.generating : t.config.exportPayload) : t.config.pastePayload}
            className="config-textarea"
          />
          {error && (
            <div className="inline-alert is-danger">
              <AlertTriangle size={15} /> {error}
            </div>
          )}
          <div className="modal-footer">
            <button type="button" className="btn btn--ghost btn--md" onClick={onClose}>{t.common.close}</button>
            {isExport
              ? <button type="button" className="btn btn--primary btn--md" onClick={onCopy} disabled={!payload || loading}><Copy size={14} />{copied ? t.common.copied : t.config.copyPayload}</button>
              : <button type="button" className="btn btn--primary btn--md" onClick={onSubmit} disabled={loading}>{loading ? t.config.importing : t.config.importMissing}</button>
            }
          </div>
        </div>
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
function App() {
  const {
    accounts,
    loading,
    error,
    networkOffline,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    importClaudeFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    completeOAuthReauth,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
    checkClaudeFileStatus,
    addClaudeFromActiveSession,
    updateActiveClaudeFromFile,
    clearClaudeActiveSession,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<ProviderTab>("codex");
  // Claude CLI long-lived token tab (separate from the provider account list).
  const [tabView, setTabView] = useState<"accounts" | "tokens">("accounts");
  const [tokenCount, setTokenCount] = useState(0);
  const [reauthAccount, setReauthAccount] = useState<AccountWithUsage | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<ConfigModalMode>("slim_export");
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(() => {
    try { return window.localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true"; } catch { return false; }
  });
  const [autoWarmupAccountIds, setAutoWarmupAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY))
  );
  const [autoWarmupLedger, setAutoWarmupLedger] = useState<AutoWarmupLedger>(() => readStoredAutoWarmupLedger());
  const [autoWarmupRunningIds, setAutoWarmupRunningIds] = useState<Set<string>>(new Set());
  const [warmupToast, setWarmupToast] = useState<{ message: string; isError: boolean } | null>(null);
  const [claudeUnknownToast, setClaudeUnknownToast] = useState(false);
  const [copiedEmailAccountId, setCopiedEmailAccountId] = useState<string | null>(null);
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => resolveThemePreference(readThemePreference()));
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(readLanguagePreference);
  const [resolvedLanguage, setResolvedLanguage] = useState<Locale>(() => resolveLanguagePreference(readLanguagePreference()));
  const [accentPreset, setAccentPreset] = useState<AccentPreset>(() => {
    try {
      const s = window.localStorage.getItem(ACCENT_STORAGE_KEY);
      return s && s in accentPresets ? (s as AccentPreset) : "green";
    } catch { return "green"; }
  });
  const [cardDensity, setCardDensity] = useState<CardDensity>(() => {
    try {
      const s = window.localStorage.getItem(CARD_DENSITY_STORAGE_KEY);
      return s && s in cardDensityLabels ? (s as CardDensity) : "compact";
    } catch { return "compact"; }
  });
  const [trayModeEnabled, setTrayModeEnabled] = useState(() => {
    try { return window.localStorage.getItem(TRAY_MODE_STORAGE_KEY) === "true"; } catch { return false; }
  });
  const [accountSearchQuery, setAccountSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [hideAllEmails, setHideAllEmails] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [selectedId, setSelectedId] = useState<Record<ProviderTab, string | null>>({ codex: null, claude: null });

  const deferredSearchQuery = useDeferredValue(accountSearchQuery);
  const accountsDataRef = useRef<AccountWithUsage[]>([]);
  const autoWarmupAllEnabledRef = useRef(autoWarmupAllEnabled);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});

  const accentTheme = accentPresets[accentPreset];
  const t = translations[resolvedLanguage];

  const copyAccountEmail = useCallback((account: AccountWithUsage) => {
    if (!account.email) return;
    void navigator.clipboard.writeText(account.email).then(() => {
      setCopiedEmailAccountId(account.id);
      setTimeout(() => setCopiedEmailAccountId(null), 1600);
    }).catch(() => {});
  }, []);

  const handleResizeDrag = useCallback((direction: ResizeDirection) => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.startResizeDragging(direction);
  }, []);

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.toggleMaximize();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {}, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    loadMaskedAccountIds().then((ids) => { if (ids.length > 0) setMaskedAccounts(new Set(ids)); });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    const sync = () => setThemeMode(resolveThemePreference(themePreference));
    sync();
    try { window.localStorage.setItem(THEME_STORAGE_KEY, themePreference); } catch {}
    if (themePreference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [themePreference]);

  useEffect(() => {
    document.body.dataset.theme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    const sync = () => setResolvedLanguage(resolveLanguagePreference(languagePreference));
    sync();
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference); } catch {}
    if (languagePreference !== "system") return;
    window.addEventListener("languagechange", sync);
    return () => window.removeEventListener("languagechange", sync);
  }, [languagePreference]);

  useEffect(() => { document.documentElement.lang = resolvedLanguage; }, [resolvedLanguage]);

  useEffect(() => { try { window.localStorage.setItem(ACCENT_STORAGE_KEY, accentPreset); } catch {} }, [accentPreset]);
  useEffect(() => { try { window.localStorage.setItem(CARD_DENSITY_STORAGE_KEY, cardDensity); } catch {} }, [cardDensity]);
  useEffect(() => {
    try { window.localStorage.setItem(TRAY_MODE_STORAGE_KEY, String(trayModeEnabled)); } catch {}
    if (isTauriRuntime()) void invokeBackend("set_tray_mode_enabled", { enabled: trayModeEnabled });
  }, [trayModeEnabled]);

  useEffect(() => { if (isTauriRuntime()) void invokeBackend("refresh_tray_menu"); }, [accounts]);
  useEffect(() => { accountsDataRef.current = accounts; }, [accounts]);

  useEffect(() => {
    autoWarmupAllEnabledRef.current = autoWarmupAllEnabled;
    try { window.localStorage.setItem(AUTO_WARMUP_ALL_STORAGE_KEY, String(autoWarmupAllEnabled)); } catch {}
  }, [autoWarmupAllEnabled]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
    try { window.localStorage.setItem(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY, JSON.stringify(Array.from(autoWarmupAccountIds))); } catch {}
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupLedgerRef.current = autoWarmupLedger;
    try { window.localStorage.setItem(AUTO_WARMUP_LEDGER_STORAGE_KEY, JSON.stringify(autoWarmupLedger)); } catch {}
  }, [autoWarmupLedger]);

  useEffect(() => { autoWarmupRunningIdsRef.current = autoWarmupRunningIds; }, [autoWarmupRunningIds]);

  useEffect(() => {
    const validIds = new Set(accounts.map((a) => a.id));
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setAutoWarmupLedger((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => validIds.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [accounts]);

  // Watch .credentials.json for credentials that don't match any stored account.
  // Checked on startup, on window focus and once a minute — an external re-login
  // (e.g. after a server-side logout) can happen at any time, not just at launch.
  const claudeFileStatusRef = useRef<"file_not_found" | "matched" | "unknown">("matched");
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const check = async () => {
      const status = await checkClaudeFileStatus();
      if (cancelled) return;
      // Only notify on the transition into "unknown" so a dismissed toast stays dismissed.
      if (status === "unknown" && claudeFileStatusRef.current !== "unknown") {
        setClaudeUnknownToast(true);
      }
      claudeFileStatusRef.current = status;
    };
    void check();
    const id = window.setInterval(() => { void check(); }, 60_000);
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkClaudeFileStatus]);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs || !currentWindow) return;
    let unlisten: (() => void) | undefined;
    let saveTimer: number | undefined;
    const syncMax = async () => { try { setIsWindowMaximized(await currentWindow.isMaximized()); } catch {} };
    const restoreSize = async () => {
      try {
        const saved = window.localStorage.getItem(WINDOW_SIZE_STORAGE_KEY);
        if (!saved) return;
        const p = JSON.parse(saved) as { width?: number; height?: number };
        const w = Math.min(2200, Math.max(720, Math.round(p.width ?? 0)));
        const h = Math.min(1400, Math.max(540, Math.round(p.height ?? 0)));
        if (w && h) await currentWindow.setSize(new LogicalSize(w, h));
      } catch {}
    };
    void syncMax();
    void restoreSize();
    currentWindow.onResized(() => {
      void syncMax();
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        try { window.localStorage.setItem(WINDOW_SIZE_STORAGE_KEY, JSON.stringify({ width: window.innerWidth, height: window.innerHeight })); } catch {}
      }, 180);
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (saveTimer) window.clearTimeout(saveTimer); unlisten?.(); };
  }, []);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const handleSwitch = async (accountId: string, provider: "codex" | "claude") => {
    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
      if (provider === "claude") {
        showWarmupToast(
          locale_label(
            "Учётные данные записаны. Перезапустите Claude Code чтобы применить.",
            "Credentials written. Restart Claude Code to apply.",
            resolvedLanguage
          )
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showWarmupToast(
        locale_label("Ошибка переключения: ", "Switch failed: ", resolvedLanguage) + msg,
        true
      );
    } finally { setSwitchingId(null); }
  };

  const handleDelete = async (accountId: string) => {
    try { await deleteAccount(accountId); } catch (err) { console.error("Failed to delete:", err); }
  };

  const showWarmupToast = useCallback((message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  }, []);

  const formatWarmupError = useCallback((err: unknown) => {
    if (!err) return t.toast.unknownError;
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try { return JSON.stringify(err); } catch { return t.toast.unknownError; }
  }, [t.toast.unknownError]);

  const markSuccessfulWarmup = useCallback((id: string) => {
    setAutoWarmupLedger((prev) => ({ ...prev, [id]: { lastSuccessfulWarmupAt: Date.now() } }));
  }, []);

  const backOffAutoWarmupRetry = useCallback((id: string) => {
    autoWarmupRetryAfterRef.current[id] = Date.now() + AUTO_WARMUP_RETRY_BACKOFF_MS;
  }, []);

  const isAutoWarmupDue = useCallback((id: string, usage?: UsageInfo) => {
    if (!usage || usage.error || !usage.primary_resets_at) return false;
    if (isLimitFull(usage.secondary_used_percent)) return false;
    if (!isPrimaryFullWindow(usage)) return false;
    const retryAfter = autoWarmupRetryAfterRef.current[id];
    if (retryAfter && Date.now() < retryAfter) return false;
    const last = getLastSuccessfulWarmupAt(autoWarmupLedgerRef.current, id);
    return !last || Date.now() - last >= AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS;
  }, []);

  const runAutoWarmupForAccount = useCallback(async (account: AccountWithUsage) => {
    if (autoWarmupRunningIdsRef.current.has(account.id)) return;
    if (!isAutoWarmupDue(account.id, account.usage)) return;
    setAutoWarmupRunningIds((prev) => new Set(prev).add(account.id));
    try {
      const refreshed = await refreshSingleUsage(account.id);
      if (!isAutoWarmupDue(account.id, refreshed)) return;
      await warmupAccount(account.id);
      markSuccessfulWarmup(account.id);
      showWarmupToast(`${t.toast.autoWarmupSent} ${account.name}`);
    } catch (err) {
      console.error("Auto warmup failed:", err);
      backOffAutoWarmupRetry(account.id);
      showWarmupToast(`${t.toast.autoWarmupFailed} ${account.name}: ${formatWarmupError(err)}`, true);
    } finally {
      setAutoWarmupRunningIds((prev) => { const n = new Set(prev); n.delete(account.id); return n; });
    }
  }, [backOffAutoWarmupRetry, formatWarmupError, isAutoWarmupDue, markSuccessfulWarmup, refreshSingleUsage, showWarmupToast, t.toast.autoWarmupFailed, t.toast.autoWarmupSent, warmupAccount]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const ids = autoWarmupAccountIdsRef.current;
      const all = autoWarmupAllEnabledRef.current;
      if (!all && ids.size === 0) return;
      accountsDataRef.current
        .filter((a) => a.provider !== "claude" && (all || ids.has(a.id)) && isAutoWarmupDue(a.id, a.usage))
        .forEach((a) => void runAutoWarmupForAccount(a));
    }, AUTO_WARMUP_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isAutoWarmupDue, runAutoWarmupForAccount]);

  const toggleAutoWarmupAccount = useCallback((id: string) => {
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const getAutoWarmupLabel = useCallback((account: AccountWithUsage) => {
    const enabled = autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id);
    if (autoWarmupRunningIds.has(account.id)) return t.account.autoWarmupRunning;
    if (autoWarmupAllEnabled) return t.account.autoWarmupManagedByAll;
    return enabled ? t.account.autoWarmupOn : t.account.autoWarmupOff;
  }, [autoWarmupAccountIds, autoWarmupAllEnabled, autoWarmupRunningIds, t.account]);

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      markSuccessfulWarmup(accountId);
      showWarmupToast(`${t.toast.warmupSent} ${accountName}`);
    } catch (err) {
      showWarmupToast(`${t.toast.warmupFailed} ${accountName}: ${formatWarmupError(err)}`, true);
    } finally { setWarmingUpId(null); }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) { showWarmupToast(t.toast.noWarmupAccounts, true); return; }
      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(`${t.toast.warmed} ${summary.warmed_accounts}/${summary.total_accounts}`);
      } else {
        showWarmupToast(`${t.toast.warmed} ${summary.warmed_accounts}/${summary.total_accounts}. ${t.toast.failed}: ${summary.failed_account_ids.length}`, true);
      }
      const failedSet = new Set(summary.failed_account_ids);
      accounts.forEach((a) => { if (!failedSet.has(a.id)) markSuccessfulWarmup(a.id); });
    } catch (err) {
      showWarmupToast(`${t.toast.warmupAllFailed}: ${formatWarmupError(err)}`, true);
    } finally { setIsWarmingAll(false); }
  };

  const handleExportSlimText = async () => {
    setConfigModalMode("slim_export"); setConfigModalError(null); setConfigPayload(""); setConfigCopied(false); setIsConfigModalOpen(true);
    try {
      setIsExportingSlim(true);
      const payload = await exportAccountsSlimText();
      setConfigPayload(payload);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setConfigModalError(m);
      showWarmupToast(t.toast.slimExportFailed, true);
    } finally { setIsExportingSlim(false); }
  };

  const openImportSlimTextModal = () => {
    setConfigModalMode("slim_import"); setConfigModalError(null); setConfigPayload(""); setConfigCopied(false); setIsConfigModalOpen(true);
  };

  const handleImportSlimText = async () => {
    if (!configPayload.trim()) { setConfigModalError(t.toast.pasteSlimFirst); return; }
    try {
      setIsImportingSlim(true); setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set()); setIsConfigModalOpen(false);
      showWarmupToast(`${t.toast.imported} ${summary.imported_count}, ${t.toast.skipped} ${summary.skipped_count}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setConfigModalError(m);
      showWarmupToast(t.toast.slimImportFailed, true);
    } finally { setIsImportingSlim(false); }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast(t.toast.fullExportOk);
    } catch { showWarmupToast(t.toast.fullExportFailed, true); }
    finally { setIsExportingFull(false); }
  };

  const handleImportFullFile = async () => {
    try {
      setIsImportingFull(true);
      const summary = await importFullBackupFile();
      if (!summary) return;
      const list = await loadAccounts();
      await refreshUsage(list);
      const ids = await loadMaskedAccountIds();
      setMaskedAccounts(new Set(ids));
      showWarmupToast(`${t.toast.imported} ${summary.imported_count}, ${t.toast.skipped} ${summary.skipped_count}`);
    } catch { showWarmupToast(t.toast.fullImportFailed, true); }
    finally { setIsImportingFull(false); }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const filteredAccounts = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    const prov = accounts.filter((a) => a.provider === activeProvider);
    if (!q) return prov;
    return prov.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      (a.email?.toLowerCase() ?? "").includes(q) ||
      (a.plan_type?.toLowerCase() ?? "").includes(q) ||
      (a.claude_organization_uuid?.toLowerCase() ?? "").includes(q)
    );
  }, [accounts, activeProvider, deferredSearchQuery]);

  const filteredByStatus = useMemo(() => {
    if (statusFilter === "all") return filteredAccounts;
    return filteredAccounts.filter((a) => {
      const s = getRowStatus(a);
      if (statusFilter === "ready") return a.is_active || s === "ready";
      if (statusFilter === "limit") return s === "limit";
      if (statusFilter === "error") return s === "error";
      return true;
    });
  }, [filteredAccounts, statusFilter]);

  const sortedListAccounts = useMemo(() => {
    const statusOrder: Record<string, number> = { ready: 0, limit: 1, error: 2 };
    return [...filteredByStatus].sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      const aS = getRowStatus(a), bS = getRowStatus(b);
      const od = (statusOrder[aS] ?? 3) - (statusOrder[bS] ?? 3);
      if (od !== 0) return od;
      const aR = getRemainingPercent(a) ?? -1, bR = getRemainingPercent(b) ?? -1;
      return bR - aR;
    });
  }, [filteredByStatus]);

  const activeAccount = useMemo(
    () => accounts.find((a) => a.provider === activeProvider && a.is_active) ?? null,
    [accounts, activeProvider]
  );

  const effectiveSelectedAccount = useMemo(() => {
    const id = selectedId[activeProvider];
    if (id) {
      const found = accounts.find((a) => a.id === id);
      if (found) return found;
    }
    return activeAccount ?? accounts.find((a) => a.provider === activeProvider) ?? null;
  }, [selectedId, activeProvider, accounts, activeAccount]);

  const providerCounts = useMemo(() => ({
    codex: accounts.filter((a) => a.provider === "codex").length,
    claude: accounts.filter((a) => a.provider === "claude").length,
  }), [accounts]);

  const summary = useMemo(() => {
    const prov = accounts.filter((a) => a.provider === activeProvider);
    return {
      total: prov.length,
      // Transient rate limits (429) are not real failures — don't paint them red.
      errorCount: prov.filter((a) => Boolean(a.usage?.error) && !isRateLimitedUsage(a)).length,
      nearLimitCount: prov.filter((a) => {
        const r = getRemainingPercent(a);
        return r !== null && r <= NEAR_LIMIT_REMAINING_THRESHOLD;
      }).length,
      availableCount: prov.filter((a) => {
        if (a.provider === "claude") return true;
        if (a.usage?.error && !isRateLimitedUsage(a)) return false;
        const r = getRemainingPercent(a);
        return r === null || r > 0;
      }).length,
    };
  }, [accounts, activeProvider]);

  const isBackendUnavailable = !isTauriRuntime() && typeof error === "string" && /404|Failed to fetch|NetworkError|ERR_/i.test(error);

  const shellStyle = useMemo(() => ({
    "--accent": accentTheme.accent,
    "--accent-soft": accentTheme.soft,
    "--accent-strong": accentTheme.strong,
    "--accent-border": accentTheme.border,
    "--accent-glow": accentTheme.glow,
    "--accent-contrast": accentTheme.contrast,
  }) as CSSProperties, [accentTheme]);

  const STATUS_FILTERS: { id: StatusFilter; label: string; dot?: string }[] = [
    { id: "all", label: locale_label("Все", "All", resolvedLanguage) },
    { id: "ready", label: locale_label("Готов", "Ready", resolvedLanguage), dot: "var(--ok)" },
    { id: "limit", label: locale_label("Лимит", "Limit", resolvedLanguage), dot: "var(--warn)" },
    { id: "error", label: locale_label("Сбой", "Error", resolvedLanguage), dot: "var(--bad)" },
  ];

  return (
    <div className="app" data-theme={themeMode} data-density={cardDensity} style={shellStyle}>
      {/* Tauri resize handles */}
      {([
        ["North", "resize-handle is-n"], ["South", "resize-handle is-s"],
        ["West", "resize-handle is-w"], ["East", "resize-handle is-e"],
        ["NorthWest", "resize-handle is-nw"], ["NorthEast", "resize-handle is-ne"],
        ["SouthWest", "resize-handle is-sw"], ["SouthEast", "resize-handle is-se"],
      ] as [ResizeDirection, string][]).map(([dir, cls]) => (
        <div key={dir} className={cls} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); handleResizeDrag(dir); }} aria-hidden />
      ))}

      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <div className="topbar" onDoubleClick={handleTitlebarDoubleClick}>
        {/* Brand */}
        <div className="brand">
          <span className="brand-glyph"><Terminal size={14} /></span>
          <span className="brand-name"><b>codex</b><span>·</span><b>switcher</b></span>
        </div>

        {/* Provider tabs */}
        <div className="tabs">
          <button type="button" className={"tab" + (tabView === "accounts" && activeProvider === "codex" ? " is-active" : "")} onClick={() => { setTabView("accounts"); setActiveProvider("codex"); }}>
            <Bot size={13} /> Codex <span className="t-count">{providerCounts.codex}</span>
          </button>
          <button type="button" className={"tab" + (tabView === "accounts" && activeProvider === "claude" ? " is-active" : "")} onClick={() => { setTabView("accounts"); setActiveProvider("claude"); }}>
            <Sparkles size={13} /> Claude <span className="t-count">{providerCounts.claude}</span>
          </button>
          <button type="button" className={"tab" + (tabView === "tokens" ? " is-active" : "")} onClick={() => setTabView("tokens")} title="claude setup-token">
            🔑 Claude CLI <span className="t-count">{tokenCount}</span>
          </button>
        </div>

        <div className="topbar-spacer" />

        {/* Global stats */}
        <div className="gstats">
          <div className="gstat">
            <span className="gstat-n">{summary.total}</span>
            <span className="gstat-l">{locale_label("ВСЕГО", "TOTAL", resolvedLanguage)}</span>
          </div>
          <div className="gstat gstat--ok">
            <span className="gstat-n">{summary.availableCount}</span>
            <span className="gstat-l">{locale_label("ДОСТУПНО", "AVAIL", resolvedLanguage)}</span>
          </div>
          <div className="gstat gstat--warn">
            <span className="gstat-n">{summary.nearLimitCount}</span>
            <span className="gstat-l">{locale_label("У ЛИМИТА", "LIMIT", resolvedLanguage)}</span>
          </div>
          <div className="gstat gstat--bad">
            <span className="gstat-n">{summary.errorCount}</span>
            <span className="gstat-l">{locale_label("ОШИБКИ", "ERRORS", resolvedLanguage)}</span>
          </div>
        </div>

        {/* Tools */}
        <div className="topbar-tools">
          <button
            type="button"
            className={"icon-btn icon-btn--md" + (hideAllEmails ? " is-active" : "")}
            title={hideAllEmails ? locale_label("Показать почты", "Show emails", resolvedLanguage) : locale_label("Скрыть почты", "Hide emails", resolvedLanguage)}
            onClick={() => setHideAllEmails(v => !v)}
          >
            {hideAllEmails ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button type="button" className="icon-btn icon-btn--md" title={locale_label("Тема", "Theme", resolvedLanguage)}
            onClick={() => setThemePreference(themeMode === "dark" ? "light" : "dark")}>
            {themeMode === "dark" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button type="button" className="icon-btn icon-btn--md" title={t.settings.title} onClick={() => setIsSettingsOpen(true)}>
            <Settings2 size={16} />
          </button>

          {/* Window controls (non-Mac Tauri only) */}
          {!isMacOs && currentWindow && (
            <div className="win-controls">
              <button type="button" className="wc-btn" title={locale_label("Свернуть", "Minimize", resolvedLanguage)}
                onClick={() => { if (trayModeEnabled) void currentWindow.hide(); else void currentWindow.minimize(); }}>
                <ChevronDown size={14} />
              </button>
              <button type="button" className="wc-btn" title={isWindowMaximized ? locale_label("Восстановить", "Restore", resolvedLanguage) : locale_label("Развернуть", "Maximize", resolvedLanguage)}
                onClick={() => void currentWindow.toggleMaximize()}>
                <Monitor size={14} />
              </button>
              <button type="button" className="wc-btn is-danger" title={t.common.close} onClick={() => void currentWindow.close()}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Workbench ──────────────────────────────────────────────────────── */}
      {tabView === "tokens" ? (
        <div className="token-wrap">
          <ClaudeTokenPanel language={resolvedLanguage === "ru" ? "ru" : "en"} onCountChange={setTokenCount} />
        </div>
      ) : (
      <div className="workbench">
        {/* Left column: account list */}
        <div className="col-list">
          <div className="list-head">
            <div className="search">
              <Search size={14} />
              <input
                placeholder={locale_label("поиск по имени или почте…", "search by name or email…", resolvedLanguage)}
                value={accountSearchQuery}
                onChange={(e) => startTransition(() => setAccountSearchQuery(e.target.value))}
              />
              {accountSearchQuery
                ? <button type="button" className="icon-btn icon-btn--xs" onClick={() => setAccountSearchQuery("")}><X size={12} /></button>
                : <kbd>/</kbd>
              }
            </div>
            <div className="filters">
              {STATUS_FILTERS.map((f) => (
                <button key={f.id} type="button" className={"chip" + (statusFilter === f.id ? " is-active" : "")} onClick={() => setStatusFilter(f.id)}>
                  {f.dot && <span className="chip-dot" style={{ background: f.dot }} />}
                  {f.label}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              <button type="button" className="chip chip--add" onClick={() => setIsAddModalOpen(true)} title={t.sidebar.addAccount}>
                + {locale_label("аккаунт", "account", resolvedLanguage)}
              </button>
            </div>
          </div>

          {networkOffline && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "7px 14px",
              background: "var(--warn, #b45309)22",
              borderBottom: "1px solid var(--warn, #b45309)55",
              color: "var(--warn, #ca8a04)",
              fontFamily: "var(--mono)", fontSize: 12,
            }}>
              <WifiOff size={14} style={{ flexShrink: 0 }} />
              <span>{resolvedLanguage === "ru" ? "Ожидание подключения к сети…" : "Waiting for network connection…"}</span>
            </div>
          )}

          <div className="acc-list">
            {loading && accounts.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
                <RefreshCcw size={20} className="spin" style={{ marginBottom: 8 }} />
                <div>{t.states.loadingAccounts}</div>
              </div>
            ) : error ? (
              <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--bad)", fontFamily: "var(--mono)", fontSize: 12 }}>
                <AlertTriangle size={20} style={{ marginBottom: 8 }} />
                <div>{isBackendUnavailable ? t.states.backendDisconnected : error}</div>
              </div>
            ) : sortedListAccounts.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
                {accounts.filter((a) => a.provider === activeProvider).length === 0
                  ? locale_label("нет аккаунтов", "no accounts", resolvedLanguage)
                  : locale_label("ничего не найдено", "no results", resolvedLanguage)
                }
              </div>
            ) : (
              sortedListAccounts.map((account) => (
                <AccountListRow
                  key={account.id}
                  account={account}
                  selected={effectiveSelectedAccount?.id === account.id}
                  isActiveAcc={account.is_active}
                  masked={hideAllEmails || maskedAccounts.has(account.id)}
                  onClick={() => setSelectedId((prev) => ({ ...prev, [activeProvider]: account.id }))}
                />
              ))
            )}
          </div>
        </div>

        {/* Right column: detail panel */}
        <div className="col-detail">
          {effectiveSelectedAccount ? (
            <AccountDetailPanel
              account={effectiveSelectedAccount}
              masked={hideAllEmails || maskedAccounts.has(effectiveSelectedAccount.id)}
              onToggleMask={() => toggleMask(effectiveSelectedAccount.id)}
              onCopyEmail={() => copyAccountEmail(effectiveSelectedAccount)}
              emailCopied={copiedEmailAccountId === effectiveSelectedAccount.id}
              switching={switchingId === effectiveSelectedAccount.id}
              warmingUp={isWarmingAll || warmingUpId === effectiveSelectedAccount.id || autoWarmupRunningIds.has(effectiveSelectedAccount.id)}
              autoWarmupEnabled={autoWarmupAllEnabled || autoWarmupAccountIds.has(effectiveSelectedAccount.id)}
              autoWarmupLabel={getAutoWarmupLabel(effectiveSelectedAccount)}
              onSwitch={() => void handleSwitch(effectiveSelectedAccount.id, effectiveSelectedAccount.provider)}
              onWarmup={() => void handleWarmupAccount(effectiveSelectedAccount.id, effectiveSelectedAccount.name)}
              onRefresh={() => void refreshSingleUsage(effectiveSelectedAccount.id, { refreshMetadata: effectiveSelectedAccount.provider === "codex" })}
              onDelete={() => void handleDelete(effectiveSelectedAccount.id)}
              onRename={(newName) => renameAccount(effectiveSelectedAccount.id, newName)}
              onToggleAutoWarmup={() => toggleAutoWarmupAccount(effectiveSelectedAccount.id)}
              onReauthorize={effectiveSelectedAccount.auth_mode === "chat_g_p_t" ? () => setReauthAccount(effectiveSelectedAccount) : undefined}
              locale={resolvedLanguage}
              t={t}
            />
          ) : (
            <div className="detail-empty">
              <div style={{ textAlign: "center" }}>
                <UserRound size={32} style={{ opacity: .4, marginBottom: 10 }} />
                <div>{locale_label("выберите аккаунт из списка слева", "select an account from the list", resolvedLanguage)}</div>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {/* ── Overlays ───────────────────────────────────────────────────────── */}
      {isSettingsOpen && (
        <SettingsPanel
          themePreference={themePreference}
          languagePreference={languagePreference}
          t={t}
          accentPreset={accentPreset}
          cardDensity={cardDensity}
          trayModeEnabled={trayModeEnabled}
          isExportingFull={isExportingFull}
          isImportingFull={isImportingFull}
          hasAccounts={providerCounts.codex > 0}
          isWarmingAll={isWarmingAll}
          autoWarmupAllEnabled={autoWarmupAllEnabled}
          onThemeChange={setThemePreference}
          onLanguageChange={setLanguagePreference}
          onAccentChange={setAccentPreset}
          onCardDensityChange={setCardDensity}
          onTrayModeChange={setTrayModeEnabled}
          onClose={() => setIsSettingsOpen(false)}
          onOpenImportSlim={() => { setIsSettingsOpen(false); openImportSlimTextModal(); }}
          onExportSlim={() => { setIsSettingsOpen(false); void handleExportSlimText(); }}
          onImportFull={() => { setIsSettingsOpen(false); void handleImportFullFile(); }}
          onExportFull={() => { setIsSettingsOpen(false); void handleExportFullFile(); }}
          onWarmupAll={() => void handleWarmupAll()}
          onToggleAutoWarmupAll={() => setAutoWarmupAllEnabled((v) => !v)}
        />
      )}

      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onImportClaudeFile={importClaudeFromFile}
        onAddClaudeFromSession={addClaudeFromActiveSession}
        onClearClaudeSession={clearClaudeActiveSession}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
        provider={activeProvider}
        locale={resolvedLanguage}
      />

      <AddAccountModal
        isOpen={reauthAccount !== null}
        mode="reauthorize"
        lockedAccountName={reauthAccount?.name}
        onClose={() => setReauthAccount(null)}
        onImportFile={importFromFile}
        onImportClaudeFile={importClaudeFromFile}
        onAddClaudeFromSession={addClaudeFromActiveSession}
        onClearClaudeSession={clearClaudeActiveSession}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={() => {
          if (!reauthAccount) return Promise.reject(new Error("No account"));
          return completeOAuthReauth(reauthAccount.id);
        }}
        onCancelOAuth={cancelOAuthLogin}
        locale={resolvedLanguage}
      />

      {isConfigModalOpen && (
        <ConfigModal
          mode={configModalMode}
          payload={configPayload}
          error={configModalError}
          loading={configModalMode === "slim_export" ? isExportingSlim : isImportingSlim}
          copied={configCopied}
          t={t}
          onClose={() => setIsConfigModalOpen(false)}
          onPayloadChange={setConfigPayload}
          onSubmit={() => void handleImportSlimText()}
          onCopy={() => {
            if (!configPayload) return;
            void navigator.clipboard.writeText(configPayload).then(() => {
              setConfigCopied(true);
              setTimeout(() => setConfigCopied(false), 1500);
            }).catch(() => { setConfigModalError(resolvedLanguage === "ru" ? "Буфер обмена недоступен." : "Clipboard unavailable."); });
          }}
        />
      )}

      {/* Toasts */}
      <div className="toast-wrap" aria-live="polite">
        {warmupToast && (
          <div className={"toast" + (warmupToast.isError ? " toast--bad" : " toast--ok")}>
            {warmupToast.isError ? <AlertTriangle size={16} style={{ color: "var(--bad)" }} /> : <Check size={16} style={{ color: "var(--ok)" }} />}
            <span>{warmupToast.message}</span>
          </div>
        )}
        {claudeUnknownToast && (() => {
          const activeClaudeName = accounts.find(a => a.provider === "claude" && a.is_active)?.name;
          const ru = resolvedLanguage === "ru";
          return (
            <div className="toast toast--warn" style={{ gap: 10 }}>
              <AlertTriangle size={16} style={{ color: "var(--warn)", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                {ru ? "Обнаружены новые учётные данные Claude" : "New Claude credentials detected"}
              </span>
              {activeClaudeName && (
                <button
                  type="button"
                  className="ui-action-button"
                  style={{ flexShrink: 0 }}
                  onClick={() => {
                    setClaudeUnknownToast(false);
                    updateActiveClaudeFromFile().catch(console.error);
                  }}
                >
                  {ru ? `Обновить «${activeClaudeName}»` : `Update "${activeClaudeName}"`}
                </button>
              )}
              <button
                type="button"
                className="ui-action-button is-ghost"
                style={{ flexShrink: 0 }}
                onClick={() => { setClaudeUnknownToast(false); setIsAddModalOpen(true); setActiveProvider("claude"); }}
              >
                {ru ? "Добавить новый" : "Add new"}
              </button>
              <button
                type="button"
                style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
                onClick={() => setClaudeUnknownToast(false)}
              >✕</button>
            </div>
          );
        })()}
      </div>

      <UpdateChecker locale={resolvedLanguage} />
    </div>
  );
}

function locale_label(ru: string, en: string, locale: Locale): string {
  return locale === "ru" ? ru : en;
}

export default App;
