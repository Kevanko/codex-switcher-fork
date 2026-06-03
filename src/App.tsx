import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  BadgePlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  Copy,
  Crown,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderInput,
  KeyRound,
  LayoutPanelLeft,
  Monitor,
  Moon,
  Palette,
  PanelLeftOpen,
  RefreshCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { useAccounts } from "./hooks/useAccounts";
import { AccountCard, AddAccountModal, UpdateChecker } from "./components";
import type { AccountWithUsage, CodexProcessInfo, UsageInfo } from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  isTauriRuntime,
} from "./lib/platform";
import { getPlanVisual } from "./lib/accountVisuals";
import {
  getEffectiveRemainingPercent,
  getMostLimitedResetWindow,
  getResetProgressPercentForWindow,
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
const SIDEBAR_STORAGE_KEY = "codex-switcher-sidebar-expanded";
const WINDOW_SIZE_STORAGE_KEY = "codex-switcher-window-size";
const OTHER_ACCOUNTS_SORT_STORAGE_KEY = "codex-switcher-other-accounts-sort";
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

type AccentPreset = "green" | "cyan" | "blue" | "amber" | "rose";
type AutoWarmupLedger = Record<string, { lastSuccessfulWarmupAt?: number }>;
type SortMode =
  | "deadline_asc"
  | "deadline_desc"
  | "remaining_desc"
  | "remaining_asc"
  | "subscription_asc"
  | "subscription_desc";
type ConfigModalMode = "slim_export" | "slim_import";
type CardDensity = "compact" | "comfortable" | "detailed";

const currentWindow = isTauriRuntime() ? getCurrentWindow() : null;
const isMacOs =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const accentPresets: Record<
  AccentPreset,
  {
    label: string;
    accent: string;
    soft: string;
    strong: string;
    border: string;
    glow: string;
    contrast: string;
  }
> = {
  green: {
    label: "Signal green",
    accent: "#18a872",
    soft: "rgba(24, 168, 114, 0.15)",
    strong: "rgba(24, 168, 114, 0.24)",
    border: "rgba(24, 168, 114, 0.32)",
    glow: "rgba(24, 168, 114, 0.2)",
    contrast: "#f7fffb",
  },
  cyan: {
    label: "Cyan glass",
    accent: "#18a0c8",
    soft: "rgba(24, 160, 200, 0.15)",
    strong: "rgba(24, 160, 200, 0.24)",
    border: "rgba(24, 160, 200, 0.32)",
    glow: "rgba(24, 160, 200, 0.2)",
    contrast: "#f7fdff",
  },
  blue: {
    label: "Control blue",
    accent: "#3e7ce9",
    soft: "rgba(62, 124, 233, 0.15)",
    strong: "rgba(62, 124, 233, 0.24)",
    border: "rgba(62, 124, 233, 0.32)",
    glow: "rgba(62, 124, 233, 0.2)",
    contrast: "#f8fbff",
  },
  amber: {
    label: "Amber focus",
    accent: "#d88b22",
    soft: "rgba(216, 139, 34, 0.16)",
    strong: "rgba(216, 139, 34, 0.24)",
    border: "rgba(216, 139, 34, 0.34)",
    glow: "rgba(216, 139, 34, 0.2)",
    contrast: "#211305",
  },
  rose: {
    label: "Rose pulse",
    accent: "#d15a7d",
    soft: "rgba(209, 90, 125, 0.16)",
    strong: "rgba(209, 90, 125, 0.24)",
    border: "rgba(209, 90, 125, 0.34)",
    glow: "rgba(209, 90, 125, 0.21)",
    contrast: "#fff8fb",
  },
};

const sortLabels: Record<SortMode, string> = {
  deadline_asc: "Reset soonest",
  deadline_desc: "Reset latest",
  remaining_desc: "Most capacity",
  remaining_asc: "Least capacity",
  subscription_asc: "Expiry soonest",
  subscription_desc: "Expiry latest",
};

const cardDensityLabels: Record<CardDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  detailed: "Detailed",
};

const narrowButtonStyle = {
  minWidth: 0,
};

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}

function readLanguagePreference(): LanguagePreference {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return saved === "en" || saved === "ru" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}

function readStoredStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_WARMUP_LEDGER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([accountId, value]) => {
          const timestamp =
            value &&
            typeof value === "object" &&
            "lastSuccessfulWarmupAt" in value &&
            typeof value.lastSuccessfulWarmupAt === "number"
              ? value.lastSuccessfulWarmupAt
              : undefined;
          return timestamp ? [accountId, { lastSuccessfulWarmupAt: timestamp }] : null;
        })
        .filter((entry): entry is [string, { lastSuccessfulWarmupAt: number }] => Boolean(entry))
    );
  } catch {
    return {};
  }
}

function resolveThemePreference(preference: ThemePreference): ThemeMode {
  return preference === "system" ? getSystemTheme() : preference;
}

function resolveLanguagePreference(preference: LanguagePreference): Locale {
  return preference === "system" ? getSystemLocale() : preference;
}

function formatResetWindowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes === 300) return fallback;
  if (minutes < 60) return `${minutes}m reset`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h reset`;
  return `${Math.floor(hours / 24)}d reset`;
}

function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent !== null && usedPercent !== undefined && usedPercent >= LIMIT_FULL_THRESHOLD;
}

function getPrimaryWindowMinutes(usage: UsageInfo): number {
  return usage.primary_window_minutes ?? DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function getPrimaryRemainingMs(usage: UsageInfo): number | null {
  if (!usage.primary_resets_at) return null;
  return usage.primary_resets_at * 1000 - Date.now();
}

function isPrimaryFullWindow(usage: UsageInfo): boolean {
  const remainingMs = getPrimaryRemainingMs(usage);
  if (remainingMs === null) return false;
  const thresholdMinutes = Math.max(
    0,
    getPrimaryWindowMinutes(usage) - AUTO_WARMUP_FULL_WINDOW_SLACK_MINUTES
  );
  return remainingMs >= thresholdMinutes * 60 * 1000;
}

function getLastSuccessfulWarmupAt(ledger: AutoWarmupLedger, accountId: string): number | undefined {
  return ledger[accountId]?.lastSuccessfulWarmupAt;
}

function getActiveResetItems(account: AccountWithUsage, locale: Locale) {
  const t = translations[locale];
  return getVisibleLimitWindows(account).map((window) => ({
    key: window.key,
    label:
      window.kind === "primary"
        ? formatResetWindowLabel(window.windowMinutes, t.account.reset5h)
        : window.kind === "rolling"
        ? formatResetWindowLabel(window.windowMinutes, t.account.reset)
        : t.account.reset7d,
    resetsAt: window.resetsAt,
    remaining: getUsageRemaining(window.usedPercent),
    tone: getLimitTone(getUsageRemaining(window.usedPercent)),
  }));
}

function getRemainingPercent(account: AccountWithUsage) {
  return getEffectiveRemainingPercent(account);
}

function getLimitTone(remaining: number | null): "success" | "warning" | "danger" | "muted" {
  if (remaining === null) return "muted";
  if (remaining <= 0) return "danger";
  if (remaining <= 30) return "warning";
  return "success";
}

function getResetProgressPercent(account: AccountWithUsage) {
  return getResetProgressPercentForWindow(getMostLimitedResetWindow(account));
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
  label: string;
  tone: "warning" | "danger" | "muted";
} {
  const t = translations[locale];
  if (!expiresAt) return { label: t.account.authTokenUnknown, tone: "muted" };

  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) {
    return { label: t.account.authTokenUnknown, tone: "muted" };
  }
  if (remainingMs <= 0) {
    return { label: t.account.authTokenExpired, tone: "danger" };
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const countdown =
    totalSeconds < 60
      ? `${seconds}s`
      : hours > 0
        ? `${hours}h ${minutes}m`
        : `${minutes}m`;

  return {
    label: `${t.account.authTokenRefreshIn} ${countdown}`,
    tone: remainingMs <= 5 * 60 * 1000 ? "warning" : "muted",
  };
}

function isAccountNearLimit(account: AccountWithUsage) {
  const remaining = getRemainingPercent(account);
  return remaining !== null && remaining <= 30;
}

function getAccountHealthTone(account: AccountWithUsage): "success" | "warning" | "danger" | "muted" {
  if (account.usage?.error) return "danger";
  const remaining = getRemainingPercent(account);
  if (remaining === null) return "muted";
  if (remaining <= 0) return "danger";
  if (remaining <= 30) return "warning";
  return "success";
}

function sortAccounts(accounts: AccountWithUsage[], sortMode: SortMode) {
  const getResetDeadline = (resetAt: number | null | undefined) =>
    resetAt ?? Number.POSITIVE_INFINITY;

  const getSubscriptionDeadline = (expiresAt: string | null | undefined) => {
    if (!expiresAt) return null;
    const timestamp = new Date(expiresAt).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  };

  const compareOptionalNumber = (
    aValue: number | null,
    bValue: number | null,
    direction: "asc" | "desc"
  ) => {
    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    return direction === "asc" ? aValue - bValue : bValue - aValue;
  };

  return [...accounts].sort((a, b) => {
    if (sortMode === "subscription_asc" || sortMode === "subscription_desc") {
      const subscriptionDiff = compareOptionalNumber(
        getSubscriptionDeadline(a.subscription_expires_at),
        getSubscriptionDeadline(b.subscription_expires_at),
        sortMode === "subscription_asc" ? "asc" : "desc"
      );
      if (subscriptionDiff !== 0) return subscriptionDiff;
    }

    if (sortMode === "deadline_asc" || sortMode === "deadline_desc") {
      const deadlineDiff =
        getResetDeadline(getMostLimitedResetWindow(a)?.resetsAt) -
        getResetDeadline(getMostLimitedResetWindow(b)?.resetsAt);
      if (deadlineDiff !== 0) {
        return sortMode === "deadline_asc" ? deadlineDiff : -deadlineDiff;
      }
    }

    if (sortMode === "remaining_desc" || sortMode === "remaining_asc") {
      const aRemaining = getRemainingPercent(a) ?? Number.NEGATIVE_INFINITY;
      const bRemaining = getRemainingPercent(b) ?? Number.NEGATIVE_INFINITY;
      if (aRemaining !== bRemaining) {
        return sortMode === "remaining_desc" ? bRemaining - aRemaining : aRemaining - bRemaining;
      }
    }

    const fallbackDeadline =
      getResetDeadline(getMostLimitedResetWindow(a)?.resetsAt) -
      getResetDeadline(getMostLimitedResetWindow(b)?.resetsAt);
    if (fallbackDeadline !== 0) return fallbackDeadline;

    return a.name.localeCompare(b.name);
  });
}

function SidebarAccountButton({
  account,
  expanded,
  onSelect,
  pending,
  switching,
  onConfirmSwitch,
  onCancelSwitch,
  locale,
}: {
  account: AccountWithUsage;
  expanded: boolean;
  onSelect: () => void;
  pending: boolean;
  switching: boolean;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
  locale: Locale;
}) {
  const t = translations[locale];
  const tone = getAccountHealthTone(account);
  const remaining = getRemainingPercent(account);
  const resetProgress = getResetProgressPercent(account);
  const planVisual = getPlanVisual(account);
  const isWaitingForReset = tone === "danger" && remaining !== null && remaining <= 0;
  const isPremiumLimit = planVisual.premium && isWaitingForReset;
  const ringPercent = isWaitingForReset ? (resetProgress ?? 12) : (remaining ?? 0);
  const compactStatus = isWaitingForReset
    ? `${Math.round(ringPercent)}%`
    : remaining !== null
      ? `${remaining.toFixed(0)}%`
      : planVisual.shortLabel;
  const statusText =
    tone === "danger"
      ? account.usage?.error
        ? t.account.usageError
        : t.account.criticalLimit
      : tone === "warning"
        ? t.toolbar.nearLimit
        : tone === "success"
          ? remaining !== null
            ? `${remaining.toFixed(0)}% ${t.account.left}`
            : t.account.healthyCapacity
          : t.account.waitingUsage;

  return (
    <div className={`sidebar-account-wrap ${pending ? "has-confirm" : ""}`}>
      <button
        type="button"
        className={`sidebar-account ${account.is_active ? "is-active" : ""}`}
        onClick={onSelect}
        title={expanded ? undefined : `${account.name} - ${planVisual.label} - ${statusText}`}
      >
        <span
          className={`sidebar-account-badge is-${tone} is-plan-${planVisual.tone} ${isPremiumLimit ? "is-premium-limit" : ""}`}
          style={{ "--sidebar-ring-percent": `${ringPercent}%` } as CSSProperties}
        >
          {!expanded && <span className="sidebar-usage-ring" aria-hidden="true" />}
          {planVisual.premium && <Crown className="sidebar-plan-crown" size={11} />}
          <UserRound className="sidebar-user-icon" size={22} />
          {!expanded && <span className="sidebar-compact-percent">{compactStatus}</span>}
        </span>
        {expanded && (
          <>
            <span className="sidebar-account-meta">
              <span className="sidebar-account-name">{account.name}</span>
              <span className="sidebar-account-subline">
                <span className={`status-dot is-${tone}`} />
                <span className={`sidebar-plan-label is-plan-${planVisual.tone}`}>{planVisual.label}</span>
                {statusText}
              </span>
            </span>
            {account.is_active && <ShieldCheck size={16} />}
          </>
        )}
      </button>

      {pending && (
        <div className={`sidebar-switch-confirm ${expanded ? "" : "is-compact"}`}>
          {expanded && <span>{t.sidebar.switchTo} {account.name}?</span>}
          <button
            type="button"
            className="ui-action-button is-primary"
            onClick={onConfirmSwitch}
            disabled={switching}
            title={`${t.sidebar.switchTo} ${account.name}`}
          >
            <ShieldCheck size={14} />
            {expanded && (switching ? t.sidebar.switching : t.sidebar.switch)}
          </button>
          <button
            type="button"
            className="ui-icon-button"
            onClick={onCancelSwitch}
            title={t.sidebar.cancelSwitch}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

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
  onThemeChange: (theme: ThemePreference) => void;
  onLanguageChange: (language: LanguagePreference) => void;
  onAccentChange: (preset: AccentPreset) => void;
  onCardDensityChange: (density: CardDensity) => void;
  onTrayModeChange: (enabled: boolean) => void;
  onClose: () => void;
  onOpenImportSlim: () => void;
  onExportSlim: () => void;
  onImportFull: () => void;
  onExportFull: () => void;
}) {
  return (
    <div
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="settings-panel fade-up" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>{t.settings.title}</h2>
            <p>{t.settings.subtitle}</p>
          </div>
          <button type="button" className="ui-icon-button" onClick={onClose} title={t.common.close}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div>
              <h3>{t.settings.language}</h3>
              <p>{t.settings.languageHint}</p>
            </div>
            <div className="segment-row is-triple">
              {([
                ["system", t.common.auto],
                ["ru", t.settings.russian],
                ["en", t.settings.english],
              ] as [LanguagePreference, string][]).map(([language, label]) => (
                <button
                  key={language}
                  type="button"
                  className={`ui-segment-button ${languagePreference === language ? "is-selected" : ""}`}
                  onClick={() => onLanguageChange(language)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <div>
              <h3>{t.settings.theme}</h3>
              <p>{t.settings.themeHint}</p>
            </div>
            <div className="theme-choice-row">
              <button
                type="button"
                className={`ui-segment-button theme-choice is-system ${themePreference === "system" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("system")}
              >
                <span className="theme-choice-icon"><Monitor size={16} /></span>
                <span>{t.common.auto}</span>
              </button>
              <button
                type="button"
                className={`ui-segment-button theme-choice is-light ${themePreference === "light" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("light")}
              >
                <span className="theme-choice-icon"><Sun size={16} /></span>
                <span>{t.common.light}</span>
              </button>
              <button
                type="button"
                className={`ui-segment-button theme-choice is-dark ${themePreference === "dark" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("dark")}
              >
                <span className="theme-choice-icon"><Moon size={16} /></span>
                <span>{t.common.dark}</span>
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div>
              <h3>{t.settings.accent}</h3>
              <p>{t.settings.accentHint}</p>
            </div>
            <div className="swatch-grid">
              {(Object.entries(accentPresets) as [AccentPreset, (typeof accentPresets)[AccentPreset]][]).map(
                ([preset, meta]) => (
                  <button
                    key={preset}
                    type="button"
                    className={`settings-swatch ${accentPreset === preset ? "is-selected" : ""}`}
                    onClick={() => onAccentChange(preset)}
                  >
                    <span className="swatch-chip" style={{ background: meta.accent }} />
                    <span>{meta.label}</span>
                  </button>
                )
              )}
            </div>
          </section>

          <section className="settings-section">
            <div>
              <h3>{t.settings.density}</h3>
              <p>{t.settings.densityHint}</p>
            </div>
            <div className="segment-row is-density">
              {(Object.keys(cardDensityLabels) as CardDensity[]).map((density) => (
                <button
                  key={density}
                  type="button"
                  className={`ui-segment-button ${cardDensity === density ? "is-selected" : ""}`}
                  onClick={() => onCardDensityChange(density)}
                >
                  {t.density[density]}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <div>
              <h3>{t.settings.trayMode}</h3>
              <p>{t.settings.trayModeHint}</p>
            </div>
            <button
              type="button"
              className={`settings-toggle-card ${trayModeEnabled ? "is-selected" : ""}`}
              onClick={() => onTrayModeChange(!trayModeEnabled)}
            >
              <span>
                <Monitor size={16} />
                {t.settings.minimizeToTray}
              </span>
              <span className="settings-toggle-switch" aria-hidden="true" />
            </button>
          </section>

          <section className="settings-section">
            <div>
              <h3>{t.settings.accountManagement}</h3>
              <p>{t.settings.accountHint}</p>
            </div>
            <div className="settings-actions-grid">
              <button
                type="button"
                className="ui-action-button"
                onClick={onExportSlim}
                disabled={!hasAccounts}
              >
                <Download size={16} />
                {t.settings.exportSlim}
              </button>
              <button type="button" className="ui-action-button" onClick={onOpenImportSlim}>
                <Upload size={16} />
                {t.settings.importSlim}
              </button>
              <button
                type="button"
                className="ui-action-button"
                onClick={onExportFull}
                disabled={isExportingFull || !hasAccounts}
              >
                <Database size={16} />
                {isExportingFull ? t.settings.exportingBackup : t.settings.exportBackup}
              </button>
              <button
                type="button"
                className="ui-action-button"
                onClick={onImportFull}
                disabled={isImportingFull}
              >
                <FolderInput size={16} />
                {isImportingFull ? t.settings.importingBackup : t.settings.importBackup}
              </button>
            </div>
          </section>

          <div className="settings-note">
            {t.settings.note}
          </div>
        </div>
      </aside>
    </div>
  );
}

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
  onPayloadChange: (value: string) => void;
  onSubmit: () => void;
  onCopy: () => void;
}) {
  const isExport = mode === "slim_export";

  return (
    <div
      className="config-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="config-panel fade-up" onMouseDown={(event) => event.stopPropagation()}>
        <div className="config-header">
          <div>
            <h2>{isExport ? t.config.exportTitle : t.config.importTitle}</h2>
            <p>
              {isExport
                ? t.config.exportHint
                : t.config.importHint}
            </p>
          </div>
          <button type="button" className="ui-icon-button" onClick={onClose} title={t.common.close}>
            <X size={16} />
          </button>
        </div>

        <div className="config-body">
          {!isExport && (
            <div className="inline-alert is-warning">
              <AlertTriangle size={16} />
              {t.config.importWarning}
            </div>
          )}

          <textarea
            value={payload}
            onChange={(event) => onPayloadChange(event.target.value)}
            readOnly={isExport}
            placeholder={isExport ? (loading ? t.config.generating : t.config.exportPayload) : t.config.pastePayload}
            className="config-textarea"
          />

          {error && (
            <div className="inline-alert is-danger">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}

          <div className="modal-footer">
            <button type="button" className="ui-action-button is-ghost" onClick={onClose}>
              {t.common.close}
            </button>
            {isExport ? (
              <button
                type="button"
                className="ui-action-button is-primary"
                onClick={onCopy}
                disabled={!payload || loading}
              >
                {copied ? t.common.copied : t.config.copyPayload}
              </button>
            ) : (
              <button type="button" className="ui-action-button is-primary" onClick={onSubmit} disabled={loading}>
                {loading ? t.config.importing : t.config.importMissing}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    startOAuthLogin,
    completeOAuthLogin,
    completeOAuthReauth,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [reauthAccount, setReauthAccount] = useState<AccountWithUsage | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configModalMode, setConfigModalMode] = useState<ConfigModalMode>("slim_export");
  const [configPayload, setConfigPayload] = useState("");
  const [configModalError, setConfigModalError] = useState<string | null>(null);
  const [configCopied, setConfigCopied] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [pendingSidebarSwitchId, setPendingSidebarSwitchId] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExportingSlim, setIsExportingSlim] = useState(false);
  const [isImportingSlim, setIsImportingSlim] = useState(false);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [isImportingFull, setIsImportingFull] = useState(false);
  const [isWarmingAll, setIsWarmingAll] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [autoWarmupAccountIds, setAutoWarmupAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY))
  );
  const [autoWarmupLedger, setAutoWarmupLedger] = useState<AutoWarmupLedger>(() =>
    readStoredAutoWarmupLedger()
  );
  const [autoWarmupRunningIds, setAutoWarmupRunningIds] = useState<Set<string>>(new Set());
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [, setClockTick] = useState(() => Date.now());
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [copiedEmailAccountId, setCopiedEmailAccountId] = useState<string | null>(null);
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => resolveThemePreference(readThemePreference()));
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(readLanguagePreference);
  const [resolvedLanguage, setResolvedLanguage] = useState<Locale>(() =>
    resolveLanguagePreference(readLanguagePreference())
  );
  const [accentPreset, setAccentPreset] = useState<AccentPreset>(() => {
    if (typeof window === "undefined") return "green";
    try {
      const saved = window.localStorage.getItem(ACCENT_STORAGE_KEY);
      return saved && saved in accentPresets ? (saved as AccentPreset) : "green";
    } catch {
      return "green";
    }
  });
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [otherAccountsSort, setOtherAccountsSort] = useState<SortMode>(() => {
    if (typeof window === "undefined") return "deadline_asc";
    try {
      const saved = window.localStorage.getItem(OTHER_ACCOUNTS_SORT_STORAGE_KEY);
      return saved && saved in sortLabels ? (saved as SortMode) : "deadline_asc";
    } catch {
      return "deadline_asc";
    }
  });
  const [cardDensity, setCardDensity] = useState<CardDensity>(() => {
    if (typeof window === "undefined") return "compact";
    try {
      const saved = window.localStorage.getItem(CARD_DENSITY_STORAGE_KEY);
      return saved && saved in cardDensityLabels ? (saved as CardDensity) : "compact";
    } catch {
      return "compact";
    }
  });
  const [trayModeEnabled, setTrayModeEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(TRAY_MODE_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [accountSearchQuery, setAccountSearchQuery] = useState("");
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const deferredSearchQuery = useDeferredValue(accountSearchQuery);
  const activeSectionRef = useRef<HTMLDivElement | null>(null);
  const accountRefs = useRef<Record<string, HTMLDivElement | null>>({});
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
    void navigator.clipboard
      .writeText(account.email)
      .then(() => {
        setCopiedEmailAccountId(account.id);
        setTimeout(() => setCopiedEmailAccountId(null), 1600);
      })
      .catch(() => {});
  }, []);

  const handleTitlebarDrag = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!isTauriRuntime() || event.button !== 0 || !currentWindow) return;
    void currentWindow.startDragging();
  }, []);

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.toggleMaximize();
  }, []);

  const handleResizeDrag = useCallback((direction: ResizeDirection) => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.startResizeDragging(direction);
  }, []);

  const checkProcesses = useCallback(async () => {
    try {
      const info = await invokeBackend<CodexProcessInfo>("check_codex_processes");
      setProcessInfo((prev) => {
        if (
          prev &&
          prev.can_switch === info.can_switch &&
          prev.count === info.count &&
          prev.background_count === info.background_count &&
          prev.pids.length === info.pids.length &&
          prev.pids.every((pid, index) => pid === info.pids[index])
        ) {
          return prev;
        }
        return info;
      });
      return info;
    } catch (err) {
      console.error("Failed to check processes:", err);
      return null;
    }
  }, []);

  useEffect(() => {
    void checkProcesses();
    const interval = setInterval(() => {
      void checkProcesses();
    }, 5000);
    return () => clearInterval(interval);
  }, [checkProcesses]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockTick(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    const syncTheme = () => setThemeMode(resolveThemePreference(themePreference));
    syncTheme();

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      // Ignore storage errors for this session.
    }

    if (themePreference !== "system" || typeof window === "undefined") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", syncTheme);
    return () => query.removeEventListener("change", syncTheme);
  }, [themePreference]);

  useEffect(() => {
    const isDark = themeMode === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.dataset.themePreference = themePreference;
  }, [themeMode, themePreference]);

  useEffect(() => {
    const syncLanguage = () => setResolvedLanguage(resolveLanguagePreference(languagePreference));
    syncLanguage();

    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference);
    } catch {
      // Ignore storage errors for this session.
    }

    if (languagePreference !== "system" || typeof window === "undefined") return;
    window.addEventListener("languagechange", syncLanguage);
    return () => window.removeEventListener("languagechange", syncLanguage);
  }, [languagePreference]);

  useEffect(() => {
    document.documentElement.lang = resolvedLanguage;
  }, [resolvedLanguage]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, accentPreset);
    } catch {
      // Ignore storage errors for this session.
    }
  }, [accentPreset]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(isSidebarExpanded));
    } catch {
      // Ignore storage errors for this session.
    }
  }, [isSidebarExpanded]);

  useEffect(() => {
    try {
      window.localStorage.setItem(OTHER_ACCOUNTS_SORT_STORAGE_KEY, otherAccountsSort);
    } catch {
      // Ignore storage errors for this session.
    }
  }, [otherAccountsSort]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CARD_DENSITY_STORAGE_KEY, cardDensity);
    } catch {
      // Ignore storage errors for this session.
    }
  }, [cardDensity]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TRAY_MODE_STORAGE_KEY, String(trayModeEnabled));
    } catch {
      // Ignore storage errors for this session.
    }

    if (isTauriRuntime()) {
      void invokeBackend("set_tray_mode_enabled", { enabled: trayModeEnabled });
    }
  }, [trayModeEnabled]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invokeBackend("refresh_tray_menu");
  }, [accounts]);

  useEffect(() => {
    accountsDataRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    autoWarmupAllEnabledRef.current = autoWarmupAllEnabled;
    try {
      window.localStorage.setItem(AUTO_WARMUP_ALL_STORAGE_KEY, String(autoWarmupAllEnabled));
    } catch {
      // Ignore storage errors for this session.
    }
  }, [autoWarmupAllEnabled]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(Array.from(autoWarmupAccountIds))
      );
    } catch {
      // Ignore storage errors for this session.
    }
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupLedgerRef.current = autoWarmupLedger;
    try {
      window.localStorage.setItem(AUTO_WARMUP_LEDGER_STORAGE_KEY, JSON.stringify(autoWarmupLedger));
    } catch {
      // Ignore storage errors for this session.
    }
  }, [autoWarmupLedger]);

  useEffect(() => {
    autoWarmupRunningIdsRef.current = autoWarmupRunningIds;
  }, [autoWarmupRunningIds]);

  useEffect(() => {
    const validIds = new Set(accounts.map((account) => account.id));
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(Array.from(prev).filter((accountId) => validIds.has(accountId)));
      return next.size === prev.size ? prev : next;
    });
    setAutoWarmupLedger((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([accountId]) => validIds.has(accountId))
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [accounts]);

  useEffect(() => {
    if (!pendingSidebarSwitchId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingSidebarSwitchId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingSidebarSwitchId]);

  useEffect(() => {
    if (!pendingSidebarSwitchId) return;
    if (!accounts.some((account) => account.id === pendingSidebarSwitchId)) {
      setPendingSidebarSwitchId(null);
    }
  }, [accounts, pendingSidebarSwitchId]);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs || !currentWindow) return;

    let unlisten: (() => void) | undefined;
    let saveTimer: number | undefined;

    const syncMaximizedState = async () => {
      try {
        setIsWindowMaximized(await currentWindow.isMaximized());
      } catch (err) {
        console.error("Failed to read window state:", err);
      }
    };

    const restoreSavedWindowSize = async () => {
      try {
        const saved = window.localStorage.getItem(WINDOW_SIZE_STORAGE_KEY);
        if (!saved) return;

        const parsed = JSON.parse(saved) as { width?: number; height?: number };
        const width = Math.min(2200, Math.max(720, Math.round(parsed.width ?? 0)));
        const height = Math.min(1400, Math.max(540, Math.round(parsed.height ?? 0)));
        if (width && height) {
          await currentWindow.setSize(new LogicalSize(width, height));
        }
      } catch (err) {
        console.error("Failed to restore window size:", err);
      }
    };

    void syncMaximizedState();
    void restoreSavedWindowSize();

    currentWindow
      .onResized(() => {
        void syncMaximizedState();
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          try {
            window.localStorage.setItem(
              WINDOW_SIZE_STORAGE_KEY,
              JSON.stringify({ width: window.innerWidth, height: window.innerHeight })
            );
          } catch {
            // Ignore storage errors for window geometry.
          }
        }, 180);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to watch window resize:", err);
      });

    return () => {
      if (saveTimer) window.clearTimeout(saveTimer);
      unlisten?.();
    };
  }, []);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const allAccountsMasked = accounts.length > 0 && accounts.every((account) => maskedAccounts.has(account.id));

  const toggleAllMasks = () => {
    setMaskedAccounts((prev) => {
      const shouldRevealAll = accounts.length > 0 && accounts.every((account) => prev.has(account.id));
      const next = shouldRevealAll ? new Set<string>() : new Set(accounts.map((account) => account.id));
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const handleSwitch = async (accountId: string) => {
    try {
      setSwitchingId(accountId);
      await switchAccount(accountId);
      setPendingSidebarSwitchId(null);
      await checkProcesses();
    } catch (err) {
      console.error("Failed to switch account:", err);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleDelete = async (accountId: string) => {
    try {
      await deleteAccount(accountId);
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshSuccess(false);
    try {
      await refreshUsage(undefined, { refreshMetadata: true });
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 2000);
    } finally {
      setIsRefreshing(false);
    }
  };

  const showWarmupToast = useCallback((message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  }, []);

  const formatWarmupError = useCallback((err: unknown) => {
    if (!err) return t.toast.unknownError;
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return t.toast.unknownError;
    }
  }, [t.toast.unknownError]);

  const markSuccessfulWarmup = useCallback((accountId: string) => {
    setAutoWarmupLedger((prev) => ({
      ...prev,
      [accountId]: { lastSuccessfulWarmupAt: Date.now() },
    }));
  }, []);

  const backOffAutoWarmupRetry = useCallback((accountId: string) => {
    autoWarmupRetryAfterRef.current[accountId] = Date.now() + AUTO_WARMUP_RETRY_BACKOFF_MS;
  }, []);

  const isAutoWarmupDue = useCallback((accountId: string, usage?: UsageInfo) => {
    if (!usage || usage.error || !usage.primary_resets_at) return false;
    if (isLimitFull(usage.secondary_used_percent)) return false;
    if (!isPrimaryFullWindow(usage)) return false;

    const retryAfter = autoWarmupRetryAfterRef.current[accountId];
    if (retryAfter && Date.now() < retryAfter) return false;

    const lastSuccessfulWarmupAt = getLastSuccessfulWarmupAt(autoWarmupLedgerRef.current, accountId);
    return (
      !lastSuccessfulWarmupAt ||
      Date.now() - lastSuccessfulWarmupAt >= AUTO_WARMUP_MIN_SUCCESS_INTERVAL_MS
    );
  }, []);

  const runAutoWarmupForAccount = useCallback(
    async (account: AccountWithUsage) => {
      if (autoWarmupRunningIdsRef.current.has(account.id)) return;
      if (!isAutoWarmupDue(account.id, account.usage)) return;

      setAutoWarmupRunningIds((prev) => new Set(prev).add(account.id));
      try {
        const refreshedUsage = await refreshSingleUsage(account.id);
        if (!isAutoWarmupDue(account.id, refreshedUsage)) return;

        await warmupAccount(account.id);
        markSuccessfulWarmup(account.id);
        showWarmupToast(`${t.toast.autoWarmupSent} ${account.name}`);
      } catch (err) {
        console.error("Auto warm-up failed:", err);
        backOffAutoWarmupRetry(account.id);
        showWarmupToast(
          `${t.toast.autoWarmupFailed} ${account.name}: ${formatWarmupError(err)}`,
          true
        );
      } finally {
        setAutoWarmupRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(account.id);
          return next;
        });
      }
    },
    [
      backOffAutoWarmupRetry,
      formatWarmupError,
      isAutoWarmupDue,
      markSuccessfulWarmup,
      refreshSingleUsage,
      showWarmupToast,
      t.toast.autoWarmupFailed,
      t.toast.autoWarmupSent,
      warmupAccount,
    ]
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      const selectedIds = autoWarmupAccountIdsRef.current;
      const shouldWarmAll = autoWarmupAllEnabledRef.current;
      if (!shouldWarmAll && selectedIds.size === 0) return;

      const dueAccounts = accountsDataRef.current.filter((account) => {
        if (!shouldWarmAll && !selectedIds.has(account.id)) return false;
        return isAutoWarmupDue(account.id, account.usage);
      });

      dueAccounts.forEach((account) => {
        void runAutoWarmupForAccount(account);
      });
    }, AUTO_WARMUP_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [isAutoWarmupDue, runAutoWarmupForAccount]);

  const toggleAutoWarmupAccount = useCallback((accountId: string) => {
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  }, []);

  const getAutoWarmupLabel = useCallback(
    (account: AccountWithUsage) => {
      const enabled = autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id);
      if (autoWarmupRunningIds.has(account.id)) return t.account.autoWarmupRunning;
      if (autoWarmupAllEnabled) return t.account.autoWarmupManagedByAll;
      return enabled ? t.account.autoWarmupOn : t.account.autoWarmupOff;
    },
    [
      autoWarmupAccountIds,
      autoWarmupAllEnabled,
      autoWarmupRunningIds,
      t.account.autoWarmupManagedByAll,
      t.account.autoWarmupOff,
      t.account.autoWarmupOn,
      t.account.autoWarmupRunning,
    ]
  );

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      markSuccessfulWarmup(accountId);
      showWarmupToast(`${t.toast.warmupSent} ${accountName}`);
    } catch (err) {
      console.error("Failed to warm up account:", err);
      showWarmupToast(`${t.toast.warmupFailed} ${accountName}: ${formatWarmupError(err)}`, true);
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        showWarmupToast(t.toast.noWarmupAccounts, true);
        return;
      }

      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(`${t.toast.warmed} ${summary.warmed_accounts}/${summary.total_accounts}`);
      } else {
        showWarmupToast(
          `${t.toast.warmed} ${summary.warmed_accounts}/${summary.total_accounts}. ${t.toast.failed}: ${summary.failed_account_ids.length}`,
          true
        );
      }

      const failedIds = new Set(summary.failed_account_ids);
      accounts.forEach((account) => {
        if (!failedIds.has(account.id)) {
          markSuccessfulWarmup(account.id);
        }
      });
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      showWarmupToast(`${t.toast.warmupAllFailed}: ${formatWarmupError(err)}`, true);
    } finally {
      setIsWarmingAll(false);
    }
  };

  const handleExportSlimText = async () => {
    setConfigModalMode("slim_export");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);

    try {
      setIsExportingSlim(true);
      const payload = await exportAccountsSlimText();
      setConfigPayload(payload);
      showWarmupToast(`${t.settings.exportSlim}: ${accounts.length}`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast(t.toast.slimExportFailed, true);
    } finally {
      setIsExportingSlim(false);
    }
  };

  const openImportSlimTextModal = () => {
    setConfigModalMode("slim_import");
    setConfigModalError(null);
    setConfigPayload("");
    setConfigCopied(false);
    setIsConfigModalOpen(true);
  };

  const handleImportSlimText = async () => {
    if (!configPayload.trim()) {
      setConfigModalError(t.toast.pasteSlimFirst);
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      showWarmupToast(
        `${t.toast.imported} ${summary.imported_count}, ${t.toast.skipped} ${summary.skipped_count}, ${t.toast.total} ${summary.total_in_payload}`
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast(t.toast.slimImportFailed, true);
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast(t.toast.fullExportOk);
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      showWarmupToast(t.toast.fullExportFailed, true);
    } finally {
      setIsExportingFull(false);
    }
  };

  const handleImportFullFile = async () => {
    try {
      setIsImportingFull(true);
      const summary = await importFullBackupFile();
      if (!summary) return;
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      const maskedIds = await loadMaskedAccountIds();
      setMaskedAccounts(new Set(maskedIds));
      showWarmupToast(
        `${t.toast.imported} ${summary.imported_count}, ${t.toast.skipped} ${summary.skipped_count}, ${t.toast.total} ${summary.total_in_payload}`
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      showWarmupToast(t.toast.fullImportFailed, true);
    } finally {
      setIsImportingFull(false);
    }
  };

  const filteredAccounts = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();
    if (!query) return accounts;

    return accounts.filter((account) => {
      const name = account.name.toLowerCase();
      const email = account.email?.toLowerCase() ?? "";
      const plan = account.plan_type?.toLowerCase() ?? "";
      return name.includes(query) || email.includes(query) || plan.includes(query);
    });
  }, [accounts, deferredSearchQuery]);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.is_active) ?? null,
    [accounts]
  );

  const filteredActiveAccount = useMemo(
    () => filteredAccounts.find((account) => account.is_active) ?? null,
    [filteredAccounts]
  );

  const otherAccounts = useMemo(
    () => filteredAccounts.filter((account) => !account.is_active),
    [filteredAccounts]
  );

  const sortedOtherAccounts = useMemo(
    () => sortAccounts(otherAccounts, otherAccountsSort),
    [otherAccounts, otherAccountsSort]
  );

  const sortedSidebarAccounts = useMemo(
    () => (filteredActiveAccount ? [filteredActiveAccount, ...sortedOtherAccounts] : sortedOtherAccounts),
    [filteredActiveAccount, sortedOtherAccounts]
  );

  const summary = useMemo(() => {
    const total = accounts.length;
    const errorCount = accounts.filter((account) => Boolean(account.usage?.error)).length;
    const nearLimitCount = accounts.filter((account) => isAccountNearLimit(account)).length;
    const availableCount = accounts.filter((account) => {
      if (account.usage?.error) return false;
      const remaining = getRemainingPercent(account);
      return remaining === null || remaining > 0;
    }).length;
    return { total, errorCount, nearLimitCount, availableCount };
  }, [accounts]);

  const hasRunningProcesses = processInfo && processInfo.count > 0;
  const isBackendUnavailable =
    !isTauriRuntime() &&
    typeof error === "string" &&
    /404|Failed to fetch|NetworkError|ERR_/i.test(error);

  const shellStyle = useMemo(
    () =>
      ({
        "--accent": accentTheme.accent,
        "--accent-soft": accentTheme.soft,
        "--accent-strong": accentTheme.strong,
        "--accent-border": accentTheme.border,
        "--accent-glow": accentTheme.glow,
        "--accent-contrast": accentTheme.contrast,
      }) as CSSProperties,
    [accentTheme]
  );

  const registerAccountRef = (accountId: string) => (node: HTMLDivElement | null) => {
    accountRefs.current[accountId] = node;
  };

  const handleSidebarSelect = (accountId: string) => {
    if (activeAccount?.id !== accountId) {
      setPendingSidebarSwitchId((current) => (current === accountId ? null : accountId));
      return;
    }

    setPendingSidebarSwitchId(null);
    const target = activeAccount?.id === accountId ? activeSectionRef.current : accountRefs.current[accountId];
    target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const topToolbarInfo = hasRunningProcesses
    ? `${processInfo?.count ?? 0} ${processInfo?.count === 1 ? t.common.process : t.common.processes}`
    : t.common.readyToSwitch;

  return (
    <div
      className={`app-shell density-${cardDensity}`}
      style={shellStyle}
      onMouseDown={handleTitlebarDrag}
      onDragStart={(event) => event.preventDefault()}
      data-tauri-drag-region
    >
      {([
        ["North", "resize-handle is-n"],
        ["South", "resize-handle is-s"],
        ["West", "resize-handle is-w"],
        ["East", "resize-handle is-e"],
        ["NorthWest", "resize-handle is-nw"],
        ["NorthEast", "resize-handle is-ne"],
        ["SouthWest", "resize-handle is-sw"],
        ["SouthEast", "resize-handle is-se"],
      ] as [ResizeDirection, string][]).map(([direction, className]) => (
        <div
          key={direction}
          className={className}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleResizeDrag(direction);
          }}
          aria-hidden="true"
        />
      ))}
      <div
        className="app-frame"
        onMouseDown={handleTitlebarDrag}
        onDragStart={(event) => event.preventDefault()}
        data-tauri-drag-region
      >
        <aside className={`app-sidebar ${isSidebarExpanded ? "is-expanded" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
          <div className="sidebar-section">
            <div className="sidebar-top">
              {isSidebarExpanded && (
                <>
                  <div className="brand-mark">
                    <LayoutPanelLeft size={20} />
                  </div>
                  <div className="brand-copy">
                    <div className="brand-title">Codex Switcher</div>
                    <div className="brand-subtitle">{t.sidebar.subtitle}</div>
                  </div>
                </>
              )}
              <button
                type="button"
                className={`ui-icon-button ${isSidebarExpanded ? "" : "sidebar-expand-button"}`}
                style={{ marginLeft: "auto" }}
                onClick={() => setIsSidebarExpanded((prev) => !prev)}
                title={isSidebarExpanded ? t.sidebar.collapse : t.sidebar.expand}
              >
                {isSidebarExpanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
              </button>
            </div>

            <div className={`sidebar-search ${isSidebarExpanded ? "" : "compact"}`}>
              <Search size={16} />
              {isSidebarExpanded && (
                <input
                  type="text"
                  value={accountSearchQuery}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    startTransition(() => {
                      setAccountSearchQuery(nextValue);
                    });
                  }}
                  placeholder={t.sidebar.search}
                  aria-label={t.sidebar.search}
                />
              )}
            </div>

            <div className={`sidebar-actions ${isSidebarExpanded ? "" : "compact"}`}>
              <button
                type="button"
                className="ui-action-button is-primary"
                onClick={() => {
                  setIsSettingsOpen(false);
                  setIsAddModalOpen(true);
                }}
                style={isSidebarExpanded ? undefined : narrowButtonStyle}
                title={t.sidebar.addAccount}
              >
                <BadgePlus size={16} />
                {isSidebarExpanded && t.sidebar.addAccount}
              </button>
              <button
                type="button"
                className="ui-action-button"
                onClick={() => setIsSettingsOpen(true)}
                style={isSidebarExpanded ? undefined : narrowButtonStyle}
                title={t.sidebar.openSettings}
              >
                <Settings2 size={16} />
                {isSidebarExpanded && t.sidebar.settings}
              </button>
            </div>
          </div>

          <div className="sidebar-divider" />

          <div className="sidebar-section account-list-section">
            {sortedSidebarAccounts.length > 0 ? (
              <div className="sidebar-list">
                {sortedSidebarAccounts.map((account) => (
                  <SidebarAccountButton
                    key={account.id}
                    account={account}
                    expanded={isSidebarExpanded}
                    onSelect={() => handleSidebarSelect(account.id)}
                    pending={pendingSidebarSwitchId === account.id}
                    switching={switchingId === account.id}
                    locale={resolvedLanguage}
                    onConfirmSwitch={() => {
                      void handleSwitch(account.id);
                    }}
                    onCancelSwitch={() => setPendingSidebarSwitchId(null)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ padding: "18px 8px", justifyItems: "start", textAlign: "left" }}>
                <div className="empty-state-icon" style={{ width: 54, height: 54, borderRadius: 18 }}>
                  {accounts.length === 0 ? <UserRound size={18} /> : <Search size={18} />}
                </div>
                {isSidebarExpanded && (
                  <>
                    <h2 style={{ fontSize: "1rem" }}>
                      {accounts.length === 0 ? t.sidebar.noAccounts : t.sidebar.noMatches}
                    </h2>
                    <p>
                      {accounts.length === 0
                        ? t.sidebar.noAccountsHint
                        : t.sidebar.noMatchesHint}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="sidebar-bottom">
            <div className="toolbar-pill">
              <span className={`status-dot is-${hasRunningProcesses ? "warning" : "success"}`} />
              {isSidebarExpanded ? topToolbarInfo : null}
            </div>
          </div>
        </aside>

        <div
          className="main-shell"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleTitlebarDrag(event);
              return;
            }
            event.stopPropagation();
          }}
        >
          <header
            className="window-bar"
            onMouseDown={handleTitlebarDrag}
            onDoubleClick={handleTitlebarDoubleClick}
            data-tauri-drag-region
          >
            <div
              className="window-drag-zone"
              data-tauri-drag-region
            />
            {!isMacOs && currentWindow && (
              <div className="window-controls" onMouseDown={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="ui-icon-button"
                  onClick={() => {
                    if (trayModeEnabled) {
                      void currentWindow.hide();
                      return;
                    }
                    void currentWindow.minimize();
                  }}
                  title={t.common.close === "Закрыть" ? "Свернуть" : "Minimize"}
                >
                  <ChevronDown size={16} />
                </button>
                <button
                  type="button"
                  className="ui-icon-button"
                  onClick={() => {
                    void currentWindow.toggleMaximize();
                  }}
                  title={isWindowMaximized ? (resolvedLanguage === "ru" ? "Восстановить" : "Restore") : (resolvedLanguage === "ru" ? "Развернуть" : "Maximize")}
                >
                  {isWindowMaximized ? <PanelLeftOpen size={16} /> : <Monitor size={16} />}
                </button>
                <button
                  type="button"
                  className="ui-icon-button is-danger"
                  onClick={() => {
                    void currentWindow.close();
                  }}
                  title={t.common.close}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </header>

          <main className="window-main">
            <div className="toolbar">
              <div className="toolbar-copy">
                <h1>{t.toolbar.title}</h1>
                <p>{t.toolbar.subtitle}</p>
              </div>

              <section className="toolbar-stats-row" aria-label={t.toolbar.summaryLabel}>
                <span className="toolbar-stat">
                  <UserRound size={14} />
                  <span>{t.toolbar.accounts}</span>
                  <strong>{summary.total}</strong>
                </span>
                <span className="toolbar-stat">
                  <ShieldCheck size={14} />
                  <span>{t.toolbar.available}</span>
                  <strong>{summary.availableCount}</strong>
                </span>
                <span className="toolbar-stat">
                  <CircleOff size={14} />
                  <span>{t.toolbar.nearLimit}</span>
                  <strong>{summary.nearLimitCount}</strong>
                </span>
                <span className="toolbar-stat">
                  <AlertTriangle size={14} />
                  <span>{t.toolbar.errors}</span>
                  <strong>{summary.errorCount}</strong>
                </span>
              </section>

              <div className="toolbar-actions">
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={toggleAllMasks}
                  disabled={accounts.length === 0}
                  title={allAccountsMasked ? t.toolbar.showEmailsTitle : t.toolbar.hideEmailsTitle}
                >
                  {allAccountsMasked ? <EyeOff size={16} /> : <Eye size={16} />}
                  {allAccountsMasked ? t.toolbar.showEmails : t.toolbar.hideEmails}
                </button>
                <button type="button" className="ui-action-button" onClick={() => setIsSettingsOpen(true)}>
                  <Palette size={16} />
                  {t.toolbar.appearance}
                </button>
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={() => {
                    void handleWarmupAll();
                  }}
                  disabled={isWarmingAll || accounts.length === 0}
                >
                  <Activity size={16} className={isWarmingAll ? "pulse-soft" : undefined} />
                  {t.toolbar.warmAll}
                </button>
                <button
                  type="button"
                  className={`ui-action-button ${autoWarmupAllEnabled ? "is-active" : ""}`}
                  onClick={() => setAutoWarmupAllEnabled((enabled) => !enabled)}
                  disabled={accounts.length === 0}
                >
                  <Activity size={16} />
                  {autoWarmupAllEnabled ? t.toolbar.autoWarmupOn : t.toolbar.autoWarmupOff}
                </button>
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={() => {
                    void handleRefresh();
                  }}
                  disabled={isRefreshing}
                >
                  <RefreshCcw size={16} className={isRefreshing ? "spin" : undefined} />
                  {t.toolbar.refresh}
                </button>
              </div>
            </div>

            <div className="dashboard-grid">
              <div className="content-stack">
                {loading && accounts.length === 0 ? (
                  <div className="surface-panel">
                    <div className="loading-state">
                      <div className="loading-state-icon">
                        <RefreshCcw size={24} className="spin" />
                      </div>
                      <h2>{t.states.loadingAccounts}</h2>
                      <p>{t.states.loadingHint}</p>
                    </div>
                  </div>
                ) : error ? (
                  <div className="surface-panel">
                    <div className="error-state">
                      <div className="error-state-icon">
                        <AlertTriangle size={24} />
                      </div>
                      <h2>{isBackendUnavailable ? t.states.backendDisconnected : t.states.failedAccounts}</h2>
                      <p>
                        {isBackendUnavailable
                          ? t.states.backendHint
                          : error}
                      </p>
                    </div>
                  </div>
                ) : accounts.length === 0 ? (
                  <div className="surface-panel">
                    <div className="empty-state">
                      <div className="empty-state-icon">
                        <UserRound size={24} />
                      </div>
                      <h2>{t.sidebar.noAccounts}</h2>
                      <p>{t.states.noAccountsHint}</p>
                      <button
                        type="button"
                        className="ui-action-button is-primary"
                        onClick={() => setIsAddModalOpen(true)}
                      >
                        <BadgePlus size={16} />
                        {t.sidebar.addAccount}
                      </button>
                    </div>
                  </div>
                ) : filteredAccounts.length === 0 ? (
                  <div className="surface-panel">
                    <div className="empty-state">
                      <div className="empty-state-icon">
                        <Search size={24} />
                      </div>
                      <h2>{t.states.noResults}</h2>
                      <p>{t.states.noResultsHint}</p>
                      <button
                        type="button"
                        className="ui-action-button"
                        onClick={() => setAccountSearchQuery("")}
                      >
                        {t.states.clearSearch}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {filteredActiveAccount && (
                      <section className="surface-panel active-account-panel" ref={activeSectionRef}>
                        <div className="panel-body">
                          <div className="active-account-mini" ref={registerAccountRef(filteredActiveAccount.id)}>
                            {(() => {
                              const planVisual = getPlanVisual(filteredActiveAccount);
                              const resetItems = getActiveResetItems(filteredActiveAccount, resolvedLanguage);
                              const isMasked = maskedAccounts.has(filteredActiveAccount.id);
                              const needsReauth =
                                filteredActiveAccount.auth_mode === "chat_g_p_t" &&
                                hasRecoverableAuthError(filteredActiveAccount.usage);
                              const effectiveRemaining = getRemainingPercent(filteredActiveAccount);
                              const tokenExpiryStatus = formatAuthTokenCountdown(
                                filteredActiveAccount.auth_token_expires_at,
                                resolvedLanguage
                              );

                              return (
                                <>
                            <div className={`active-account-mini-icon is-${getAccountHealthTone(filteredActiveAccount)}`}>
                              <ShieldCheck size={18} />
                            </div>
                            <div className="active-account-mini-copy">
                              <div className="active-account-mini-kicker">{t.account.currentAccount}</div>
                              <div className="active-account-mini-name">{filteredActiveAccount.name}</div>
                              {filteredActiveAccount.email && (
                                <div className="active-account-mini-email">
                                  <span className={isMasked ? "masked-text" : ""}>{filteredActiveAccount.email}</span>
                                  {!isMasked && (
                                    <button
                                      type="button"
                                      className="account-copy-email"
                                      onClick={() => copyAccountEmail(filteredActiveAccount)}
                                      title={
                                        copiedEmailAccountId === filteredActiveAccount.id
                                          ? t.account.emailCopied
                                          : t.account.copyEmail
                                      }
                                    >
                                      <Copy size={13} />
                                    </button>
                                  )}
                                </div>
                              )}
                              <div className="active-account-mini-tags">
                                <span className="account-active-chip">
                                  <ShieldCheck size={13} />
                                  {t.account.active}
                                </span>
                                <span className={`account-plan-chip is-plan-${planVisual.tone}`}>
                                  {planVisual.label}
                                </span>
                                <span className={`account-status-pill is-${getAccountHealthTone(filteredActiveAccount)}`}>
                                  {effectiveRemaining !== null
                                    ? `${effectiveRemaining.toFixed(0)}% ${t.account.left}`
                                    : t.account.waitingUsage}
                                </span>
                                {filteredActiveAccount.auth_mode === "chat_g_p_t" && (
                                  <span className={`account-status-pill is-${tokenExpiryStatus.tone}`}>
                                    <KeyRound size={13} />
                                    {tokenExpiryStatus.label}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className={`account-auto-warmup-button ${
                                    autoWarmupAllEnabled ||
                                    autoWarmupAccountIds.has(filteredActiveAccount.id)
                                      ? "is-active"
                                      : ""
                                  }`}
                                  onClick={() => toggleAutoWarmupAccount(filteredActiveAccount.id)}
                                  disabled={autoWarmupAllEnabled}
                                  title={
                                    autoWarmupAllEnabled
                                      ? t.account.autoWarmupManagedByAll
                                      : getAutoWarmupLabel(filteredActiveAccount)
                                  }
                                >
                                  <Activity
                                    size={13}
                                    className={
                                      autoWarmupRunningIds.has(filteredActiveAccount.id)
                                        ? "pulse-soft"
                                        : undefined
                                    }
                                  />
                                  {getAutoWarmupLabel(filteredActiveAccount)}
                                </button>
                                {needsReauth && (
                                  <button
                                    type="button"
                                    className="ui-action-button is-primary active-reauth-button"
                                    onClick={() => setReauthAccount(filteredActiveAccount)}
                                  >
                                    <KeyRound size={14} />
                                    {t.account.refreshLogin}
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className={`active-account-mini-rail ${resetItems.length === 1 ? "is-single" : ""}`}>
                              {resetItems.length > 0 ? (
                                resetItems.map((item) => (
                                  <div key={item.key} className={`active-limit-meter is-${item.tone}`}>
                                    <div className="active-limit-meter-head">
                                      <span>{item.label}</span>
                                      {item.remaining !== null && <strong>{item.remaining.toFixed(0)}%</strong>}
                                    </div>
                                    <div className="active-limit-track" aria-hidden="true">
                                      <span style={{ width: `${Math.max(0, Math.min(100, item.remaining ?? 0))}%` }} />
                                    </div>
                                    <em>{t.account.reset}: {formatResetCountdown(item.resetsAt, resolvedLanguage)}</em>
                                  </div>
                                ))
                              ) : (
                                <div className="active-limit-meter is-muted">
                                  <div className="active-limit-meter-head">
                                    <span>{t.account.noRateLimit}</span>
                                  </div>
                                  <div className="active-limit-track" aria-hidden="true">
                                    <span style={{ width: "0%" }} />
                                  </div>
                                  <em>{t.account.waitingUsage}</em>
                                </div>
                              )}
                            </div>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      </section>
                    )}

                    {sortedOtherAccounts.length > 0 && (
                      <section className="surface-panel">
                        <div className="surface-panel-header">
                          <div className="surface-panel-title">
                            <LayoutPanelLeft size={18} />
                            <div>
                              <h2>{t.pool.title}</h2>
                              <p>{t.pool.subtitle}</p>
                            </div>
                          </div>

                          <div className="controls-row">
                            <div className="ui-select-wrap">
                              <select
                                value={otherAccountsSort}
                                onChange={(event) => setOtherAccountsSort(event.target.value as SortMode)}
                                className="ui-select"
                              >
                                {(Object.keys(sortLabels) as SortMode[]).map((value) => (
                                  <option key={value} value={value}>
                                    {t.sort[value]}
                                  </option>
                                ))}
                              </select>
                              <ChevronDown size={16} />
                            </div>
                          </div>
                        </div>

                        <div className="panel-body">
                          <div className="accounts-grid">
                            {sortedOtherAccounts.map((account) => (
                              <div key={account.id} ref={registerAccountRef(account.id)}>
                                <AccountCard
                                  account={account}
                                  onSwitch={() => {
                                    void handleSwitch(account.id);
                                  }}
                                  onWarmup={() => handleWarmupAccount(account.id, account.name)}
                                  onDelete={() => handleDelete(account.id)}
                                  onRefresh={async () => {
                                    await refreshSingleUsage(account.id, { refreshMetadata: true });
                                  }}
                                  onRename={(newName) => renameAccount(account.id, newName)}
                                  onReauthorize={() => setReauthAccount(account)}
                                  switching={switchingId === account.id}
                                  warmingUp={
                                    isWarmingAll ||
                                    warmingUpId === account.id ||
                                    autoWarmupRunningIds.has(account.id)
                                  }
                                  autoWarmupEnabled={
                                    autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id)
                                  }
                                  autoWarmupManagedByAll={autoWarmupAllEnabled}
                                  autoWarmupLabel={getAutoWarmupLabel(account)}
                                  onToggleAutoWarmup={() => toggleAutoWarmupAccount(account.id)}
                                  masked={maskedAccounts.has(account.id)}
                                  onToggleMask={() => toggleMask(account.id)}
                                  locale={resolvedLanguage}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </section>
                    )}
                  </>
                )}
              </div>
            </div>
          </main>
        </div>
      </div>

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
          hasAccounts={accounts.length > 0}
          onThemeChange={setThemePreference}
          onLanguageChange={setLanguagePreference}
          onAccentChange={setAccentPreset}
          onCardDensityChange={setCardDensity}
          onTrayModeChange={setTrayModeEnabled}
          onClose={() => setIsSettingsOpen(false)}
          onOpenImportSlim={() => {
            setIsSettingsOpen(false);
            openImportSlimTextModal();
          }}
          onExportSlim={() => {
            setIsSettingsOpen(false);
            void handleExportSlimText();
          }}
          onImportFull={() => {
            setIsSettingsOpen(false);
            void handleImportFullFile();
          }}
          onExportFull={() => {
            setIsSettingsOpen(false);
            void handleExportFullFile();
          }}
        />
      )}

      <AddAccountModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onImportFile={importFromFile}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
        locale={resolvedLanguage}
      />

      <AddAccountModal
        isOpen={reauthAccount !== null}
        mode="reauthorize"
        lockedAccountName={reauthAccount?.name}
        onClose={() => setReauthAccount(null)}
        onImportFile={importFromFile}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={() => {
          if (!reauthAccount) return Promise.reject(new Error("No account selected"));
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
          onSubmit={() => {
            void handleImportSlimText();
          }}
          onCopy={() => {
            if (!configPayload) return;
            void navigator.clipboard
              .writeText(configPayload)
              .then(() => {
                setConfigCopied(true);
                setTimeout(() => setConfigCopied(false), 1500);
              })
              .catch(() => {
                setConfigModalError(
                  resolvedLanguage === "ru"
                    ? "Буфер обмена недоступен. Скопируй payload вручную."
                    : "Clipboard unavailable. Copy the payload manually."
                );
              });
          }}
        />
      )}

      <div className="app-toast-stack" aria-live="polite">
        {refreshSuccess && (
          <div className="app-toast is-success fade-up">
            <ShieldCheck size={18} />
            Usage refreshed successfully
          </div>
        )}

        {warmupToast && (
          <div className={`app-toast ${warmupToast.isError ? "is-danger" : "is-warning"} fade-up`}>
            {warmupToast.isError ? <AlertTriangle size={18} /> : <Activity size={18} />}
            {warmupToast.message}
          </div>
        )}

      </div>

      <UpdateChecker locale={resolvedLanguage} />
    </div>
  );
}

export default App;
