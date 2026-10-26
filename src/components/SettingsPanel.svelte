<script lang="ts">
  /**
   * The settings panel: every preference the app has, in one place.
   *
   * Before this there were three surfaces — the gear's popover in the bar, the
   * Aa panel beside it, and the account's own sheet — and a phone had to reach
   * into all of them. Each was sized for a pointer: 268px wide, anchored under a
   * 28px glyph, capped at 72vh. On a phone that is a popover opened by a menu
   * row, which is a lot of precision asked of a thumb.
   *
   * So this file is the frame, not the settings. Nothing here is a control the
   * app did not already have: each section mounts the component that owns those
   * rows — `ThemePanel` for appearance, layout and the sync interval,
   * `ReadingPanel` for the Aa rows, `AccountMenu` for the account. Two copies of
   * a slider is how the same setting ends up with two answers, so the rule is
   * one control per setting and this panel borrows all of them.
   *
   * It is a full-screen sheet under 700px, where the window is the sheet, and a
   * wide panel above it, where there is room for one. Sections are native
   * `<details>`: open and shut by keyboard, announced as disclosures, and still
   * working if this file's script never runs.
   */
  import AccountMenu from "./AccountMenu.svelte";
  import ReadingPanel from "./ReadingPanel.svelte";
  import ThemePanel from "./ThemePanel.svelte";
  import { APP_VERSION } from "../lib/version";

  let {
    open = $bindable(false),
    name = "",
    server = "",
    onsignout,
  }: {
    /** Whether the panel is up. The header owns it, so the sheet and the bar agree. */
    open?: boolean;
    /** The account's display name, as the bar shows it. */
    name?: string;
    /** The server this window is signed in to, exactly as it was entered. */
    server?: string;
    onsignout?: () => void;
  } = $props();

  type SectionId = "accounts" | "appearance" | "reading" | "layout" | "sync" | "about";

  /**
   * The sections, in the order someone looks for them: who I am, what it looks
   * like, how it reads, how it is laid out, where it fetches from, and what
   * version this is. Accounts first because it is the one that has to be found
   * when something is wrong.
   */
  const SECTIONS: { id: SectionId; label: string; note: string }[] = [
    { id: "accounts", label: "Accounts", note: "This account, this server" },
    { id: "appearance", label: "Appearance", note: "Colours, page, background" },
    { id: "reading", label: "Reading", note: "Text, pictures, read state" },
    { id: "layout", label: "Layout", note: "Pane widths and arrangement" },
    { id: "sync", label: "Sync", note: "Interval, and when it fetches" },
    { id: "about", label: "About", note: "Version" },
  ];

  /** Which sections are open. Accounts starts open: it is the shortest one. */
  let opened = $state<Record<SectionId, boolean>>({
    accounts: true,
    appearance: false,
    reading: false,
    layout: false,
    sync: false,
    about: false,
  });

  let sheetEl = $state<HTMLElement | null>(null);

  /** Where focus was before the sheet took it, so closing puts it back. */
  let returnTo: HTMLElement | null = null;

  function close(): void {
    open = false;
  }

  function signOut(): void {
    close();
    onsignout?.();
  }

  /** Everything a keyboard can land on. Closed sections are not in this list:
   *  a shut `<details>` is not rendered, so it is not focusable either. */
  const FOCUSABLE = "summary, button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])";

  /**
   * Escape closes, from anywhere in the sheet — including from inside a colour
   * picker's popup, where the platform may or may not forward the key. Closing
   * the sheet is the one thing a stuck-looking overlay must always be able to do.
   *
   * Tab stays inside it, because the sheet is drawn over the app: everything
   * behind the scrim is unreachable by pointer, so a keyboard that could walk
   * into it would be the only way to press controls nobody can see.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || sheetEl === null) return;
    const focusable = [...sheetEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => !element.hasAttribute("disabled") && element.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === sheetEl)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Focus follows the sheet: in when it opens, back where it was when it shuts.
   * Without this a phone user who opened it by pressing the menu row was left
   * with focus on a menu that no longer exists.
   *
   * `returnTo` is only taken once per opening: the sheet's own element is a
   * binding, so it arrives a moment after the first run, and remembering the
   * sheet itself as "where focus was" would leave the close gesture pointing at
   * an element that is being removed.
   */
  $effect(() => {
    if (!open) return;
    if (returnTo === null) returnTo = (document.activeElement as HTMLElement | null) ?? null;
    // The sheet takes focus rather than its first control: the heading is then
    // read out, and the first Tab lands on the close button.
    sheetEl?.focus();
  });

  $effect(() => {
    if (open) return;
    const back = returnTo;
    returnTo = null;
    if (back !== null && back.isConnected) back.focus();
  });
</script>

{#if open}
  <!-- The scrim is the press-anywhere-else answer on a wide window, where the
       sheet is a panel over the app. On a phone the sheet is the window, and
       this is behind it. -->
  <div class="scrim" aria-hidden="true" onclick={close}></div>

  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    tabindex="-1"
    bind:this={sheetEl}
    onkeydown={onkeydown}
  >
    <header class="head">
      <h2 id="settings-title">Settings</h2>
      <button class="close" aria-label="Close settings" title="Close settings" onclick={close}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
        </svg>
      </button>
    </header>

    <div class="body">
      {#each SECTIONS as section (section.id)}
        <details
          class="sec"
          open={opened[section.id]}
          ontoggle={(event) => (opened[section.id] = event.currentTarget.open)}
        >
          <summary class="sum">
            <span class="label">{section.label}</span>
            <span class="note">{section.note}</span>
            <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 10.5 8 5 12.5" /></svg>
          </summary>
          <div class="content">
            {#if section.id === "accounts"}
              <!-- The account, as the bar draws it: one component, so signing out
                   from here and signing out from the name can never disagree. -->
              <AccountMenu {name} {server} onsignout={signOut} />
            {:else if section.id === "appearance"}
              <!-- The colours are the theme panel's rows, mounted — not a second
                   set written here. -->
              <ThemePanel part="colours" />
            {:else if section.id === "reading"}
              <ReadingPanel />
            {:else if section.id === "layout"}
              <!-- Pane widths, the one-pane width and the held-upright mode are
                   the layout tab, mounted whole: a phone now reaches the same
                   rows a desktop does, and they write the same state. -->
              <ThemePanel part="layout" />
            {:else if section.id === "sync"}
              <ThemePanel part="sync" />
              <!-- Sign out is not repeated here: it is the account's one action,
                   and it is drawn once, in Accounts. -->
              <p class="hint">Signing out is in Accounts.</p>
            {:else}
              <div class="row">
                <span class="key">Version</span>
                <span class="value">{APP_VERSION}</span>
              </div>
              <p class="hint">HardlyReader — a FreshRSS reader.</p>
            {/if}
          </div>
        </details>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* A panel over a dimmed app on a wide window. */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 78;
    background: rgba(0, 0, 0, 0.42);
    animation: scrim-in 140ms ease-out;
  }

  /* A wide panel, not a page: it hangs off the right edge the bar's own panels
     hang from, clear of the bar so the window still says what it is, and it is
     capped by the room the window has rather than by a fixed slice of it. */
  .sheet {
    position: fixed;
    top: 52px;
    right: 12px;
    z-index: 79;
    display: flex;
    flex-direction: column;
    width: min(560px, calc(100vw - 24px));
    max-height: calc(100vh - 68px);
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
    color: var(--text-dim);
    animation: sheet-drop 150ms ease-out;
  }

  .sheet:focus {
    outline: none;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    padding: 10px 12px 8px 14px;
    border-bottom: 1px solid var(--border-soft);
  }

  h2 {
    flex: 1 1 auto;
    margin: 0;
    color: var(--text);
    font-size: 14px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }

  .close svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }

  .close:hover {
    background: var(--hover);
    color: var(--text);
  }

  .close:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  /* The sheet's own scroll: the heading stays put and the sections move under
     it, so the way out is always where it was. */
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 0 14px;
  }

  .sec {
    border-bottom: 1px solid var(--border-soft);
  }

  .sec:last-child {
    border-bottom: 0;
  }

  .sum {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: 2px 10px;
    padding: 11px 14px;
    cursor: pointer;
    list-style: none;
  }

  /* The disclosure triangle is drawn, not the platform's marker: this is a list
     of sections under one heading, and a marker per row reads as a bullet list. */
  .sum::-webkit-details-marker {
    display: none;
  }

  .sum::marker {
    content: "";
  }

  .sum:hover {
    background: var(--hover);
  }

  .sum:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: -2px;
  }

  .label {
    grid-column: 1;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }

  .note {
    grid-column: 1;
    grid-row: 2;
    color: var(--muted);
    font-size: 11px;
  }

  .chev {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .sec[open] > .sum .chev {
    transform: rotate(90deg);
  }

  .content {
    padding: 0 14px 12px;
    font-size: 12px;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
  }

  .key {
    flex: 1 1 auto;
    color: var(--text-dim);
  }

  .value {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  @keyframes scrim-in {
    from {
      opacity: 0;
    }
  }

  @keyframes sheet-drop {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
  }

  /* A phone: the window is the sheet. The bar stays under it as the one thing
     that says which window this is, and nothing is anchored to a 28px glyph. */
  @media (max-width: 699px) {
    .sheet {
      inset: 0;
      width: auto;
      max-height: none;
      border: 0;
      border-radius: 0;
      animation: sheet-rise 180ms ease-out;
    }

    .head {
      padding: 12px 12px 10px 16px;
      /* Clear of a phone's status bar and its notch, where the platform reserves
         the top of the screen for itself. */
      padding-top: max(12px, env(safe-area-inset-top));
    }

    .close {
      width: 34px;
      height: 34px;
    }

    .sum {
      padding: 13px 16px;
    }

    .label {
      font-size: 14px;
    }

    .content {
      padding: 0 16px 14px;
    }
  }

  @keyframes sheet-rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }

  /* Asked for less motion: the sheet arrives instead of sliding. */
  @media (prefers-reduced-motion: reduce) {
    .scrim,
    .sheet {
      animation: none;
    }

    .chev {
      transition: none;
    }
  }
</style>
