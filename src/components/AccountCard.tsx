import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Copy,
  Crown,
  Eye,
  EyeOff,
  KeyRound,
  PencilLine,
  RefreshCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { AccountWithUsage } from "../types";
import { getPlanVisual } from "../lib/accountVisuals";
import { getEffectiveRemainingPercent, hasRecoverableAuthError } from "../lib/usageModel";
import { getDateLocale, translations, type Locale } from "../i18n";
import { UsageBar } from "./UsageBar";

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onWarmup?: () => Promise<void>;
  onDelete: () => void;
  onRefresh?: () => Promise<void>;
  onRename: (newName: string) => Promise<void>;
  onReauthorize?: () => void;
  switching?: boolean;
  warmingUp?: boolean;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
  masked?: boolean;
  onToggleMask?: () => void;
  locale?: Locale;
}

function formatLastRefresh(date: Date | null, locale: Locale): string {
  const t = translations[locale];
  if (!date) return t.account.noCachedUsage;

  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 5) return t.account.justNow;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Intl.DateTimeFormat(getDateLocale(locale), {
    month: "short",
    day: "numeric",
  }).format(date);
}

function getSubscriptionStatus(timestamp: string | null | undefined, locale: Locale) {
  const t = translations[locale];
  if (!timestamp) {
    return {
      label: t.account.expiryUnavailable,
      tone: "muted",
    } as const;
  }

  const expiryDate = new Date(timestamp);
  const remainingMs = expiryDate.getTime() - Date.now();
  const formattedDate = new Intl.DateTimeFormat(getDateLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  if (remainingMs <= 0) {
    return { label: `${t.account.expired} ${formattedDate}`, tone: "danger" } as const;
  }

  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return { label: `${t.account.ends} ${formattedDate}`, tone: "danger" } as const;
  }

  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return { label: `${t.account.ends} ${formattedDate}`, tone: "warning" } as const;
  }

  return { label: `${t.account.ends} ${formattedDate}`, tone: "muted" } as const;
}

function formatTokenExpiry(timestamp: string | null | undefined, locale: Locale): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
} {
  const t = translations[locale];
  if (!timestamp) {
    return { label: t.account.authTokenUnknown, tone: "muted" };
  }

  const remainingMs = new Date(timestamp).getTime() - Date.now();
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

function getUsageState(account: AccountWithUsage, locale: Locale): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
} {
  const t = translations[locale];
  if (account.usage?.error) {
    return { label: t.account.usageError, tone: "danger" };
  }

  const remaining = getEffectiveRemainingPercent(account);
  if (remaining === null) {
    return { label: t.account.waitingUsage, tone: "muted" };
  }

  if (remaining <= 0) return { label: t.account.criticalLimit, tone: "danger" };
  if (remaining <= 10) return { label: t.account.approachingLimit, tone: "warning" };
  return { label: t.account.healthyCapacity, tone: "success" };
}

function BlurredText({ children, blur }: { children: ReactNode; blur: boolean }) {
  return <span className={blur ? "masked-text" : ""}>{children}</span>;
}

export function AccountCard({
  account,
  onSwitch,
  onWarmup,
  onDelete,
  onRefresh,
  onRename,
  onReauthorize,
  switching,
  warmingUp,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
  masked = false,
  onToggleMask,
  locale = "en",
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.cached_usage_updated_at ? new Date(account.cached_usage_updated_at) : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [, setClockTick] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setClockTick(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setEditName(account.name);
    if (account.cached_usage_updated_at) {
      setLastRefresh(new Date(account.cached_usage_updated_at));
    } else if (!account.usage || account.usage.error) {
      setLastRefresh(null);
    }
  }, [account.cached_usage_updated_at, account.name, account.usage]);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
      setLastRefresh(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      void handleRename();
    } else if (event.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const t = translations[locale];
  const isClaude = account.provider === "claude";
  const planVisual = getPlanVisual(account);
  const usageState = getUsageState(account, locale);
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at, locale);
  const tokenExpiryStatus = formatTokenExpiry(account.auth_token_expires_at, locale);
  const needsReauth =
    account.auth_mode === "chat_g_p_t" && hasRecoverableAuthError(account.usage);

  const copyEmail = () => {
    if (!account.email || masked) return;
    void navigator.clipboard
      .writeText(account.email)
      .then(() => {
        setEmailCopied(true);
        setTimeout(() => setEmailCopied(false), 1600);
      })
      .catch(() => {});
  };

  return (
    <article className={`account-card fade-up ${account.is_active ? "is-active" : ""}`}>
      <div className="account-card-header">
        <div className="account-card-meta">
          <div className="account-card-topline">
            {account.is_active && (
              <span className="account-active-chip">
                <ShieldCheck size={14} />
                {t.account.active}
              </span>
            )}
            <span className={`account-plan-chip is-plan-${planVisual.tone}`}>
              {planVisual.premium && <Crown size={13} />}
              {planVisual.label}
            </span>
            {isClaude && <span className="account-provider-chip">Claude</span>}
          </div>

          <div className="account-card-name-row">
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                onBlur={() => {
                  void handleRename();
                }}
                onKeyDown={handleKeyDown}
                className="account-name-input"
              />
            ) : (
              <button
                type="button"
                className="account-name-button"
                onClick={() => {
                  if (masked) return;
                  setIsEditing(true);
                }}
                title={masked ? t.account.revealToRename : t.account.rename}
              >
                <span className="account-name">
                  <BlurredText blur={masked}>{account.name}</BlurredText>
                </span>
                {!masked && <PencilLine size={15} />}
              </button>
            )}
          </div>

          {account.email && (
            <div className="account-email-row">
              <p className="account-email">
                <BlurredText blur={masked}>{account.email}</BlurredText>
              </p>
              {!masked && (
                <button
                  type="button"
                  className="account-copy-email"
                  onClick={copyEmail}
                  title={emailCopied ? t.account.emailCopied : t.account.copyEmail}
                >
                  <Copy size={13} />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="account-card-actions-compact">
          {onToggleMask && (
            <button
              type="button"
              onClick={onToggleMask}
              className="ui-icon-button"
              title={masked ? t.account.showDetails : t.account.hideDetails}
            >
              {masked ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
        </div>
      </div>

      <div className="account-status-row">
        <span className={`account-status-pill is-${usageState.tone}`}>{usageState.label}</span>
        {needsReauth && (
          <span className="account-status-pill is-warning">
            <KeyRound size={13} />
            {t.account.authNeedsRefresh}
          </span>
        )}
        {account.auth_mode === "chat_g_p_t" && (
          <span className={`account-status-pill is-${subscriptionStatus.tone}`}>
            {subscriptionStatus.label}
          </span>
        )}
        {isClaude && account.claude_rate_limit_tier && (
          <span className="account-status-pill is-muted">
            {t.account.rateTier}: {account.claude_rate_limit_tier}
          </span>
        )}
        {(account.auth_mode === "chat_g_p_t" || isClaude) && (
          <span className={`account-status-pill is-${tokenExpiryStatus.tone}`}>
            <KeyRound size={13} />
            {tokenExpiryStatus.label}
          </span>
        )}
        {!isClaude && onToggleAutoWarmup && (
          <button
            type="button"
            className={`account-auto-warmup-button ${autoWarmupEnabled ? "is-active" : ""}`}
            onClick={onToggleAutoWarmup}
            disabled={autoWarmupManagedByAll}
            title={autoWarmupManagedByAll ? t.account.autoWarmupManagedByAll : autoWarmupLabel}
          >
            <Activity size={13} className={warmingUp ? "pulse-soft" : undefined} />
            {autoWarmupLabel ?? t.account.autoWarmupOff}
          </button>
        )}
      </div>

      {isClaude ? (
        <div className="claude-account-details">
          <div>
            <span>{t.account.provider}</span>
            <strong>Claude</strong>
          </div>
          <div>
            <span>{t.account.organization}</span>
            <strong>
              <BlurredText blur={masked}>
                {account.claude_organization_uuid || t.common.unknown}
              </BlurredText>
            </strong>
          </div>
          <div>
            <span>{t.account.subscription}</span>
            <strong>{account.claude_subscription_type || account.plan_type || t.common.unknown}</strong>
          </div>
        </div>
      ) : (
        <UsageBar
          account={account}
          usage={account.usage}
          loading={isRefreshing || account.usageLoading}
          locale={locale}
        />
      )}

      <div className="account-footnotes">
        <div>{t.account.lastUpdated} {formatLastRefresh(lastRefresh, locale)}</div>
        <div>
          {isClaude
            ? t.account.claudeCredentials
            : account.auth_mode === "api_key"
              ? t.account.importedKey
              : t.account.chatgptLogin}
        </div>
      </div>

      {confirmingDelete && (
        <div className="account-delete-confirm fade-up">
          <span>{t.account.deleteQuestion}</span>
          <div className="account-delete-actions">
            <button type="button" className="ui-action-button is-ghost" onClick={() => setConfirmingDelete(false)}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="ui-action-button is-danger"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              {t.account.delete}
            </button>
          </div>
        </div>
      )}

      <div className={`account-actions ${isClaude ? "is-claude" : ""}`}>
        {needsReauth && onReauthorize ? (
          <button type="button" onClick={onReauthorize} className="ui-action-button is-primary">
            <KeyRound size={16} />
            {t.account.refreshLogin}
          </button>
        ) : account.is_active ? (
          <button type="button" disabled className="ui-action-button">
            <ShieldCheck size={16} />
            {t.account.currentAccount}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSwitch}
            disabled={switching}
            className="ui-action-button is-primary"
          >
            <ShieldCheck size={16} />
            {switching ? t.sidebar.switching : t.sidebar.switch}
          </button>
        )}

        {!isClaude && onWarmup && (
          <button
            type="button"
            onClick={() => {
              void onWarmup();
            }}
            disabled={warmingUp}
            className="ui-icon-button"
            title={warmingUp ? t.account.sendingWarmup : t.account.sendWarmup}
          >
            <Activity size={16} className={warmingUp ? "pulse-soft" : undefined} />
          </button>
        )}

        {!isClaude && onRefresh && (
          <button
            type="button"
            onClick={() => {
              void handleRefresh();
            }}
            disabled={isRefreshing}
            className="ui-icon-button"
            title={t.account.refreshUsage}
          >
            <RefreshCcw size={16} className={isRefreshing ? "spin" : undefined} />
          </button>
        )}

        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="ui-icon-button is-danger"
          title={t.account.delete}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}
