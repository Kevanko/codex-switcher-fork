import type { AccountWithUsage } from "../types";

export type PlanTone = "free" | "plus" | "team" | "api" | "unknown";

export function getPlanVisual(account: AccountWithUsage): {
  label: string;
  shortLabel: string;
  tone: PlanTone;
  premium: boolean;
} {
  if (account.auth_mode === "api_key") {
    return {
      label: "API Key",
      shortLabel: "API",
      tone: "api",
      premium: false,
    };
  }

  if (account.provider === "claude") {
    const label = account.claude_subscription_type || account.plan_type || "Claude";
    return {
      label: label.charAt(0).toUpperCase() + label.slice(1),
      shortLabel: "CL",
      tone: "team",
      premium: true,
    };
  }

  const normalized = account.plan_type?.trim().toLowerCase() ?? "";

  if (normalized.includes("team")) {
    return {
      label: "Team",
      shortLabel: "TM",
      tone: "team",
      premium: true,
    };
  }

  if (normalized.includes("pro")) {
    return {
      label: "Pro",
      shortLabel: "PR",
      tone: "plus",
      premium: true,
    };
  }

  if (normalized.includes("plus")) {
    return {
      label: "Plus",
      shortLabel: "P+",
      tone: "plus",
      premium: true,
    };
  }

  if (normalized.includes("free")) {
    return {
      label: "Free",
      shortLabel: "FR",
      tone: "free",
      premium: false,
    };
  }

  return {
    label: account.plan_type
      ? account.plan_type.charAt(0).toUpperCase() + account.plan_type.slice(1)
      : "Unknown",
    shortLabel: account.plan_type ? account.plan_type.slice(0, 2).toUpperCase() : "?",
    tone: "unknown",
    premium: false,
  };
}
