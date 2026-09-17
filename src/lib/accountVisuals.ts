import type { AccountWithUsage } from "../types";

export type PlanTone = "free" | "plus" | "pro" | "team" | "api" | "unknown";

/** Rank insignia drawn next to the account name. */
export type PlanInsignia = "crown" | "crown-solid" | "team" | null;

export interface PlanVisual {
  label: string;
  shortLabel: string;
  tone: PlanTone;
  premium: boolean;
  /** Crown for Plus, solid crown for Pro, two figures for Team. Free has none. */
  insignia: PlanInsignia;
  /** CSS custom property holding the tier colour, or null for unranked plans. */
  colorVar: string | null;
}

function unranked(label: string, shortLabel: string, tone: PlanTone): PlanVisual {
  return { label, shortLabel, tone, premium: false, insignia: null, colorVar: null };
}

/**
 * The plan an account is on *right now*.
 *
 * The rate-limit endpoint returns the live plan on every usage fetch, while the
 * stored `plan_type` is whatever it was when the account was added — so a Team
 * seat that got revoked, or a Plus that lapsed, would otherwise keep its old
 * badge forever. Live value wins; the stored one is the pre-fetch fallback.
 */
export function getLivePlanType(account: AccountWithUsage): string | null {
  const live = account.usage?.plan_type?.trim();
  if (live && live !== "api_key") return live;
  return account.plan_type?.trim() || null;
}

export function getPlanVisual(account: AccountWithUsage): PlanVisual {
  if (account.auth_mode === "api_key") {
    return unranked("API Key", "API", "api");
  }

  if (account.provider === "claude") {
    const label = account.claude_subscription_type || account.plan_type || "Claude";
    return {
      label: label.charAt(0).toUpperCase() + label.slice(1),
      shortLabel: label.slice(0, 3).toUpperCase(),
      tone: "team",
      premium: true,
      insignia: "crown",
      colorVar: "--tier-team",
    };
  }

  const normalized = getLivePlanType(account)?.toLowerCase() ?? "";

  if (normalized.includes("team") || normalized.includes("business") || normalized.includes("enterprise")) {
    return {
      label: "Team",
      shortLabel: "Team",
      tone: "team",
      premium: true,
      insignia: "team",
      colorVar: "--tier-team",
    };
  }

  // "pro" before "plus": ChatGPT reports plus as "plus" and pro as "pro", but a
  // future "plus_pro"-style value must not be read as the cheaper tier.
  if (normalized.includes("pro")) {
    return {
      label: "Pro",
      shortLabel: "Pro",
      tone: "pro",
      premium: true,
      insignia: "crown-solid",
      colorVar: "--tier-pro",
    };
  }

  if (normalized.includes("plus")) {
    return {
      label: "Plus",
      shortLabel: "Plus",
      tone: "plus",
      premium: true,
      insignia: "crown",
      colorVar: "--tier-plus",
    };
  }

  if (normalized.includes("free")) {
    return unranked("Free", "Free", "free");
  }

  return unranked(
    normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown",
    normalized ? normalized.slice(0, 4) : "—",
    "unknown"
  );
}
