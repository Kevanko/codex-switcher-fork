import type { ElementType } from "react";
import {
  Anchor, Bot, Briefcase, Cat, Code2, Coffee, Cpu, Flame, Gamepad2, Ghost,
  Heart, Leaf, Music, Palette, Rocket, Shield, Star, X,
} from "lucide-react";
import {
  colorHex,
  LOOK_COLORS,
  LOOK_ICONS,
  type AccountLook,
  type LookIconId,
} from "../lib/accountLooks";

const LOOK_ICON_MAP: Record<LookIconId, ElementType> = {
  star: Star, heart: Heart, flame: Flame, rocket: Rocket,
  shield: Shield, bot: Bot, cat: Cat, ghost: Ghost,
  coffee: Coffee, code: Code2, cpu: Cpu, music: Music,
  leaf: Leaf, anchor: Anchor, gamepad: Gamepad2, briefcase: Briefcase,
};

/** The glyph a person pinned to an account, or nothing. */
export function LookIcon({
  icon,
  size = 13,
  color,
}: {
  icon: LookIconId | undefined;
  size?: number;
  color?: string | null;
}) {
  if (!icon) return null;
  const Glyph = LOOK_ICON_MAP[icon];
  return <Glyph size={size} style={{ color: color ?? "var(--text-2)", flexShrink: 0 }} />;
}

/**
 * Colour and glyph pickers for one account, shown inline inside a context menu.
 *
 * Picking does not close the menu: choosing a colour is a comparison, and
 * reopening the menu for every candidate would make it unusable.
 */
export function LookPicker({
  look,
  ru,
  onChange,
}: {
  look: AccountLook | undefined;
  ru: boolean;
  onChange: (next: AccountLook) => void;
}) {
  return (
    <>
      <div className="ctx-head" style={{ paddingBottom: 4 }}>
        <Palette size={11} style={{ verticalAlign: -1, marginRight: 5 }} />
        {ru ? "Подсветка и значок" : "Highlight and glyph"}
      </div>
      <div className="ctx-swatches">
        {LOOK_COLORS.map((color) => (
          <button
            key={color.id}
            type="button"
            className={"ctx-swatch" + (look?.color === color.id ? " is-active" : "")}
            style={{ background: color.hex }}
            title={color.id}
            onClick={() => onChange({ ...look, color: look?.color === color.id ? undefined : color.id })}
          />
        ))}
      </div>
      <div className="ctx-glyphs">
        {LOOK_ICONS.map((icon) => (
          <button
            key={icon}
            type="button"
            className={"ctx-glyph" + (look?.icon === icon ? " is-active" : "")}
            title={icon}
            onClick={() => onChange({ ...look, icon: look?.icon === icon ? undefined : icon })}
          >
            <LookIcon icon={icon} size={14} color={colorHex(look?.color)} />
          </button>
        ))}
      </div>
      {(look?.color || look?.icon) && (
        <button type="button" className="ctx-item" onClick={() => onChange({})}>
          <X size={14} /> {ru ? "Убрать оформление" : "Clear marks"}
        </button>
      )}
    </>
  );
}
