/**
 * The icon set, as the app uses it.
 *
 * `generated.ts` is the data (geometry only, committed, produced by
 * `scripts/gen-icons.mjs`); this file is the small API on top of it. Nothing
 * here draws anything — `<Glyph>` does that — so the one place that decides a
 * glyph's weight and size is a component, not a string.
 *
 * `FALLBACK_ICON` is what an unknown name becomes. It is deliberately a shape
 * nobody would pick on purpose: a wrong-but-plausible glyph (a star for a feed
 * called "Star Wars") is worse than a neutral one, and the picker is where a
 * reader corrects it.
 */

import { ICON_KEYWORDS, ICON_NAMES, ICONS } from "./generated";

export { ICON_KEYWORDS, ICON_NAMES };

/** Unknown names come back as these shapes rather than as nothing. */
export const FALLBACK_ICON = "shapes";

/** True when the set can draw this name. */
export function hasIcon(name: string | null | undefined): name is string {
  return typeof name === "string" && Object.hasOwn(ICONS, name);
}

/**
 * The geometry for a name, or `null` when the set does not know it.
 *
 * `null` rather than the fallback, because a caller drawing a category row has
 * to tell "this category has no icon" from "this category's icon failed to
 * load" — the first draws nothing, the second draws the neutral shape.
 */
export function iconMarkup(name: string | null | undefined): string | null {
  return hasIcon(name) ? ICONS[name] : null;
}

/** Every name the set knows, in the curated order. */
export function iconNames(): string[] {
  return ICON_NAMES;
}

/** What a glyph is about — its name and Lucide's tags — for the picker's filter. */
export function iconKeywords(name: string): string[] {
  return hasIcon(name) ? (ICON_KEYWORDS[name] ?? []) : [];
}

/** A reader's choices, keyed by category label, plus the auto switch. */
export interface IconChoices {
  map: Record<string, string>;
  auto: boolean;
}

/**
 * The `icons` namespace value, read defensively.
 *
 * Here rather than in the store because `$state` inside a `.svelte.ts` cannot be
 * imported by the plain-node test harness, and this is the part with the rule in
 * it: a value that carries no `map` is not an answer (an older client that has
 * never heard of the namespace must not be able to erase a choice), an unknown
 * glyph name is dropped (the set is what can be drawn), and `auto` is on unless
 * it says otherwise.
 */
export function iconsFromValue(value: unknown): IconChoices | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { auto?: unknown; map?: unknown };
  if (typeof record.map !== "object" || record.map === null) return null;
  const map: Record<string, string> = {};
  for (const [label, name] of Object.entries(record.map as Record<string, unknown>)) {
    if (typeof name === "string" && hasIcon(name)) map[label] = name;
  }
  return { map, auto: record.auto !== false };
}
