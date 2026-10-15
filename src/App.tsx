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
  Boxes,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Crown,
  Database,
  Download,
  FileJson,
  Eye,
  EyeOff,
  FolderInput,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  PencilLine,
  RefreshCcw,
  Search,
  Share2,
  Settings2,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Upload,
  UserRound,
  Users,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useAccounts } from "./hooks/useAccounts";
import { AddAccountModal, UpdateChecker, ClaudeTokenPanel, GatewayPanel, ZcodePanel } from "./components";
import { GravityGrid } from "./components/GravityGrid";
import type { AccountWithUsage, ClaudeTokenAccountInfo, GatewayAccountInfo, UsageInfo, ZcodeAccountInfo } from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  isTauriRuntime,
} from "./lib/platform";
import { getPlanVisual } from "./lib/accountVisuals";
import {
  colorHex,
  loadAccountLooks,
  saveAccountLooks,
  type AccountLook,
} from "./lib/accountLooks";
import { LookIcon, LookPicker } from "./components/AccountLookPicker";
import {
  getAccountFault,
  getEffectiveRemainingPercent,
  getUsageRemaining,
  getVisibleLimitWindows,
  hasRecoverableAuthError,
  isAccountDead,
  type AccountFaultKind,
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
const PALETTE_STORAGE_KEY = "codex-switcher-palette";
const FONT_STORAGE_KEY = "codex-switcher-font";
const TEXT_SCALE_STORAGE_KEY = "codex-switcher-text-scale";
const TRAY_MODE_STORAGE_KEY = "codex-switcher-tray-mode";
const ACTIVE_TAB_STORAGE_KEY = "codex-switcher-active-tab";
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

type AccentPreset = "green" | "cyan" | "blue" | "amber" | "rose" | "clay" | "frost" | "mauve";
type Palette = "graphite" | "clay" | "nord" | "mocha";
type FontPreset = "plex" | "system" | "serif" | "mono" | "geometric";
type TextScale = "s" | "m" | "l" | "xl";
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
  clay:   { label: "Clay",          accent: "#d97757", soft: "rgba(217,119,87,.16)", strong: "rgba(217,119,87,.24)", border: "rgba(217,119,87,.34)", glow: "rgba(217,119,87,.2)",  contrast: "#fffaf6" },
  frost:  { label: "Frost",         accent: "#5e81ac", soft: "rgba(94,129,172,.16)", strong: "rgba(94,129,172,.24)", border: "rgba(94,129,172,.34)", glow: "rgba(94,129,172,.2)",  contrast: "#f7faff" },
  mauve:  { label: "Mauve",         accent: "#9d6cf0", soft: "rgba(157,108,240,.16)", strong: "rgba(157,108,240,.24)", border: "rgba(157,108,240,.34)", glow: "rgba(157,108,240,.2)", contrast: "#fcf9ff" },
};

// Each palette suggests an accent; picking the palette applies it, and the
// accent can still be changed afterwards.
const palettes: Record<Palette, { label: string; swatch: [string, string]; accent: AccentPreset }> = {
  graphite: { label: "Graphite", swatch: ["#0d1014", "#e9ecef"], accent: "green" },
  clay:     { label: "Clay",     swatch: ["#262624", "#f0eee6"], accent: "clay" },
  nord:     { label: "Nord",     swatch: ["#2e3440", "#e5e9f0"], accent: "frost" },
  mocha:    { label: "Mocha",    swatch: ["#1e1e2e", "#eff1f5"], accent: "mauve" },
};

const fontPresets: Record<FontPreset, { label: string; family: string }> = {
  plex:      { label: "Plex",      family: '"IBM Plex Sans", "Segoe UI", sans-serif' },
  system:    { label: "System",    family: '"Segoe UI Variable Text", "Segoe UI", system-ui' },
  serif:     { label: "Serif",     family: '"Tiempos Text", Charter, Cambria, Georgia, serif' },
  mono:      { label: "Mono",      family: '"Cascadia Code", Consolas, monospace' },
  geometric: { label: "Geometric", family: 'Bahnschrift, "Segoe UI", sans-serif' },
};

const textScales: Record<TextScale, number> = { s: 0.92, m: 1, l: 1.1, xl: 1.22 };

function readStoredChoice<T extends string>(key: string, options: Record<T, unknown>, fallback: T): T {
  try {
    const s = window.localStorage.getItem(key);
    return s && s in options ? (s as T) : fallback;
  } catch { return fallback; }
}

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

// The active tab is the (tabView, activeProvider) pair flattened to one stored key.
function readActiveTab(): { tabView: "accounts" | "gateway" | "zai"; activeProvider: ProviderTab } {
  try {
    const s = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (s === "gateway") return { tabView: "gateway", activeProvider: "codex" };
    if (s === "zai") return { tabView: "zai", activeProvider: "codex" };
    if (s === "claude") return { tabView: "accounts", activeProvider: "claude" };
  } catch {}
  return { tabView: "accounts", activeProvider: "codex" };
}

function resolveThemePreference(p: ThemePreference): ThemeMode {
  return p === "system" ? getSystemTheme() : p;
}

function resolveLanguagePreference(p: LanguagePreference): Locale {
  return p === "system" ? getSystemLocale() : p;
}

// Names a limit window by its length, so a 5-hour, weekly or 30-day quota reads
// as what it is. `short` is for the list rows, the long form for the card.
function windowName(minutes: number | null | undefined, kind: string, locale: Locale, short: boolean): string {
  const ru = locale === "ru";
  const m = minutes ?? (kind === "primary" ? 300 : 10080);
  if (m <= 6 * 60) {
    const h = Math.round(m / 60);
    return short ? `${h}${ru ? "ч" : "h"}` : ru ? `${h}-часовой лимит` : `${h}-hour limit`;
  }
  if (m <= 2 * 1440) {
    const h = Math.round(m / 60);
    return short ? `${h}${ru ? "ч" : "h"}` : ru ? `Лимит на ${h} ч` : `${h}-hour limit`;
  }
  if (m <= 8 * 1440) return short ? (ru ? "нед" : "wk") : ru ? "Недельный лимит" : "Weekly limit";
  if (m >= 27 * 1440 && m <= 32 * 1440) return short ? (ru ? "мес" : "mo") : ru ? "Месячный лимит" : "Monthly limit";
  const d = Math.round(m / 1440);
  return short ? `${d}${ru ? "д" : "d"}` : ru ? `Лимит на ${d} дн` : `${d}-day limit`;
}

// "Fri 15:40" / "пт 15:40", or a date when it is more than a week away.
function formatResetAt(resetAt: number, locale: Locale): string {
  const d = new Date(resetAt * 1000);
  const loc = locale === "ru" ? "ru-RU" : "en-GB";
  const far = resetAt * 1000 - Date.now() > 6 * 86_400_000;
  return far
    ? d.toLocaleDateString(loc, { day: "numeric", month: "short" })
    : d.toLocaleString(loc, { weekday: "short", hour: "2-digit", minute: "2-digit" });
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
  const ru = locale === "ru";
  const countdown = secs < 60 ? `${s}s`
    : h >= 48 ? `${Math.floor(h / 24)}${ru ? "д" : "d"} ${h % 24}${ru ? "ч" : "h"}`
    : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { label: `${t.account.authTokenRefreshIn} ${countdown}`, tone: remainingMs <= 5 * 60 * 1000 ? "warning" : "muted" };
}

// "How long until the subscription renews" for the detail panel. The value comes
// from the account entitlement (or, as a fallback, the ChatGPT id_token claims),
// so it is available for parked accounts too — no network, no token refresh.
function formatSubscriptionRenewal(expiresAt: string | null | undefined, locale: Locale): string {
  if (!expiresAt) return "—";
  const at = new Date(expiresAt).getTime();
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-GB");
  const days = Math.ceil((at - Date.now()) / 86_400_000);
  if (days < 0) return locale_label(`истекла ${date}`, `expired ${date}`, locale);
  if (days === 0) return locale_label(`сегодня · ${date}`, `today · ${date}`, locale);
  return locale_label(`через ${days} дн · ${date}`, `in ${days}d · ${date}`, locale);
}

function formatLastUsed(lastUsedAt: string | null, locale: Locale): string {
  if (!lastUsedAt) return "—";
  const diff = Math.floor((Date.now() - new Date(lastUsedAt).getTime()) / 1000);
  const ru = locale === "ru";
  const ago = (n: number, ruUnit: string, enUnit: string) => (ru ? `${n} ${ruUnit} назад` : `${n}${enUnit} ago`);
  if (diff < 5) return ru ? "сейчас" : "now";
  if (diff < 60) return ago(diff, "с", "s");
  if (diff < 3600) return ago(Math.floor(diff / 60), "мин", "m");
  if (diff < 86400) return ago(Math.floor(diff / 3600), "ч", "h");
  return ago(Math.floor(diff / 86400), "дн", "d");
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
  return getVisibleLimitWindows(account).map((w) => ({
    key: w.key,
    label: windowName(w.windowMinutes, w.kind, locale, false),
    short: windowName(w.windowMinutes, w.kind, locale, true),
    resetsAt: w.resetsAt,
    remaining: getUsageRemaining(w.usedPercent),
    tone: getLimitTone(getUsageRemaining(w.usedPercent)),
  }));
}

// ── Plan insignia ─────────────────────────────────────────────────────────────
// Rank gets metal, not another blue-to-purple SaaS ladder: a hollow glacier
// crown for Plus, a solid gold one for Pro, two verdigris figures for Team.
// Free and API-key accounts get nothing — absence is what makes the paid rows
// readable at a glance.
function PlanMark({ account, size = 13 }: { account: AccountWithUsage; size?: number }) {
  const { insignia, tone, label } = getPlanVisual(account);
  if (!insignia) return null;
  const cls = "acc-mark acc-mark--" + (tone === "pro" ? "pro" : tone === "team" ? "team" : "plus");
  return (
    <span className={cls} title={label} aria-label={label}>
      {insignia === "team"
        ? <Users size={size} />
        : <Crown size={size} fill={insignia === "crown-solid" ? "currentColor" : "none"} />}
    </span>
  );
}

// What went wrong, in words the person can act on. Keyed off the backend's
// error_kind so the UI never has to show a raw "API error: 403 Forbidden".
function describeFault(
  kind: AccountFaultKind,
  locale: Locale
): { short: string; detail: string } {
  const ru = locale === "ru";
  switch (kind) {
    case "auth_revoked":
      return {
        short: ru ? "Вход отозван" : "Signed out",
        detail: ru
          ? "OpenAI отклонила сессию. Авторизуйся в этом аккаунте заново."
          : "OpenAI rejected the session. Sign in to this account again.",
      };
    case "forbidden":
      return {
        short: ru ? "Нет доступа" : "No access",
        detail: ru
          ? "Доступ к аккаунту закрыт — обычно это исключение из организации или блокировка."
          : "Access to this account is closed — usually removal from an organisation, or a ban.",
      };
    case "unreachable":
      return {
        short: ru ? "Не пускает" : "Locked out",
        detail: ru
          ? "Сохранённый вход больше не принимают. Показаны последние цифры, которые удалось получить — авторизуйся в этом аккаунте заново."
          : "The saved sign-in is no longer accepted. These are the last figures we managed to fetch — sign in to this account again.",
      };
    case "auth_expired":
      return {
        short: ru ? "Токен истёк" : "Token expired",
        detail: ru
          ? "Токен доступа устарел. Открой Codex / Claude Code с этим аккаунтом — вход обновится сам."
          : "The access token went stale. Open Codex / Claude Code on this account and it refreshes itself.",
      };
    case "server":
      return {
        short: ru ? "Сбой OpenAI" : "OpenAI is down",
        detail: ru
          ? "OpenAI отвечает ошибкой. Данные показаны из кэша, повтор будет автоматически."
          : "OpenAI is returning an error. Showing cached data; this retries on its own.",
      };
    default:
      return {
        short: ru ? "Ошибка запроса" : "Request failed",
        detail: ru
          ? "Не удалось получить данные об использовании."
          : "Could not read usage data for this account.",
      };
  }
}

// ── Account Row (left panel list item) ────────────────────────────────────────
function AccountListRow({
  account,
  selected,
  isActiveAcc,
  masked,
  onClick,
  onContextMenu,
  look,
  locale,
}: {
  account: AccountWithUsage;
  selected: boolean;
  isActiveAcc: boolean;
  masked: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  look: AccountLook | undefined;
  locale: Locale;
}) {
  const tone = getAccountHealthTone(account);
  const remaining = getRemainingPercent(account);
  const planVisual = getPlanVisual(account);
  const dead = isAccountDead(account);
  const fault = getAccountFault(account);
  const dotColor = account.is_active ? "var(--accent)" : getDotColor(tone);
  const isPulse = (account.is_active || tone === "warning") && !dead;
  const tint = colorHex(look?.color);
  const windows = getActiveResetItems(account, locale);

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
        dead ? "is-dead" : "",
      ].join(" ")}
      data-tier={planVisual.premium && planVisual.colorVar ? planVisual.tone : undefined}
      data-tinted={tint ? "" : undefined}
      style={tint ? ({ "--tint": tint } as CSSProperties) : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="acc-gutter">
        <span
          className={"st-dot" + (isPulse ? " st-dot--pulse" : "")}
          style={{ width: 7, height: 7, background: dotColor, color: dotColor }}
        />
      </span>
      <span className="acc-main">
        <span className="acc-top">
          <LookIcon icon={look?.icon} color={tint} />
          <span className="acc-name">{account.name}</span>
          <PlanMark account={account} />
          {isActiveAcc && <span className="acc-active-tag">{locale_label("активен", "active", locale)}</span>}
        </span>
        {account.email && (
          <span className="acc-sub">{maskEmail(account.email)}</span>
        )}
        {/* Shown only in "detailed" density (CSS). */}
        <span className="acc-extra">
          {(() => {
            const next = getVisibleLimitWindows(account).filter((w) => w.resetsAt).sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0))[0];
            const parts = [planVisual.label];
            if (next?.resetsAt) parts.push(locale_label("сброс ", "reset ", locale) + formatResetCountdown(next.resetsAt, locale));
            if (account.last_used_at) parts.push(formatLastUsed(account.last_used_at, locale));
            return parts.join(" · ");
          })()}
        </span>
      </span>
      <span className="acc-right">
        {fault ? (
          <span className="acc-fault">{describeFault(fault, locale).short}</span>
        ) : isRateLimitedUsage(account) ? (
          <span className="acc-fault" style={{ color: "var(--warn)" }}>
            {locale_label("не обновлено", "not refreshed", locale)}
          </span>
        ) : (
          <>
            {/* Compact density: just the tightest remaining %. */}
            <span className="acc-pct" style={{ color: remaining !== null && remaining <= 15 ? "var(--warn)" : "var(--text)" }}>
              {remaining !== null ? `${Math.round(remaining)}%` : "—"}
            </span>
            {/* Otherwise one thin line per quota window: 5h, weekly, monthly… */}
            <span className="acc-wins">
              {windows.length === 0 ? (
                <span className="acc-win-p" style={{ color: "var(--text-3)" }}>—</span>
              ) : windows.map((w) => (
                <span key={w.key} className="acc-win" title={w.label}>
                  <span className="acc-win-l">{w.short}</span>
                  <span className="meter acc-win-m">
                    <span
                      className={"meter-fill meter-fill--" + getMeterTone(w.remaining)}
                      style={{ width: Math.max(2, w.remaining ?? 0) + "%" }}
                    />
                  </span>
                  <span className="acc-win-p" style={{ color: w.remaining !== null && w.remaining <= 15 ? "var(--warn)" : undefined }}>
                    {w.remaining !== null ? `${Math.round(w.remaining)}%` : "—"}
                  </span>
                </span>
              ))}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

// ── Right-click menu ──────────────────────────────────────────────────────────
// Everything the detail panel can do, reachable without leaving the list.
function AccountContextMenu({
  account,
  x,
  y,
  masked,
  locale,
  t,
  onClose,
  onSwitch,
  onRefresh,
  onRename,
  onCopyEmail,
  onCopyJson,
  onToggleMask,
  onReauthorize,
  onDelete,
  look,
  onLookChange,
}: {
  account: AccountWithUsage;
  x: number;
  y: number;
  masked: boolean;
  locale: Locale;
  t: AppText;
  onClose: () => void;
  onSwitch: () => void;
  onRefresh: () => void;
  onRename: () => void;
  onCopyEmail: () => void;
  onCopyJson: () => void;
  onToggleMask: () => void;
  /** Sign in again as this same account, keeping its name and history. */
  onReauthorize?: () => void;
  onDelete: () => void;
  look: AccountLook | undefined;
  onLookChange: (next: AccountLook) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip the menu back inside the window when it is opened near an edge.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <>
      <div className="ctx-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="ctx" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
        <div className="ctx-head">{account.name}</div>
        <button type="button" className="ctx-item" role="menuitem" disabled={account.is_active} onClick={run(onSwitch)}>
          <Zap size={14} /> {account.is_active ? t.account.active : t.sidebar.switch}
        </button>
        <button type="button" className="ctx-item" role="menuitem" onClick={run(onRename)}>
          <PencilLine size={14} /> {t.account.rename}
        </button>
        <button type="button" className="ctx-item" role="menuitem" onClick={run(onRefresh)}>
          <RefreshCcw size={14} /> {locale_label("Обновить лимиты", "Refresh limits", locale)}
        </button>
        {onReauthorize && (
          <button type="button" className="ctx-item" role="menuitem" onClick={run(onReauthorize)}>
            <KeyRound size={14} /> {locale_label("Войти заново", "Sign in again", locale)}
          </button>
        )}
        <div className="ctx-sep" />
        <button type="button" className="ctx-item" role="menuitem" disabled={!account.email} onClick={run(onCopyEmail)}>
          <Copy size={14} /> {t.account.copyEmail}
        </button>
        <button type="button" className="ctx-item" role="menuitem" onClick={run(onCopyJson)}>
          <FileJson size={14} /> {locale_label("Копировать как JSON", "Copy as JSON", locale)}
        </button>
        <button type="button" className="ctx-item" role="menuitem" disabled={!account.email} onClick={run(onToggleMask)}>
          {masked ? <Eye size={14} /> : <EyeOff size={14} />}
          {masked ? locale_label("Показать почту", "Show email", locale) : locale_label("Скрыть почту", "Hide email", locale)}
        </button>
        <div className="ctx-sep" />

        <LookPicker look={look} ru={locale === "ru"} onChange={onLookChange} />

        <div className="ctx-sep" />
        <button type="button" className="ctx-item ctx-item--danger" role="menuitem" onClick={run(onDelete)}>
          <Trash2 size={14} /> {t.account.delete || locale_label("Удалить", "Delete", locale)}
        </button>
      </div>
    </>
  );
}

// ── Account Detail Panel (right panel) ────────────────────────────────────────
function AccountDetailPanel({
  account,
  look,
  masked,
  onToggleMask,
  onCopyEmail,
  onCopyJson,
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
  renameRequest,
  onRenameRequestHandled,
  locale,
  t,
}: {
  account: AccountWithUsage;
  look: AccountLook | undefined;
  masked: boolean;
  onToggleMask: () => void;
  onCopyEmail: () => void;
  onCopyJson: () => void;
  emailCopied: boolean;
  switching: boolean;
  warmingUp: boolean;
  autoWarmupEnabled: boolean;
  autoWarmupLabel: string;
  onSwitch: () => void;
  onWarmup: () => void;
  onRefresh: () => void | Promise<void>;
  onDelete: () => void;
  onRename: (newName: string) => Promise<void>;
  onToggleAutoWarmup: () => void;
  onReauthorize?: () => void;
  /** Account id whose name the list asked to edit (right-click → Rename). */
  renameRequest?: string | null;
  onRenameRequestHandled: () => void;
  locale: Locale;
  t: AppText;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(account.name);
  const [isRefreshing, setIsRefreshing] = useState(false);
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

  // Declared after the reset effect above so a rename asked for from the list
  // survives the "different account selected" reset that runs first.
  useEffect(() => {
    if (renameRequest && renameRequest === account.id) {
      setEditingName(true);
      onRenameRequestHandled();
    }
  }, [renameRequest, account.id, onRenameRequestHandled]);

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
  const isCodex = account.provider === "codex";
  const dead = isAccountDead(account);
  const fault = getAccountFault(account);
  const faultText = fault ? describeFault(fault, locale) : null;
  const subscriptionEnded = Boolean(
    isCodex &&
      account.subscription_expires_at &&
      new Date(account.subscription_expires_at).getTime() < Date.now()
  );
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
      <div
        className={"dcard" + (dead ? " is-dead" : "")}
        data-tinted={colorHex(look?.color) ? "" : undefined}
        style={colorHex(look?.color) ? ({ "--tint": colorHex(look?.color) } as CSSProperties) : undefined}
      >
        <div className={barClass} />

        <div className="dhead">
          <span
            className={"st-dot" + (account.is_active && !dead ? " st-dot--pulse" : "")}
            style={{ width: 9, height: 9, marginTop: 7, background: dotColor, color: dotColor, flexShrink: 0 }}
          />

          <div className="dhead-main">
            <div className="dhead-eyebrow">
              {account.is_active
                ? <><Check size={12} /> {t.account.currentAccount}</>
                : <>{planVisual.label} · {locale_label("аккаунт", "account", locale)}</>
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
                <span className="dhead-name-row">
                  <LookIcon icon={look?.icon} size={18} color={colorHex(look?.color)} />
                  <button
                    type="button"
                    className="dhead-name-btn"
                    onClick={() => setEditingName(true)}
                    title={t.account.rename}
                  >
                    <span>{account.name}</span>
                    <PencilLine size={15} className="edit-pencil" />
                  </button>
                  <PlanMark account={account} size={18} />
                </span>
              )}
            </div>

            {account.email && (
              <div className="dhead-email">
                <UserRound size={13} />
                <span>{maskEmail(account.email)}</span>
                <button type="button" className="icon-btn icon-btn--xs" title={t.account.copyEmail} onClick={onCopyEmail}>
                  {emailCopied ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <button type="button" className="icon-btn icon-btn--xs" title={masked ? locale_label("Показать", "Show", locale) : locale_label("Скрыть", "Hide", locale)} onClick={onToggleMask}>
                  {masked ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
            )}

            <div className="dhead-tags">
              {account.is_active && (
                <span className="tag tag--accent">
                  <span className="tag-dot" style={{ background: "var(--accent)" }} />
                  {locale_label("АКТИВНЫЙ", "ACTIVE", locale)}
                </span>
              )}
              {/* The plan badge wears its own metal, not the app accent — the
                  accent is reserved for "this is the account in use". */}
              <span
                className="tag"
                style={planVisual.colorVar ? {
                  color: `var(${planVisual.colorVar})`,
                  borderColor: `color-mix(in oklab, var(${planVisual.colorVar}) 40%, transparent)`,
                  background: `color-mix(in oklab, var(${planVisual.colorVar}) 12%, transparent)`,
                } : undefined}
              >
                <PlanMark account={account} size={11} />
                {planVisual.label}
              </span>
              <span className="tag tag--neutral">
                {account.provider === "codex" ? <Terminal size={11} /> : <Sparkles size={11} />}
                {account.provider === "codex" ? "Codex" : "Claude"}
              </span>
              {autoWarmupEnabled && (
                <span className="tag tag--accent">
                  <Zap size={11} /> {locale_label("АВТОПРОГРЕВ", "AUTO WARM-UP", locale)}
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
        {faultText && !isRateLimitedUsage(account) && (
          <div className={"banner banner--" + (dead ? "bad" : "warn")} title={account.usage?.error ?? undefined}>
            {fault === "auth_revoked" || fault === "auth_expired" ? <KeyRound size={17} /> : <AlertTriangle size={17} />}
            <div className="banner-txt">
              <strong>{faultText.short}.</strong> {faultText.detail}
            </div>
            {needsReauth && onReauthorize && (
              <button type="button" className="btn btn--danger btn--sm" onClick={onReauthorize}>
                <KeyRound size={13} /> {t.account.refreshLogin}
              </button>
            )}
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
        {!account.usage?.error && !fault && !needsReauth && remaining !== null && remaining <= 0 && (
          <div className="banner banner--warn">
            <AlertTriangle size={17} />
            <div className="banner-txt">{t.account.criticalLimit} — {t.account.waitingUsage}</div>
          </div>
        )}

        {/* Body */}
        <div className="dbody">
          <div className="dbody-col">
            <div className="sec-label">
              <span className="sec-label-txt">
                <span className="sec-label-mark">//</span>
                {account.usage?.from_cache && account.cached_usage_updated_at
                  ? locale_label("Лимиты на ", "Limits as of ", locale) +
                    new Date(account.cached_usage_updated_at).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-GB")
                  : locale_label("Лимиты использования", "Usage limits", locale)}
              </span>
              <span className="sec-label-rule" />
            </div>
            <div className="limit-block">
              {resetItems.length > 0 ? resetItems.map((item) => (
                <div key={item.key} className="limit-item">
                  <div className="limit-top">
                    <span className="limit-label">{item.label}</span>
                    <span className="limit-pct" style={{ color: item.tone === "danger" || item.tone === "warning" ? "var(--warn)" : "var(--text)" }}>
                      {item.remaining !== null ? `${Math.round(item.remaining)}%` : "—"}
                      <span className="limit-pct-sub">{locale_label("осталось", "left", locale)}</span>
                    </span>
                  </div>
                  <span className="meter" style={{ height: 6 }}>
                    {/* Fill = remaining (drains as used), matching the % label and the list-row meter. */}
                    <span
                      className={"meter-fill meter-fill--" + (item.tone === "danger" ? "red" : item.tone === "warning" ? "amber" : "accent")}
                      style={{ width: (item.remaining !== null ? Math.min(100, Math.max(2, item.remaining)) : 2) + "%" }}
                    />
                  </span>
                  {item.resetsAt && (
                    <div className="limit-eta">
                      <Clock size={12} /> {locale_label("сброс через", "resets in", locale)} {formatResetCountdown(item.resetsAt, locale)}
                      <span className="limit-eta-at">· {formatResetAt(item.resetsAt, locale)}</span>
                    </div>
                  )}
                </div>
              )) : (
                <div style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
                  {t.account.waitingUsage}
                </div>
              )}
            </div>
            <div className="meta">
              <div className="meta-row">
                <span className="meta-key">{locale_label("Подписка", "Subscription", locale)}</span>
                <span className="meta-val" style={planVisual.colorVar ? { color: `var(${planVisual.colorVar})` } : undefined}>
                  {isCodex
                    ? planVisual.label
                    : (account.claude_subscription_type || account.plan_type || "—")}
                </span>
              </div>
              {isCodex && (
                <div className="meta-row">
                  <span className="meta-key">
                    {subscriptionEnded
                      ? locale_label("Закончилась", "Ended", locale)
                      : locale_label("Продление", "Renews", locale)}
                  </span>
                  <span className="meta-val" style={subscriptionEnded ? { color: "var(--text-3)" } : undefined}>
                    {formatSubscriptionRenewal(account.subscription_expires_at, locale)}
                  </span>
                </div>
              )}
              {isCodex && account.usage?.credits_balance && (
                <div className="meta-row">
                  <span className="meta-key">{locale_label("Кредиты", "Credits", locale)}</span>
                  <span className="meta-val">
                    {account.usage.unlimited_credits ? "∞" : account.usage.credits_balance}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="dbody-col">
            <div className="sec-label">
              <span className="sec-label-txt"><span className="sec-label-mark">//</span>{locale_label("Параметры", "Details", locale)}</span>
              <span className="sec-label-rule" />
            </div>
            <div className="meta">
              <div className="meta-row">
                <span className="meta-key">{locale_label("Токен", "Token", locale)}</span>
                <span className="meta-val" style={{ color: !isCodex ? undefined : tokenExpiry.tone === "danger" ? "var(--bad)" : tokenExpiry.tone === "warning" ? "var(--warn)" : undefined }}>
                  {isCodex ? tokenExpiry.label : locale_label("OAuth / автообновление", "OAuth / auto-refresh", locale)}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-key">{locale_label("Уровень лимита", "Limit tier", locale)}</span>
                <span className="meta-val">{limitLevel}</span>
              </div>
              {/* Codex exposes no organisation, and echoing the plan here just
                  repeated the row above it. */}
              {!isCodex && (
                <div className="meta-row">
                  <span className="meta-key">{locale_label("Организация", "Organisation", locale)}</span>
                  <span className="meta-val">{orgValue}</span>
                </div>
              )}
              <div className="meta-row">
                <span className="meta-key">{locale_label("Был активен", "Last used", locale)}</span>
                <span className="meta-val">{formatLastUsed(account.last_used_at, locale)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dfoot">
          {isCodex && (
            <button type="button" className="btn btn--ghost btn--md" onClick={onWarmup} disabled={warmingUp}>
              <Zap size={14} className={warmingUp ? "pulse-soft" : undefined} /> {locale_label("Прогреть", "Warm up", locale)}
            </button>
          )}
          {/* Parked Codex accounts refresh too: a usage GET uses the stored access
              token and never rotates anything. Only parked Claude stays frozen. */}
          {account.is_active || isCodex ? (
            <button
              type="button"
              className={"btn btn--ghost btn--md" + (isRefreshing ? " is-busy" : "")}
              disabled={isRefreshing}
              onClick={async () => {
                if (isRefreshing) return;
                setIsRefreshing(true);
                try { await onRefresh(); }
                finally { setIsRefreshing(false); }
              }}
            >
              {isRefreshing
                ? <Loader2 size={14} className="spin" />
                : <RefreshCcw size={14} />}
              {isRefreshing
                ? locale_label("Обновление…", "Refreshing…", locale)
                : locale_label("Обновить", "Refresh", locale)}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--md"
              disabled
              title={locale_label(
                "Данные из кэша — припаркованный Claude-аккаунт заморожен. Переключитесь, чтобы обновить.",
                "Cached data — a parked Claude account stays frozen. Switch to update.",
                locale
              )}
            >
              <Database size={14} /> {locale_label("Из кэша", "Cached", locale)}
            </button>
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
          <button
            type="button"
            className="btn btn--ghost btn--md"
            onClick={onCopyJson}
            title={locale_label(
              "Скопировать аккаунт целиком — друг вставит его через «+ аккаунт» → «Вставить JSON»",
              "Copy the whole account — a friend pastes it via “+ account” → “Paste JSON”",
              locale
            )}
          >
            <Share2 size={14} /> {locale_label("Копировать JSON", "Copy JSON", locale)}
          </button>
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
  palette,
  fontPreset,
  textScale,
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
  onPaletteChange,
  onFontChange,
  onTextScaleChange,
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
  palette: Palette;
  fontPreset: FontPreset;
  textScale: TextScale;
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
  onPaletteChange: (p: Palette) => void;
  onFontChange: (f: FontPreset) => void;
  onTextScaleChange: (s: TextScale) => void;
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
  const ru = t === translations.ru;
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

          {/* Palette */}
          <div className="setting">
            <div className="setting-label">{ru ? "Палитра" : "Palette"}</div>
            <div className="setting-hint">{ru ? "Цвета фона и текста. Светлая/тёмная — по настройке темы выше." : "Background and text colours. Light/dark follows the theme above."}</div>
            <div className="swatches">
              {(Object.entries(palettes) as [Palette, typeof palettes[Palette]][]).map(([id, meta]) => (
                <button key={id} type="button" className={"swatch-btn" + (palette === id ? " is-active" : "")} onClick={() => onPaletteChange(id)}>
                  <span className="swatch-dot" style={{ background: `linear-gradient(135deg, ${meta.swatch[0]} 50%, ${meta.swatch[1]} 50%)`, boxShadow: `0 0 0 2px ${accentPresets[meta.accent].accent}` }} />
                  {meta.label}
                </button>
              ))}
            </div>
          </div>

          {/* Font */}
          <div className="setting">
            <div className="setting-label">{ru ? "Шрифт" : "Font"}</div>
            <div className="setting-hint">{ru ? "Только системные шрифты — работает офлайн." : "System fonts only — works offline."}</div>
            <div className="swatches">
              {(Object.entries(fontPresets) as [FontPreset, typeof fontPresets[FontPreset]][]).map(([id, meta]) => (
                <button key={id} type="button" className={"swatch-btn" + (fontPreset === id ? " is-active" : "")} style={{ fontFamily: meta.family }} onClick={() => onFontChange(id)}>
                  Aa {meta.label}
                </button>
              ))}
            </div>
          </div>

          {/* Text size */}
          <div className="setting">
            <div className="setting-label">{ru ? "Размер текста" : "Text size"}</div>
            <div className="segmented">
              {(Object.keys(textScales) as TextScale[]).map((k) => (
                <button key={k} type="button" className={"seg-opt" + (textScale === k ? " is-active" : "")} onClick={() => onTextScaleChange(k)}>
                  {k.toUpperCase()}
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
            <div className="setting-label">{ru ? "Инструменты" : "Tools"}</div>
            <div className="setting-hint">{ru ? "Массовые операции с аккаунтами." : "Bulk actions on accounts."}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button type="button" className="btn btn--ghost btn--md btn--full" onClick={onWarmupAll} disabled={isWarmingAll || !hasAccounts}>
                <Zap size={14} className={isWarmingAll ? "pulse-soft" : undefined} />
                {isWarmingAll ? (ru ? "Прогрев…" : "Warming…") : t.toolbar.warmAll}
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

// ── Share Modal (copy as JSON → optionally give the login away) ─────────────
// Both copies share one refresh token; whoever refreshes first signs the other
// out. "Give away" removes it here (and the CLI's session file) so only the
// friend's copy stays alive, then opens a fresh sign-in for yourself.
function ShareAccountModal({
  account,
  json,
  error,
  copied,
  removing,
  locale,
  onCopy,
  onGiveAway,
  onClose,
}: {
  account: AccountWithUsage;
  json: string;
  error: string | null;
  copied: boolean;
  removing: boolean;
  locale: Locale;
  onCopy: () => void;
  onGiveAway: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const ru = locale === "ru";
  const isClaude = account.provider === "claude";
  const file = isClaude ? "~/.claude/.credentials.json" : "~/.codex/auth.json";
  const cli = isClaude ? "Claude Code" : "Codex";
  return (
    <div className="config-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="config-panel fade-up" onMouseDown={(e) => e.stopPropagation()}>
        <div className="config-header">
          <div>
            <h2>{ru ? `Поделиться «${account.name}»` : `Share “${account.name}”`}</h2>
            <p>
              {ru
                ? "Друг вставит это через «+ аккаунт» → «Вставить JSON». Внутри живые токены — как пароль."
                : "Your friend pastes this via “+ account” → “Paste JSON”. It holds live tokens — treat it like a password."}
            </p>
          </div>
          <button type="button" className="icon-btn icon-btn--md" onClick={onClose} title={ru ? "Закрыть" : "Close"}><X size={16} /></button>
        </div>
        <div className="config-body">
          <textarea className="config-textarea" readOnly value={json} placeholder={ru ? "Готовлю…" : "Preparing…"} spellCheck={false} style={{ minHeight: 150 }} />
          <div className="modal-footer" style={{ marginTop: 0 }}>
            <button type="button" className="btn btn--primary btn--md" onClick={onCopy} disabled={!json}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? (ru ? "Скопировано" : "Copied") : (ru ? "Скопировать" : "Copy")}
            </button>
          </div>

          <div className="share-giveaway">
            <div className="share-giveaway-title">
              <AlertTriangle size={15} /> {ru ? "Отдать аккаунт насовсем" : "Give the account away"}
            </div>
            <p>
              {ru
                ? `Вход один на двоих: как только ${cli} у одного из вас обновит токен, у второго вход слетит. Чтобы этого не было, удали копию у себя — из списка и ${file}${isClaude ? "" : ", Codex будет закрыт"}. Затем войди в аккаунт заново: у тебя будет своя, отдельная сессия, а у друга всё продолжит работать.`
                : `The sign-in is shared: as soon as ${cli} on either side refreshes the token, the other one is signed out. To avoid that, remove your copy — from the list and ${file}${isClaude ? "" : " (Codex will be closed)"}. Then sign in again: you get your own separate session and your friend's keeps working.`}
              {isClaude && (ru ? " Закрой Claude Code перед этим." : " Close Claude Code first.")}
            </p>
            {confirming ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn btn--danger btn--md" onClick={onGiveAway} disabled={removing}>
                  {removing ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  {ru ? "Да, удалить у себя и войти заново" : "Yes, remove mine and sign in again"}
                </button>
                <button type="button" className="btn btn--ghost btn--md" onClick={() => setConfirming(false)} disabled={removing}>
                  {ru ? "Отмена" : "Cancel"}
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn--ghost btn--md share-giveaway-btn" onClick={() => setConfirming(true)} disabled={!json}>
                <Trash2 size={14} /> {ru ? "Удалить у себя и войти заново…" : "Remove mine and sign in again…"}
              </button>
            )}
          </div>

          {error && (
            <div className="inline-alert is-danger">
              <AlertTriangle size={15} /> {error}
            </div>
          )}
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
    exportAccountJson,
    importAccountJson,
    removeAccountAndSession,
    startOAuthLogin,
    completeOAuthLogin,
    completeOAuthReauth,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
    checkClaudeFileStatus,
    checkCodexFileStatus,
    addCodexFromActiveSession,
    addClaudeFromActiveSession,
    updateActiveClaudeFromFile,
    clearClaudeActiveSession,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<ProviderTab>(() => readActiveTab().activeProvider);
  // Claude CLI long-lived token tab (separate from the provider account list).
  const [tabView, setTabView] = useState<"accounts" | "gateway" | "zai">(() => readActiveTab().tabView);
  // Full Claude CLI token list, loaded at startup so the tab badge + stats are
  // correct immediately (not only after the tab is first opened). The panel keeps
  // this in sync as tokens are added / activated / deleted.
  const [gatewayAccounts, setGatewayAccounts] = useState<GatewayAccountInfo[]>([]);
  const [claudeTokens, setClaudeTokens] = useState<ClaudeTokenAccountInfo[]>([]);
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
  const [codexUnknownToast, setCodexUnknownToast] = useState(false);
  const codexFileStatusRef = useRef<string | null>(null);
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
  const [palette, setPalette] = useState<Palette>(() => readStoredChoice(PALETTE_STORAGE_KEY, palettes, "graphite"));
  const [fontPreset, setFontPreset] = useState<FontPreset>(() => readStoredChoice(FONT_STORAGE_KEY, fontPresets, "plex"));
  const [textScale, setTextScale] = useState<TextScale>(() => readStoredChoice(TEXT_SCALE_STORAGE_KEY, textScales, "m"));
  const [trayModeEnabled, setTrayModeEnabled] = useState(() => {
    try { return window.localStorage.getItem(TRAY_MODE_STORAGE_KEY) === "true"; } catch { return false; }
  });
  const [accountSearchQuery, setAccountSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [hideAllEmails, setHideAllEmails] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [selectedId, setSelectedId] = useState<Record<ProviderTab, string | null>>({ codex: null, claude: null });
  const [zcodeAccounts, setZcodeAccounts] = useState<ZcodeAccountInfo[]>([]);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renameRequestId, setRenameRequestId] = useState<string | null>(null);
  const [share, setShare] = useState<{ account: AccountWithUsage; json: string; error: string | null; copied: boolean; removing: boolean } | null>(null);
  const [accountLooks, setAccountLooks] = useState<Record<string, AccountLook>>(() => loadAccountLooks());

  const deferredSearchQuery = useDeferredValue(accountSearchQuery);
  const accountsDataRef = useRef<AccountWithUsage[]>([]);
  const autoWarmupAllEnabledRef = useRef(autoWarmupAllEnabled);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});

  const accentTheme = accentPresets[accentPreset];
  const t = translations[resolvedLanguage];

  const updateAccountLook = useCallback((accountId: string, next: AccountLook) => {
    setAccountLooks((prev) => {
      const merged = { ...prev };
      if (next.color || next.icon) merged[accountId] = next;
      else delete merged[accountId];
      saveAccountLooks(merged);
      return merged;
    });
  }, []);

  const copyAccountEmail = useCallback((account: AccountWithUsage) => {
    if (!account.email) return;
    void navigator.clipboard.writeText(account.email).then(() => {
      setCopiedEmailAccountId(account.id);
      setTimeout(() => setCopiedEmailAccountId(null), 1600);
    }).catch(() => {});
  }, []);

  // One click puts the account on the clipboard as JSON a friend can paste into
  // "+ account" → "Paste JSON". It carries live tokens, so the toast says so.
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const copyShareJson = useCallback((json: string) => {
    void navigator.clipboard.writeText(json).then(() => {
      setShare((s) => (s ? { ...s, copied: true } : s));
      setTimeout(() => setShare((s) => (s ? { ...s, copied: false } : s)), 1600);
    }).catch(() => setShare((s) => (s ? { ...s, error: resolvedLanguage === "ru" ? "Буфер обмена недоступен — выдели текст и скопируй вручную." : "Clipboard unavailable — select the text and copy it manually." } : s)));
  }, [resolvedLanguage]);

  // Opens the share window and puts the JSON on the clipboard straight away.
  const copyAccountJson = useCallback(async (account: AccountWithUsage) => {
    setShare({ account, json: "", error: null, copied: false, removing: false });
    try {
      const json = await exportAccountJson(account.id);
      setShare((s) => (s && s.account.id === account.id ? { ...s, json } : s));
      copyShareJson(json);
    } catch (err) {
      setShare((s) => (s ? { ...s, error: errText(err) } : s));
    }
  }, [exportAccountJson, copyShareJson]);

  const giveAccountAway = useCallback(async () => {
    if (!share) return;
    const { account } = share;
    setShare({ ...share, removing: true, error: null });
    try {
      await removeAccountAndSession(account.id);
      setShare(null);
      setTabView("accounts");
      setActiveProvider(account.provider);
      setIsAddModalOpen(true);
    } catch (err) {
      setShare((s) => (s ? { ...s, removing: false, error: errText(err) } : s));
    }
  }, [share, removeAccountAndSession]);

  const handleImportAccountJson = useCallback(async (contents: string, name: string) => {
    const added = await importAccountJson(contents, name);
    // The JSON decides the provider, which may not be the tab the modal opened on.
    setTabView("accounts");
    setActiveProvider(added.provider);
    setSelectedId((prev) => ({ ...prev, [added.provider]: added.id }));
    showWarmupToast(resolvedLanguage === "ru" ? `Добавлен «${added.name}»` : `Added “${added.name}”`);
  }, [importAccountJson, resolvedLanguage]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResizeDrag = useCallback((direction: ResizeDirection) => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.startResizeDragging(direction);
  }, []);

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.toggleMaximize();
  }, []);

  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // The search box shows a "/" hint; make the key actually focus it.
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (!searchInputRef.current) return;
      e.preventDefault();
      searchInputRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    loadMaskedAccountIds().then((ids) => { if (ids.length > 0) setMaskedAccounts(new Set(ids)); });
  }, [loadMaskedAccountIds]);

  // Prime the Claude CLI token list once on startup so the tab badge and stats
  // reflect reality before the user ever opens the tab.
  useEffect(() => {
    invokeBackend<GatewayAccountInfo[]>("list_gateway_accounts")
      .then(setGatewayAccounts)
      .catch(() => {});
    invokeBackend<ClaudeTokenAccountInfo[]>("list_claude_token_accounts")
      .then(setClaudeTokens)
      .catch(() => {});
    invokeBackend<ZcodeAccountInfo[]>("list_zcode_accounts")
      .then(setZcodeAccounts)
      .catch(() => {});
  }, []);

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
    document.body.dataset.palette = palette;
  }, [themeMode, palette]);

  useEffect(() => {
    const sync = () => setResolvedLanguage(resolveLanguagePreference(languagePreference));
    sync();
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference); } catch {}
    if (languagePreference !== "system") return;
    window.addEventListener("languagechange", sync);
    return () => window.removeEventListener("languagechange", sync);
  }, [languagePreference]);

  useEffect(() => { document.documentElement.lang = resolvedLanguage; }, [resolvedLanguage]);

  useEffect(() => {
    try { window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabView === "gateway" ? "gateway" : tabView === "zai" ? "zai" : activeProvider); } catch {}
  }, [tabView, activeProvider]);
  useEffect(() => { try { window.localStorage.setItem(ACCENT_STORAGE_KEY, accentPreset); } catch {} }, [accentPreset]);
  useEffect(() => { try { window.localStorage.setItem(CARD_DENSITY_STORAGE_KEY, cardDensity); } catch {} }, [cardDensity]);
  useEffect(() => { try { window.localStorage.setItem(PALETTE_STORAGE_KEY, palette); } catch {} }, [palette]);
  useEffect(() => { try { window.localStorage.setItem(FONT_STORAGE_KEY, fontPreset); } catch {} }, [fontPreset]);
  useEffect(() => { try { window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, textScale); } catch {} }, [textScale]);
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

  // Same watch for Codex: a login done inside Codex itself should be offered
  // for adding, not silently ignored.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const check = async () => {
      const status = await checkCodexFileStatus();
      if (cancelled) return;
      // Only notify on the transition into "unknown" so a dismissed toast stays dismissed.
      if (status === "unknown" && codexFileStatusRef.current !== "unknown") {
        setCodexUnknownToast(true);
      }
      codexFileStatusRef.current = status;
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
  }, [checkCodexFileStatus]);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs || !currentWindow) return;
    let unlisten: (() => void) | undefined;
    let saveTimer: number | undefined;
    const syncMax = async () => { try { setIsWindowMaximized(await currentWindow.isMaximized()); } catch {} };
    // Enforce the minimum window size at runtime so a resize never clips the
    // window controls (the topbar needs ~880px to fit the close button).
    const MIN_W = 880, MIN_H = 540;
    const enforceMin = async () => { try { await currentWindow.setMinSize(new LogicalSize(MIN_W, MIN_H)); } catch {} };
    const restoreSize = async () => {
      try {
        const saved = window.localStorage.getItem(WINDOW_SIZE_STORAGE_KEY);
        if (!saved) return;
        const p = JSON.parse(saved) as { width?: number; height?: number };
        const w = Math.min(2200, Math.max(MIN_W, Math.round(p.width ?? 0)));
        const h = Math.min(1400, Math.max(MIN_H, Math.round(p.height ?? 0)));
        if (w && h) await currentWindow.setSize(new LogicalSize(w, h));
      } catch {}
    };
    void enforceMin();
    void syncMax();
    void restoreSize();
    currentWindow.onResized(() => {
      void syncMax();
      // Borderless windows on Windows can be dragged below the configured min via
      // startResizeDragging, which clips the window controls. Snap back to the min.
      if (window.innerWidth < MIN_W || window.innerHeight < MIN_H) {
        void currentWindow.setSize(new LogicalSize(Math.max(MIN_W, window.innerWidth), Math.max(MIN_H, window.innerHeight))).catch(() => {});
      }
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        try {
          window.localStorage.setItem(WINDOW_SIZE_STORAGE_KEY, JSON.stringify({
            width: Math.max(MIN_W, window.innerWidth), height: Math.max(MIN_H, window.innerHeight),
          }));
        } catch {}
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

  // Names the app picks itself are deliberately dull and numbered — the person
  // renames them to something meaningful, and a placeholder must never collide.
  const nextAutoAccountName = useCallback(() => {
    const taken = new Set(accounts.map((a) => a.name.trim().toLowerCase()));
    for (let n = 1; ; n++) {
      const candidate = `Account ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }, [accounts]);

  const handleDelete = async (accountId: string) => {
    try { await deleteAccount(accountId); } catch (err) { console.error("Failed to delete:", err); }
  };

  const showWarmupToast = useCallback((message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  }, []);

  // One wording for every refresh path. A replayed snapshot is not "refreshed":
  // the server refused the saved sign-in and these are old numbers.
  const reportRefresh = (usage: UsageInfo | undefined) => {
    const ru = resolvedLanguage === "ru";
    if (usage?.rate_limited) showWarmupToast(t.toast.refreshRateLimited, true);
    else if (usage?.error) showWarmupToast(t.toast.refreshFailed, true);
    else if (usage?.from_cache) showWarmupToast(ru
      ? "Сервер не принял сохранённый вход — показаны прошлые цифры. Переключись на аккаунт или войди заново."
      : "The saved sign-in was refused — showing old numbers. Switch to the account or sign in again.", true);
    else showWarmupToast(t.toast.refreshed);
  };

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
      void refreshSingleUsage(accountId, { force: true }).catch(() => {});
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
      // Claude accounts are never warmed; don't record them as warmed.
      const warmed = accounts.filter((a) => a.provider !== "claude" && !failedSet.has(a.id));
      warmed.forEach((a) => markSuccessfulWarmup(a.id));
      void refreshUsage(warmed).catch(() => {});
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
      // Accounts that need the person to fix something sink below everything
      // else, even below the active one — they cannot be used as they are.
      const aDead = isAccountDead(a), bDead = isAccountDead(b);
      if (aDead !== bDead) return aDead ? 1 : -1;
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
    const usable = accounts.filter((a) => a.provider === activeProvider && !isAccountDead(a));
    return activeAccount ?? usable[0] ?? accounts.find((a) => a.provider === activeProvider) ?? null;
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
    "--fz": textScales[textScale],
  }) as CSSProperties, [accentTheme, textScale]);

  const STATUS_FILTERS: { id: StatusFilter; label: string; dot?: string }[] = [
    { id: "all", label: locale_label("Все", "All", resolvedLanguage) },
    { id: "ready", label: locale_label("Готов", "Ready", resolvedLanguage), dot: "var(--ok)" },
    { id: "limit", label: locale_label("Лимит", "Limit", resolvedLanguage), dot: "var(--warn)" },
    { id: "error", label: locale_label("Сбой", "Error", resolvedLanguage), dot: "var(--bad)" },
  ];

  return (
    <div className={"app" + (isWindowMaximized ? " is-maximized" : "")} data-theme={themeMode} data-palette={palette} data-font={fontPreset} data-density={cardDensity} style={shellStyle}>
      {/* Interactive gravity-warp grid background */}
      <GravityGrid theme={themeMode} accent={accentTheme.accent} />

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
          <button type="button" className={"tab" + (tabView === "gateway" ? " is-active" : "")} onClick={() => setTabView("gateway")} title="Anthropic-compatible gateway keys">
            <KeyRound size={13} /> Gateway / CLI <span className="t-count">{gatewayAccounts.length + claudeTokens.length}</span>
          </button>
          <button type="button" className={"tab" + (tabView === "zai" ? " is-active" : "")} onClick={() => setTabView("zai")} title="Z.ai Coding Plan / ZCode">
            <Boxes size={13} /> Z.ai / ZCode <span className="t-count">{zcodeAccounts.length}</span>
          </button>
        </div>

        <div className="topbar-spacer" />

        {/* Global stats — token health on the Claude CLI tab, account health otherwise */}
        {tabView === "zai" ? (
          <div className="gstats">
            <div className="gstat">
              <span className="gstat-n">{zcodeAccounts.length}</span>
              <span className="gstat-l">{locale_label("ВСЕГО", "TOTAL", resolvedLanguage)}</span>
            </div>
            <div className="gstat gstat--ok">
              <span className="gstat-n">{zcodeAccounts.filter((a) => a.is_active).length}</span>
              <span className="gstat-l">{locale_label("АКТИВЕН", "ACTIVE", resolvedLanguage)}</span>
            </div>
          </div>
        ) : tabView === "gateway" ? (
          <div className="gstats">
            <div className="gstat">
              <span className="gstat-n">{gatewayAccounts.length}</span>
              <span className="gstat-l">{locale_label("КЛЮЧЕЙ", "KEYS", resolvedLanguage)}</span>
            </div>
            <div className="gstat gstat--ok">
              <span className="gstat-n">{gatewayAccounts.filter((g) => g.is_active).length}</span>
              <span className="gstat-l">{locale_label("АКТИВЕН", "ACTIVE", resolvedLanguage)}</span>
            </div>
          </div>
        ) : (
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
        )}

        {/* Tools */}
        <div className="topbar-tools">
          <button
            type="button"
            className={"icon-btn icon-btn--md tool-collapsible" + (hideAllEmails ? " is-active" : "")}
            title={hideAllEmails ? locale_label("Показать почты", "Show emails", resolvedLanguage) : locale_label("Скрыть почты", "Hide emails", resolvedLanguage)}
            onClick={() => setHideAllEmails(v => !v)}
          >
            {hideAllEmails ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button type="button" className="icon-btn icon-btn--md tool-collapsible-2" title={locale_label("Тема", "Theme", resolvedLanguage)}
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
      {tabView === "gateway" ? (
        <div className="token-wrap">
          <ClaudeTokenPanel language={resolvedLanguage === "ru" ? "ru" : "en"} onTokensChange={setClaudeTokens} />
          <GatewayPanel language={resolvedLanguage === "ru" ? "ru" : "en"} onGatewaysChange={setGatewayAccounts} />
        </div>
      ) : tabView === "zai" ? (
        <ZcodePanel
          language={resolvedLanguage === "ru" ? "ru" : "en"}
          onAccountsChange={setZcodeAccounts}
          looks={accountLooks}
          onLookChange={updateAccountLook}
        />
      ) : (
      <div className="workbench">
        {/* Left column: account list */}
        <div className="col-list">
          <div className="list-head">
            <div className="search">
              <Search size={14} />
              <input
                ref={searchInputRef}
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
              background: "color-mix(in oklab, var(--warn) 13%, transparent)",
              borderBottom: "1px solid color-mix(in oklab, var(--warn) 33%, transparent)",
              color: "var(--warn)",
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
                  look={accountLooks[account.id]}
                  locale={resolvedLanguage}
                  onClick={() => setSelectedId((prev) => ({ ...prev, [activeProvider]: account.id }))}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSelectedId((prev) => ({ ...prev, [activeProvider]: account.id }));
                    setContextMenu({ id: account.id, x: event.clientX, y: event.clientY });
                  }}
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
              look={accountLooks[effectiveSelectedAccount.id]}
              masked={hideAllEmails || maskedAccounts.has(effectiveSelectedAccount.id)}
              onToggleMask={() => toggleMask(effectiveSelectedAccount.id)}
              onCopyEmail={() => copyAccountEmail(effectiveSelectedAccount)}
              onCopyJson={() => void copyAccountJson(effectiveSelectedAccount)}
              emailCopied={copiedEmailAccountId === effectiveSelectedAccount.id}
              switching={switchingId === effectiveSelectedAccount.id}
              warmingUp={isWarmingAll || warmingUpId === effectiveSelectedAccount.id || autoWarmupRunningIds.has(effectiveSelectedAccount.id)}
              autoWarmupEnabled={autoWarmupAllEnabled || autoWarmupAccountIds.has(effectiveSelectedAccount.id)}
              autoWarmupLabel={getAutoWarmupLabel(effectiveSelectedAccount)}
              onSwitch={() => void handleSwitch(effectiveSelectedAccount.id, effectiveSelectedAccount.provider)}
              onWarmup={() => void handleWarmupAccount(effectiveSelectedAccount.id, effectiveSelectedAccount.name)}
              onRefresh={async () => {
                try {
                  // No refreshMetadata: that rotates the OAuth token from the
                  // (often stale) stored copy and triggers refresh_token_reused.
                  // get_usage already syncs the active account's token from the
                  // live auth.json safely.
                  const usage = await refreshSingleUsage(effectiveSelectedAccount.id, { force: true });
                  reportRefresh(usage);
                } catch {
                  // Backend errors can be a whole HTML page — show a short, fixed message.
                  showWarmupToast(t.toast.refreshFailed, true);
                }
              }}
              onDelete={() => void handleDelete(effectiveSelectedAccount.id)}
              onRename={(newName) => renameAccount(effectiveSelectedAccount.id, newName)}
              onToggleAutoWarmup={() => toggleAutoWarmupAccount(effectiveSelectedAccount.id)}
              onReauthorize={effectiveSelectedAccount.auth_mode === "chat_g_p_t" ? () => setReauthAccount(effectiveSelectedAccount) : undefined}
              renameRequest={renameRequestId}
              onRenameRequestHandled={() => setRenameRequestId(null)}
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
      {contextMenu && (() => {
        const target = accounts.find((a) => a.id === contextMenu.id);
        if (!target) return null;
        return (
          <AccountContextMenu
            account={target}
            x={contextMenu.x}
            y={contextMenu.y}
            masked={hideAllEmails || maskedAccounts.has(target.id)}
            locale={resolvedLanguage}
            t={t}
            onClose={() => setContextMenu(null)}
            onSwitch={() => void handleSwitch(target.id, target.provider)}
            onRefresh={() => { void refreshSingleUsage(target.id, { force: true }).then(reportRefresh).catch(() => showWarmupToast(t.toast.refreshFailed, true)); }}
            onRename={() => setRenameRequestId(target.id)}
            onCopyEmail={() => copyAccountEmail(target)}
            onCopyJson={() => void copyAccountJson(target)}
            onToggleMask={() => toggleMask(target.id)}
            onReauthorize={target.auth_mode === "chat_g_p_t" ? () => setReauthAccount(target) : undefined}
            onDelete={() => void handleDelete(target.id)}
            look={accountLooks[target.id]}
            onLookChange={(next) => updateAccountLook(target.id, next)}
          />
        );
      })()}
      {share && (
        <ShareAccountModal
          account={share.account}
          json={share.json}
          error={share.error}
          copied={share.copied}
          removing={share.removing}
          locale={resolvedLanguage}
          onCopy={() => copyShareJson(share.json)}
          onGiveAway={() => void giveAccountAway()}
          onClose={() => setShare(null)}
        />
      )}
      {isSettingsOpen && (
        <SettingsPanel
          themePreference={themePreference}
          languagePreference={languagePreference}
          t={t}
          accentPreset={accentPreset}
          palette={palette}
          fontPreset={fontPreset}
          textScale={textScale}
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
          onPaletteChange={(p) => { setPalette(p); setAccentPreset(palettes[p].accent); }}
          onFontChange={setFontPreset}
          onTextScaleChange={setTextScale}
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
        onImportJson={handleImportAccountJson}
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
        {codexUnknownToast && (() => {
          const ru = resolvedLanguage === "ru";
          const autoName = nextAutoAccountName();
          return (
            <div className="toast toast--warn" style={{ gap: 10 }}>
              <AlertTriangle size={16} style={{ color: "var(--warn)", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                {ru ? "Найден аккаунт Codex, которого нет в списке" : "Codex is signed into an account that is not in the list"}
              </span>
              <button
                type="button"
                className="ui-action-button"
                style={{ flexShrink: 0 }}
                onClick={() => {
                  setCodexUnknownToast(false);
                  addCodexFromActiveSession(autoName)
                    .then(() => showWarmupToast(ru ? `Добавлен «${autoName}» — переименуй по правому клику` : `Added “${autoName}” — rename it from the right-click menu`))
                    .catch((err) => showWarmupToast(formatWarmupError(err), true));
                }}
              >
                {ru ? `Добавить как «${autoName}»` : `Add as “${autoName}”`}
              </button>
              <button
                type="button"
                style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
                onClick={() => setCodexUnknownToast(false)}
              >✕</button>
            </div>
          );
        })()}
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
