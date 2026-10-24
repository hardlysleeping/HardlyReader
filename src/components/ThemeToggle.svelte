<script lang="ts">
  /**
   * Day/night switch, on its own.
   *
   * It lives in the sidebar's settings strip rather than beside the Options
   * swatch: the swatch is a small target people aim at often, and a theme flip
   * under a slightly missed click is a whole-screen change you then have to
   * undo. Deliberate mode choice (including "System") stays in the panel.
   */
  import { theme } from "../state/theme.svelte";

  const isDark = $derived(
    theme.current.mode === "dark" ||
      (theme.current.mode === "system" &&
        typeof matchMedia !== "undefined" &&
        matchMedia("(prefers-color-scheme: dark)").matches),
  );

  function swap(): void {
    theme.setMode(isDark ? "light" : "dark");
  }
</script>

<button
  class="mode"
  onclick={swap}
  aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
  title={isDark ? "Light mode" : "Dark mode"}
>
  {#if isDark}
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.4v1.6M8 13v1.6M1.4 8H3M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </svg>
  {:else}
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z" />
    </svg>
  {/if}
</button>

<style>
  .mode {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .mode:hover {
    background: var(--hover);
    color: var(--text);
  }

  .mode:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .mode svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
