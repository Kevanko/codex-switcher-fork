import { AlertCircle, Clock3, Coins } from "lucide-react";
import type { AccountWithUsage, UsageInfo } from "../types";
import { getVisibleLimitWindows, type VisibleLimitWindow } from "../lib/usageModel";
import { getDateLocale, translations, type Locale } from "../i18n";

interface UsageBarProps {
  account: AccountWithUsage;
  usage?: UsageInfo;
  loading?: boolean;
  locale?: Locale;
}

function formatResetTime(resetAt: number | null | undefined, locale: Locale): string {
  if (!resetAt) return translations[locale].common.unknown;

  const now = Math.floor(Date.now() / 1000);
  const diff = resetAt - now;
  if (diff <= 0) return translations[locale].common.now;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatExactResetTime(resetAt: number | null | undefined, locale: Locale): string {
  if (!resetAt) return translations[locale].account.noResetTime;

  return new Intl.DateTimeFormat(getDateLocale(locale), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt * 1000));
}

function formatWindowDuration(minutes: number | null | undefined, locale: Locale): string {
  if (!minutes) return "";
  const windowLabel = translations[locale].account.window;
  if (minutes < 60) return `${minutes}m ${windowLabel}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${windowLabel}`;
  return `${Math.floor(hours / 24)}d ${windowLabel}`;
}

function formatLimitLabel(window: VisibleLimitWindow, locale: Locale): string {
  const t = translations[locale];
  if (window.kind === "primary") return t.account.primaryWindow;
  if (window.kind === "weekly") return t.account.weeklyWindow;

  const duration = formatWindowDuration(window.windowMinutes, locale);
  return duration ? `${t.account.limit} ${duration.replace(` ${t.account.window}`, "")}` : t.account.primaryWindow;
}

function getToneClass(remainingPercent: number) {
  if (remainingPercent <= 0) return "is-danger";
  if (remainingPercent <= 10) return "is-warning";
  return "is-accent";
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
  locale,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  locale: Locale;
}) {
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const toneClass = getToneClass(remainingPercent);
  const t = translations[locale];
  const duration = formatWindowDuration(windowMinutes, locale);

  return (
    <div className="usage-block">
      <div className="usage-meta">
        <div>
          <div className="usage-label">{label}</div>
          <div className="usage-note">
            {duration ? `${duration} - ` : ""}
            {t.account.resetsIn} {formatResetTime(resetsAt, locale)}
          </div>
        </div>
        <div className="usage-values">
          <span className={`usage-percent ${toneClass}`}>{remainingPercent.toFixed(0)}% {t.account.left}</span>
          <span title={formatExactResetTime(resetsAt, locale)} className="usage-clock">
            <Clock3 size={13} />
            {formatExactResetTime(resetsAt, locale)}
          </span>
        </div>
      </div>

      <div className="usage-track" aria-hidden="true">
        <div
          className={`usage-fill ${toneClass}`}
          style={{
            width: `${Math.min(remainingPercent, 100)}%`,
            minWidth: remainingPercent > 0 ? 12 : 0,
          }}
        />
      </div>
    </div>
  );
}

export function UsageBar({ account, usage, loading, locale = "en" }: UsageBarProps) {
  const t = translations[locale];

  if (loading && !usage) {
    return (
      <div className="usage-shell">
        <div className="usage-loading-row" />
        <div className="usage-loading-row" />
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="usage-empty">
        <AlertCircle size={14} />
        {t.account.fetchingUsage}
      </div>
    );
  }

  if (usage.error) {
    return (
      <div className="usage-empty is-danger">
        <AlertCircle size={14} />
        {usage.error}
      </div>
    );
  }

  const visibleWindows = getVisibleLimitWindows(account);

  if (visibleWindows.length === 0) {
    return (
      <div className="usage-empty">
        <AlertCircle size={14} />
        {t.account.noRateLimit}
      </div>
    );
  }

  return (
    <div className="usage-shell">
      {visibleWindows.map((window) => (
        <RateLimitBar
          key={window.key}
          label={formatLimitLabel(window, locale)}
          usedPercent={window.usedPercent}
          windowMinutes={window.windowMinutes}
          resetsAt={window.resetsAt}
          locale={locale}
        />
      ))}

      {usage.credits_balance && (
        <div className="usage-credits">
          <Coins size={14} />
          {t.account.creditsBalance}: {usage.credits_balance}
        </div>
      )}
    </div>
  );
}
