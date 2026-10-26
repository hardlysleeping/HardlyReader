/**
 * The theme the user picked, applied to the document.
 *
 * The colours follow the account — a reader who sets a dark theme on the
 * desktop expects it on the phone — while the background picture and its
 * blur/dim/glass stay on the machine that chose them (see `snapshot`). It is
 * still read at module load and written to `:root` before the first paint, so a
 * light-mode user never sees a dark frame.
 */
import {
  DEFAULT_THEME,
  parseTheme,
  THEME_KEY,
  themeVariables,
  type Theme,
  type ThemeMode,
} from "../lib/theme";

class ThemeState {
  current = $state<Theme>({ ...DEFAULT_THEME });

  load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(THEME_KEY);
      if (raw === null) return;
      this.current = parseTheme(JSON.parse(raw));
    } catch {
      // A corrupt theme is not worth a dialog; the defaults are usable.
    }
  }

  /** Setting one field re-applies everything, so `:root` cannot drift. */
  set<K extends keyof Theme>(key: K, value: Theme[K]): void {
    this.current = { ...this.current, [key]: value };
    this.save();
    apply(this.current);
  }

  setMode(mode: ThemeMode): void {
    this.set("mode", mode);
  }

  reset(): void {
    this.current = { ...DEFAULT_THEME };
    this.save();
    apply(this.current);
  }

  /**
   * The part of the theme that travels: the mode and every colour.
   *
   * The background picture and its blur/dim/glass are not here on purpose.
   * They are a photograph scaled to one screen, the largest thing the theme
   * holds by an order of magnitude, and "how this machine is dressed" rather
   * than "which colours this reader chose".
   */
  snapshot(): Record<string, unknown> {
    return {
      mode: this.current.mode,
      accent: this.current.accent,
      accentEdges: this.current.accentEdges,
      hidden: this.current.hidden,
      pinned: this.current.pinned,
      lockOpen: this.current.lockOpen,
      lockClosed: this.current.lockClosed,
      unlock: this.current.unlock,
      sync: this.current.sync,
      trim: this.current.trim,
      link: this.current.link,
      star: this.current.star,
      monotoneActions: this.current.monotoneActions,
      bg: this.current.bg,
    };
  }

  /**
   * Takes the account's colours.
   *
   * Merged over what is here rather than replacing it, so a value that does
   * not mention the background picture cannot delete it, and a field the
   * account has never carried keeps this device's answer.
   */
  adopt(value: Record<string, unknown>): void {
    this.current = parseTheme({ ...this.current, ...value });
    this.save();
    apply(this.current);
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(this.current));
    } catch {
      // An image is the one field big enough to fill the quota on its own. Keep
      // the colours and drop the picture: a theme that half-saved is worse than
      // a theme that saved without its photograph.
      try {
        localStorage.setItem(THEME_KEY, JSON.stringify({ ...this.current, bgImage: null }));
      } catch {
        // The theme still applies for this session.
      }
    }
  }
}

/**
 * Writes the theme to the document.
 *
 * `data-theme` is set only for an explicit choice; `system` removes it and lets
 * the stylesheet's media query decide, so "Auto" keeps following the OS live
 * instead of freezing whatever it was at load.
 */
export function apply(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(theme))) {
    root.style.setProperty(name, value);
  }
  // `--bg` is the one variable that is *unsaid* rather than set: a theme with no
  // page colour of its own must delete the override, or the last colour it had
  // before the mode changed would be the one it keeps.
  if (theme.bg === null) root.style.removeProperty("--bg");
  if (theme.mode === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme.mode;
}

export const theme = new ThemeState();
theme.load();
apply(theme.current);
