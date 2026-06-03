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
