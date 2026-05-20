import { AlertCircle, Clock3, Coins } from "lucide-react";
import type { UsageInfo } from "../types";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
}

function formatResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "Unknown";

  const now = Math.floor(Date.now() / 1000);
  const diff = resetAt - now;
  if (diff <= 0) return "Now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatExactResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "No reset time";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt * 1000));
}

function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes}m window`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h window`;
  return `${Math.floor(hours / 24)}d window`;
}

function getToneClass(remainingPercent: number) {
  if (remainingPercent <= 10) return "is-danger";
  if (remainingPercent <= 30) return "is-warning";
  return "is-accent";
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}) {
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const toneClass = getToneClass(remainingPercent);
  const duration = formatWindowDuration(windowMinutes);

  return (
    <div className="usage-block">
      <div className="usage-meta">
        <div>
          <div className="usage-label">{label}</div>
          <div className="usage-note">
            {duration ? `${duration} - ` : ""}
            Resets in {formatResetTime(resetsAt)}
          </div>
        </div>
        <div className="usage-values">
          <span className={`usage-percent ${toneClass}`}>{remainingPercent.toFixed(0)}% left</span>
          <span title={formatExactResetTime(resetsAt)} className="usage-clock">
            <Clock3 size={13} />
            {formatExactResetTime(resetsAt)}
          </span>
        </div>
      </div>

      <div className="usage-track" aria-hidden="true">
        <div
          className={`usage-fill ${toneClass}`}
          style={{ width: `${Math.min(remainingPercent, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function UsageBar({ usage, loading }: UsageBarProps) {
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
        Fetching usage data
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

  const hasPrimary = usage.primary_used_percent !== null && usage.primary_used_percent !== undefined;
  const hasSecondary =
    usage.secondary_used_percent !== null && usage.secondary_used_percent !== undefined;

  if (!hasPrimary && !hasSecondary) {
    return (
      <div className="usage-empty">
        <AlertCircle size={14} />
        No rate limit data
      </div>
    );
  }

  return (
    <div className="usage-shell">
      {hasPrimary && (
        <RateLimitBar
          label="Primary window"
          usedPercent={usage.primary_used_percent!}
          windowMinutes={usage.primary_window_minutes}
          resetsAt={usage.primary_resets_at}
        />
      )}

      {hasSecondary && (
        <RateLimitBar
          label="Weekly window"
          usedPercent={usage.secondary_used_percent!}
          windowMinutes={usage.secondary_window_minutes}
          resetsAt={usage.secondary_resets_at}
        />
      )}

      {usage.credits_balance && (
        <div className="usage-credits">
          <Coins size={14} />
          Credits balance: {usage.credits_balance}
        </div>
      )}
    </div>
  );
}
