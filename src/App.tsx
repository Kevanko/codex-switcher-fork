import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  BadgePlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  Crown,
  Database,
  Download,
  FolderInput,
  LayoutPanelLeft,
  Monitor,
  Palette,
  PanelLeftOpen,
  RefreshCcw,
  Search,
  Settings2,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { useAccounts } from "./hooks/useAccounts";
import { AccountCard, AddAccountModal, UpdateChecker } from "./components";
import type { AccountWithUsage, CodexProcessInfo } from "./types";
import {
  exportFullBackupFile,
  importFullBackupFile,
  invokeBackend,
  isTauriRuntime,
} from "./lib/platform";
import { getPlanVisual } from "./lib/accountVisuals";
import "./App.css";

const THEME_STORAGE_KEY = "codex-switcher-theme";
const ACCENT_STORAGE_KEY = "codex-switcher-accent";
const SIDEBAR_STORAGE_KEY = "codex-switcher-sidebar-expanded";
const OTHER_ACCOUNTS_SORT_STORAGE_KEY = "codex-switcher-other-accounts-sort";
const CARD_DENSITY_STORAGE_KEY = "codex-switcher-card-density";

type ThemeMode = "light" | "dark";
type AccentPreset = "green" | "cyan" | "blue" | "amber" | "rose";
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

function getRemainingPercent(account: AccountWithUsage) {
  if (account.usage?.primary_used_percent === null || account.usage?.primary_used_percent === undefined) {
    return null;
  }

  return Math.max(0, 100 - account.usage.primary_used_percent);
}

function isAccountNearLimit(account: AccountWithUsage) {
  const remaining = getRemainingPercent(account);
  return remaining !== null && remaining <= 30;
}

function getAccountHealthTone(account: AccountWithUsage): "success" | "warning" | "danger" | "muted" {
  if (account.usage?.error) return "danger";
  const remaining = getRemainingPercent(account);
  if (remaining === null) return "muted";
  if (remaining <= 10) return "danger";
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
        getResetDeadline(a.usage?.primary_resets_at) - getResetDeadline(b.usage?.primary_resets_at);
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
      getResetDeadline(a.usage?.primary_resets_at) - getResetDeadline(b.usage?.primary_resets_at);
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
}: {
  account: AccountWithUsage;
  expanded: boolean;
  onSelect: () => void;
  pending: boolean;
  switching: boolean;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}) {
  const tone = getAccountHealthTone(account);
  const remaining = getRemainingPercent(account);
  const planVisual = getPlanVisual(account);
  const compactStatus = remaining !== null ? `${remaining.toFixed(0)}%` : planVisual.shortLabel;
  const statusText =
    tone === "danger"
      ? account.usage?.error
        ? "Usage error"
        : "Critical limit"
      : tone === "warning"
        ? "Near limit"
        : tone === "success"
          ? remaining !== null
            ? `${remaining.toFixed(0)}% left`
            : "Healthy"
          : "Waiting";

  return (
    <div className={`sidebar-account-wrap ${pending ? "has-confirm" : ""}`}>
      <button
        type="button"
        className={`sidebar-account ${account.is_active ? "is-active" : ""}`}
        onClick={onSelect}
        title={expanded ? undefined : `${account.name} - ${planVisual.label} - ${statusText}`}
      >
        <span className={`sidebar-account-badge is-${tone} is-plan-${planVisual.tone}`}>
          {planVisual.premium && <Crown className="sidebar-plan-crown" size={11} />}
          <UserRound size={18} />
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
          {expanded && <span>Switch to {account.name}?</span>}
          <button
            type="button"
            className="ui-action-button is-primary"
            onClick={onConfirmSwitch}
            disabled={switching}
            title={`Switch to ${account.name}`}
          >
            <ShieldCheck size={14} />
            {expanded && (switching ? "Switching" : "Switch")}
          </button>
          <button
            type="button"
            className="ui-icon-button"
            onClick={onCancelSwitch}
            title="Cancel switch"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  note,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="summary-card">
      <div className="summary-icon">{icon}</div>
      <div className="summary-label">{label}</div>
      <div className="summary-value">{value}</div>
      <div className="summary-note">{note}</div>
    </div>
  );
}

function SettingsPanel({
  themeMode,
  accentPreset,
  cardDensity,
  isExportingFull,
  isImportingFull,
  hasAccounts,
  onThemeChange,
  onAccentChange,
  onCardDensityChange,
  onClose,
  onOpenImportSlim,
  onExportSlim,
  onImportFull,
  onExportFull,
}: {
  themeMode: ThemeMode;
  accentPreset: AccentPreset;
  cardDensity: CardDensity;
  isExportingFull: boolean;
  isImportingFull: boolean;
  hasAccounts: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onAccentChange: (preset: AccentPreset) => void;
  onCardDensityChange: (density: CardDensity) => void;
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
            <h2>Settings</h2>
            <p>Fine-tune the shell, colors, and account management tools.</p>
          </div>
          <button type="button" className="ui-icon-button" onClick={onClose} title="Close settings">
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div>
              <h3>Theme</h3>
              <p>Keep the interface balanced for both light and dark modes.</p>
            </div>
            <div className="segment-row">
              <button
                type="button"
                className={`ui-segment-button ${themeMode === "light" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("light")}
              >
                Light
              </button>
              <button
                type="button"
                className={`ui-segment-button ${themeMode === "dark" ? "is-selected" : ""}`}
                onClick={() => onThemeChange("dark")}
              >
                Dark
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div>
              <h3>Accent color</h3>
              <p>Used for active states, summary visuals, and usage highlights.</p>
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
              <h3>Card density</h3>
              <p>Controls account card size without changing account data.</p>
            </div>
            <div className="segment-row is-density">
              {(Object.entries(cardDensityLabels) as [CardDensity, string][]).map(([density, label]) => (
                <button
                  key={density}
                  type="button"
                  className={`ui-segment-button ${cardDensity === density ? "is-selected" : ""}`}
                  onClick={() => onCardDensityChange(density)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <div>
              <h3>Account management</h3>
              <p>Secondary import and backup tools live here instead of the top toolbar.</p>
            </div>
            <div className="settings-actions-grid">
              <button
                type="button"
                className="ui-action-button"
                onClick={onExportSlim}
                disabled={!hasAccounts}
              >
                <Download size={16} />
                Export slim text
              </button>
              <button type="button" className="ui-action-button" onClick={onOpenImportSlim}>
                <Upload size={16} />
                Import slim text
              </button>
              <button
                type="button"
                className="ui-action-button"
                onClick={onExportFull}
                disabled={isExportingFull || !hasAccounts}
              >
                <Database size={16} />
                {isExportingFull ? "Exporting backup" : "Export full backup"}
              </button>
              <button
                type="button"
                className="ui-action-button"
                onClick={onImportFull}
                disabled={isImportingFull}
              >
                <FolderInput size={16} />
                {isImportingFull ? "Importing backup" : "Import full backup"}
              </button>
            </div>
          </section>

          <div className="settings-note">
            The interface theme and accent are stored locally for this desktop profile only.
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
            <h2>{isExport ? "Export slim text" : "Import slim text"}</h2>
            <p>
              {isExport
                ? "This payload contains account secrets. Keep it private."
                : "Existing accounts stay in place. Only missing accounts are imported."}
            </p>
          </div>
          <button type="button" className="ui-icon-button" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="config-body">
          {!isExport && (
            <div className="inline-alert is-warning">
              <AlertTriangle size={16} />
              Existing accounts stay intact. Missing accounts from the payload are added.
            </div>
          )}

          <textarea
            value={payload}
            onChange={(event) => onPayloadChange(event.target.value)}
            readOnly={isExport}
            placeholder={isExport ? (loading ? "Generating payload..." : "Export payload") : "Paste config string here"}
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
              Close
            </button>
            {isExport ? (
              <button
                type="button"
                className="ui-action-button is-primary"
                onClick={onCopy}
                disabled={!payload || loading}
              >
                {copied ? "Copied" : "Copy payload"}
              </button>
            ) : (
              <button type="button" className="ui-action-button is-primary" onClick={onSubmit} disabled={loading}>
                {loading ? "Importing" : "Import missing accounts"}
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
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
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
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
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
  const [accountSearchQuery, setAccountSearchQuery] = useState("");
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const deferredSearchQuery = useDeferredValue(accountSearchQuery);
  const activeSectionRef = useRef<HTMLDivElement | null>(null);
  const accountRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const accentTheme = accentPresets[accentPreset];

  const handleTitlebarDrag = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!isTauriRuntime() || event.button !== 0 || !currentWindow) return;
    void currentWindow.startDragging();
  }, []);

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime() || !currentWindow) return;
    void currentWindow.toggleMaximize();
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
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);

  useEffect(() => {
    const isDark = themeMode === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage errors for this session.
    }
  }, [themeMode]);

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

    const syncMaximizedState = async () => {
      try {
        setIsWindowMaximized(await currentWindow.isMaximized());
      } catch (err) {
        console.error("Failed to read window state:", err);
      }
    };

    void syncMaximizedState();

    currentWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to watch window resize:", err);
      });

    return () => {
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

  const showWarmupToast = (message: string, isError = false) => {
    setWarmupToast({ message, isError });
    setTimeout(() => setWarmupToast(null), 2500);
  };

  const formatWarmupError = (err: unknown) => {
    if (!err) return "Unknown error";
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  };

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      showWarmupToast(`Warm-up request sent for ${accountName}`);
    } catch (err) {
      console.error("Failed to warm up account:", err);
      showWarmupToast(`Warm-up failed for ${accountName}: ${formatWarmupError(err)}`, true);
    } finally {
      setWarmingUpId(null);
    }
  };

  const handleWarmupAll = async () => {
    try {
      setIsWarmingAll(true);
      const summary = await warmupAllAccounts();
      if (summary.total_accounts === 0) {
        showWarmupToast("No accounts available for warm-up", true);
        return;
      }

      if (summary.failed_account_ids.length === 0) {
        showWarmupToast(`Warm-up sent for ${summary.warmed_accounts} account${summary.warmed_accounts === 1 ? "" : "s"}`);
      } else {
        showWarmupToast(
          `Warmed ${summary.warmed_accounts}/${summary.total_accounts}. Failed: ${summary.failed_account_ids.length}`,
          true
        );
      }
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      showWarmupToast(`Warm-up all failed: ${formatWarmupError(err)}`, true);
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
      showWarmupToast(`Slim text exported for ${accounts.length} account${accounts.length === 1 ? "" : "s"}.`);
    } catch (err) {
      console.error("Failed to export slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim export failed", true);
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
      setConfigModalError("Paste the slim text payload first.");
      return;
    }

    try {
      setIsImportingSlim(true);
      setConfigModalError(null);
      const summary = await importAccountsSlimText(configPayload);
      setMaskedAccounts(new Set());
      setIsConfigModalOpen(false);
      showWarmupToast(
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count}, total ${summary.total_in_payload}`
      );
    } catch (err) {
      console.error("Failed to import slim text:", err);
      const message = err instanceof Error ? err.message : String(err);
      setConfigModalError(message);
      showWarmupToast("Slim import failed", true);
    } finally {
      setIsImportingSlim(false);
    }
  };

  const handleExportFullFile = async () => {
    try {
      setIsExportingFull(true);
      const exported = await exportFullBackupFile();
      if (!exported) return;
      showWarmupToast("Encrypted backup exported.");
    } catch (err) {
      console.error("Failed to export full encrypted file:", err);
      showWarmupToast("Full export failed", true);
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
        `Imported ${summary.imported_count}, skipped ${summary.skipped_count}, total ${summary.total_in_payload}`
      );
    } catch (err) {
      console.error("Failed to import full encrypted file:", err);
      showWarmupToast("Full import failed", true);
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
    const activeCount = activeAccount ? 1 : 0;
    return { total, errorCount, nearLimitCount, activeCount };
  }, [accounts, activeAccount]);

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
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const topToolbarInfo = hasRunningProcesses
    ? `${processInfo?.count ?? 0} running Codex process${processInfo?.count === 1 ? "" : "es"}`
    : "Ready to switch";

  return (
    <div className={`app-shell density-${cardDensity}`} style={shellStyle}>
      <div className="app-frame">
        <aside className={`app-sidebar ${isSidebarExpanded ? "is-expanded" : ""}`}>
          <div className="sidebar-section">
            <div className="sidebar-top">
              <div className="brand-mark">
                <LayoutPanelLeft size={20} />
              </div>
              <div className="brand-copy">
                <div className="brand-title">Codex Switcher</div>
                <div className="brand-subtitle">Account control surface</div>
              </div>
              <button
                type="button"
                className="ui-icon-button"
                style={{ marginLeft: "auto" }}
                onClick={() => setIsSidebarExpanded((prev) => !prev)}
                title={isSidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
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
                  placeholder="Find account"
                  aria-label="Find account"
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
                title="Add account"
              >
                <BadgePlus size={16} />
                {isSidebarExpanded && "Add account"}
              </button>
              <button
                type="button"
                className="ui-action-button"
                onClick={() => setIsSettingsOpen(true)}
                style={isSidebarExpanded ? undefined : narrowButtonStyle}
                title="Open settings"
              >
                <Settings2 size={16} />
                {isSidebarExpanded && "Settings"}
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
                      {accounts.length === 0 ? "No accounts yet" : "No matching accounts"}
                    </h2>
                    <p>
                      {accounts.length === 0
                        ? "Add an account to populate the quick rail."
                        : "Try a different name, email, or plan filter."}
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

        <div className="main-shell">
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
                    void currentWindow.minimize();
                  }}
                  title="Minimize"
                >
                  <ChevronDown size={16} />
                </button>
                <button
                  type="button"
                  className="ui-icon-button"
                  onClick={() => {
                    void currentWindow.toggleMaximize();
                  }}
                  title={isWindowMaximized ? "Restore" : "Maximize"}
                >
                  {isWindowMaximized ? <PanelLeftOpen size={16} /> : <Monitor size={16} />}
                </button>
                <button
                  type="button"
                  className="ui-icon-button is-danger"
                  onClick={() => {
                    void currentWindow.close();
                  }}
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </header>

          <main className="window-main">
            <div className="toolbar">
              <div className="toolbar-copy">
                <h1>Strict control, calmer surface.</h1>
                <p>
                  Track active capacity, jump between accounts quickly, and keep all management
                  actions in one restrained matte-tech shell.
                </p>
              </div>

              <div className="toolbar-actions">
                <div className="toolbar-pill">
                  <span className={`status-dot is-${hasRunningProcesses ? "warning" : "success"}`} />
                  {topToolbarInfo}
                </div>
                <button type="button" className="ui-action-button" onClick={() => setIsSettingsOpen(true)}>
                  <Palette size={16} />
                  Appearance
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
                  Warm up all
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
                  Refresh
                </button>
              </div>
            </div>

            <div className="dashboard-grid">
              <section className="summary-grid">
                <SummaryCard
                  icon={<UserRound size={18} />}
                  label="Accounts"
                  value={String(summary.total)}
                  note={`${summary.total === 0 ? "No accounts yet" : `${summary.total} profiles available`}`}
                />
                <SummaryCard
                  icon={<ShieldCheck size={18} />}
                  label="Active"
                  value={String(summary.activeCount)}
                  note={activeAccount ? activeAccount.name : "No active account"}
                />
                <SummaryCard
                  icon={<CircleOff size={18} />}
                  label="Near limit"
                  value={String(summary.nearLimitCount)}
                  note={summary.nearLimitCount > 0 ? "Needs rotation soon" : "No accounts under pressure"}
                />
                <SummaryCard
                  icon={<AlertTriangle size={18} />}
                  label="Errors"
                  value={String(summary.errorCount)}
                  note={summary.errorCount > 0 ? "Review failed usage fetches" : "No usage errors detected"}
                />
              </section>

              <div className="content-stack">
                {loading && accounts.length === 0 ? (
                  <div className="surface-panel">
                    <div className="loading-state">
                      <div className="loading-state-icon">
                        <RefreshCcw size={24} className="spin" />
                      </div>
                      <h2>Loading accounts</h2>
                      <p>Pulling account list and cached usage data into the new shell.</p>
                    </div>
                  </div>
                ) : error ? (
                  <div className="surface-panel">
                    <div className="error-state">
                      <div className="error-state-icon">
                        <AlertTriangle size={24} />
                      </div>
                      <h2>{isBackendUnavailable ? "Backend is not connected" : "Failed to load accounts"}</h2>
                      <p>
                        {isBackendUnavailable
                          ? "The static preview does not include the account API. Run the Tauri app or `pnpm lan` once Rust is available to inspect the live dashboard."
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
                      <h2>No accounts yet</h2>
                      <p>Add your first Codex account to start switching, tracking limits, and organizing access.</p>
                      <button
                        type="button"
                        className="ui-action-button is-primary"
                        onClick={() => setIsAddModalOpen(true)}
                      >
                        <BadgePlus size={16} />
                        Add account
                      </button>
                    </div>
                  </div>
                ) : filteredAccounts.length === 0 ? (
                  <div className="surface-panel">
                    <div className="empty-state">
                      <div className="empty-state-icon">
                        <Search size={24} />
                      </div>
                      <h2>No results</h2>
                      <p>Nothing matches the current search. Clear the filter or try a different keyword.</p>
                      <button
                        type="button"
                        className="ui-action-button"
                        onClick={() => setAccountSearchQuery("")}
                      >
                        Clear search
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {filteredActiveAccount && (
                      <section className="surface-panel" ref={activeSectionRef}>
                        <div className="surface-panel-header">
                          <div className="surface-panel-title">
                            <ShieldCheck size={18} />
                            <div>
                              <h2>Active account</h2>
                              <p>Primary account stays isolated with the strongest visual priority.</p>
                            </div>
                          </div>
                        </div>
                        <div className="panel-body">
                          <div ref={registerAccountRef(filteredActiveAccount.id)}>
                            <AccountCard
                              account={filteredActiveAccount}
                              onSwitch={() => {}}
                              onWarmup={() =>
                                handleWarmupAccount(filteredActiveAccount.id, filteredActiveAccount.name)
                              }
                              onDelete={() => handleDelete(filteredActiveAccount.id)}
                              onRefresh={() =>
                                refreshSingleUsage(filteredActiveAccount.id, { refreshMetadata: true })
                              }
                              onRename={(newName) => renameAccount(filteredActiveAccount.id, newName)}
                              switching={switchingId === filteredActiveAccount.id}
                              warmingUp={isWarmingAll || warmingUpId === filteredActiveAccount.id}
                              masked={maskedAccounts.has(filteredActiveAccount.id)}
                              onToggleMask={() => toggleMask(filteredActiveAccount.id)}
                            />
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
                              <h2>Account pool</h2>
                              <p>Jump between standby accounts with cleaner states and calmer hierarchy.</p>
                            </div>
                          </div>

                          <div className="controls-row">
                            <div className="ui-select-wrap">
                              <select
                                value={otherAccountsSort}
                                onChange={(event) => setOtherAccountsSort(event.target.value as SortMode)}
                                className="ui-select"
                              >
                                {Object.entries(sortLabels).map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
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
                                  onRefresh={() => refreshSingleUsage(account.id, { refreshMetadata: true })}
                                  onRename={(newName) => renameAccount(account.id, newName)}
                                  switching={switchingId === account.id}
                                  warmingUp={isWarmingAll || warmingUpId === account.id}
                                  masked={maskedAccounts.has(account.id)}
                                  onToggleMask={() => toggleMask(account.id)}
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
          themeMode={themeMode}
          accentPreset={accentPreset}
          cardDensity={cardDensity}
          isExportingFull={isExportingFull}
          isImportingFull={isImportingFull}
          hasAccounts={accounts.length > 0}
          onThemeChange={setThemeMode}
          onAccentChange={setAccentPreset}
          onCardDensityChange={setCardDensity}
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
      />

      {isConfigModalOpen && (
        <ConfigModal
          mode={configModalMode}
          payload={configPayload}
          error={configModalError}
          loading={configModalMode === "slim_export" ? isExportingSlim : isImportingSlim}
          copied={configCopied}
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
                setConfigModalError("Clipboard unavailable. Copy the payload manually.");
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

      <UpdateChecker />
    </div>
  );
}

export default App;
