/**
 * Per-account marks: a highlight colour and a glyph the person picks themselves.
 *
 * These are personal shorthand for a list of a dozen near-identical names, not
 * account data — they live on this machine only, in the webview's storage, which
 * survives app updates. Nothing here is sent anywhere or written to a backup.
 */

export const LOOK_COLORS = [
  { id: "amber",  hex: "#e0a63a" },
  { id: "orange", hex: "#e07d4a" },
  { id: "rose",   hex: "#e0728f" },
  { id: "violet", hex: "#9b7ff0" },
  { id: "blue",   hex: "#5b8def" },
  { id: "cyan",   hex: "#3fb6d8" },
  { id: "green",  hex: "#46b97a" },
  { id: "slate",  hex: "#8b95a1" },
] as const;

export type LookColorId = (typeof LOOK_COLORS)[number]["id"];

/** Keys into the icon map that App.tsx renders. Silhouettes chosen to stay
 *  distinguishable at 13px, where fine detail disappears. */
export const LOOK_ICONS = [
  "star", "heart", "flame", "rocket",
  "shield", "bot", "cat", "ghost",
  "coffee", "code", "cpu", "music",
  "leaf", "anchor", "gamepad", "briefcase",
] as const;

export type LookIconId = (typeof LOOK_ICONS)[number];

export interface AccountLook {
  color?: LookColorId;
  icon?: LookIconId;
}

const STORAGE_KEY = "codex-switcher-account-looks";

export function colorHex(id: LookColorId | undefined): string | null {
  return LOOK_COLORS.find((color) => color.id === id)?.hex ?? null;
}

export function loadAccountLooks(): Record<string, AccountLook> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    // Drop anything that is not a colour/icon we still ship, so a renamed
    // preset cannot leave a row referencing a glyph that no longer exists.
    const clean: Record<string, AccountLook> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, AccountLook>)) {
      const look: AccountLook = {};
      if (value?.color && LOOK_COLORS.some((c) => c.id === value.color)) look.color = value.color;
      if (value?.icon && (LOOK_ICONS as readonly string[]).includes(value.icon)) look.icon = value.icon;
      if (look.color || look.icon) clean[id] = look;
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveAccountLooks(looks: Record<string, AccountLook>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(looks));
  } catch {
    // Private mode or blocked storage: the marks are cosmetic, carry on without.
  }
}
