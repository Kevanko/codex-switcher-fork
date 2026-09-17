import type { AccountWithUsage, UsageInfo } from "../types";
import { getPlanVisual } from "./accountVisuals";

export type LimitWindowKind = "primary" | "weekly" | "rolling";

export interface VisibleLimitWindow {
  key: string;
  kind: LimitWindowKind;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

function hasPercent(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

export function getUsageRemaining(usedPercent: number | null | undefined): number | null {
  if (!hasPercent(usedPercent)) return null;
  return Math.max(0, 100 - usedPercent);
}

export function getVisibleLimitWindows(account: AccountWithUsage): VisibleLimitWindow[] {
  const usage = account.usage;
  if (!usage || usage.error) return [];

  const isPremiumPlan = getPlanVisual(account).premium;
  const windows: VisibleLimitWindow[] = [];

  if (isPremiumPlan && hasPercent(usage.primary_used_percent)) {
    windows.push({
      key: "primary",
      kind: "primary",
      usedPercent: usage.primary_used_percent,
      windowMinutes: usage.primary_window_minutes,
      resetsAt: usage.primary_resets_at,
    });
  }

  if (hasPercent(usage.secondary_used_percent)) {
    windows.push({
      key: "weekly",
      kind: "weekly",
      usedPercent: usage.secondary_used_percent,
      windowMinutes: usage.secondary_window_minutes,
      resetsAt: usage.secondary_resets_at,
    });
  } else if (!isPremiumPlan && hasPercent(usage.primary_used_percent)) {
    windows.push({
      key: "weekly-primary",
      kind: "rolling",
      usedPercent: usage.primary_used_percent,
      windowMinutes: usage.primary_window_minutes,
      resetsAt: usage.primary_resets_at,
    });
  }

  return windows;
}

export function getEffectiveRemainingPercent(account: AccountWithUsage): number | null {
  const windows = getVisibleLimitWindows(account);
  if (windows.length === 0) return null;

  return Math.min(...windows.map((window) => Math.max(0, 100 - window.usedPercent)));
}

export function isAccountFullyLimited(account: AccountWithUsage): boolean {
  const remaining = getEffectiveRemainingPercent(account);
  return remaining !== null && remaining <= 0;
}

export function getMostLimitedResetWindow(account: AccountWithUsage): VisibleLimitWindow | null {
  const windows = getVisibleLimitWindows(account);
  if (windows.length === 0) return null;

  return windows.reduce((lowest, current) => {
    const lowestRemaining = getUsageRemaining(lowest.usedPercent) ?? 100;
    const currentRemaining = getUsageRemaining(current.usedPercent) ?? 100;
    return currentRemaining < lowestRemaining ? current : lowest;
  });
}

export function getResetProgressPercentForWindow(window: VisibleLimitWindow | null): number | null {
  if (!window?.resetsAt || !window.windowMinutes) return null;

  const nowSeconds = Date.now() / 1000;
  const windowSeconds = window.windowMinutes * 60;
  const remainingSeconds = Math.max(0, window.resetsAt - nowSeconds);
  const elapsedRatio = 1 - Math.min(1, remainingSeconds / windowSeconds);

  return Math.round(Math.max(0, Math.min(100, elapsedRatio * 100)));
}

export function hasRecoverableAuthError(usage: UsageInfo | undefined): boolean {
  const message = usage?.error;
  if (!message) return false;
  return /auth|oauth|token|unauthori[sz]ed|login|sign.?in|401|403|invalid_grant|refresh|credentials/i.test(
    message
  );
}

/**
 * Why an account cannot be used, if it cannot.
 *
 * Only faults that block sign-in are persistent: those grey the account out and
 * sink it to the bottom. A lapsed subscription is deliberately NOT one of them —
 * the account still works, it just lost its crown, which the plan badge already
 * says on its own.
 */
export type AccountFaultKind =
  | "auth_revoked"
  | "auth_expired"
  | "unreachable"
  | "forbidden"
  | "server"
  | "http";

const PERSISTENT_FAULTS: AccountFaultKind[] = ["auth_revoked", "forbidden", "unreachable"];

export function getAccountFault(account: AccountWithUsage): AccountFaultKind | null {
  const usage = account.usage;

  // A 429 is the provider asking us to wait, not a broken account.
  if (usage?.rate_limited) return null;

  // We asked and were turned away, so these figures are a replay of an older
  // snapshot. Whatever credential we hold is no longer accepted.
  if (usage?.from_cache) return "unreachable";

  if (usage?.error) {
    const kind = usage.error_kind;
    if (kind && kind !== "rate_limited") return kind as AccountFaultKind;
    // Snapshots cached by an older build carry a message but no kind.
    return hasRecoverableAuthError(usage) ? "auth_revoked" : "http";
  }

  return null;
}

/** True for a fault that stops the account being usable until it is fixed. */
export function isAccountDead(account: AccountWithUsage): boolean {
  const fault = getAccountFault(account);
  return fault !== null && PERSISTENT_FAULTS.includes(fault);
}
