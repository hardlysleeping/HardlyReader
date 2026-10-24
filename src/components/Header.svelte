<script lang="ts">
  import type { Snippet } from "svelte";

  import { serverLabel } from "../lib/server-label";
  import { syncDescription, syncReadout } from "../lib/sync-progress";
  import { reader } from "../state/reader.svelte";
  import ReadingControls from "./ReadingControls.svelte";
  import ThemePanel from "./ThemePanel.svelte";

  // Typed by what the menu needs from them, so a component's instance type
  // never has to be named here.
  let readingControls = $state<{ openPanel: () => void } | undefined>();
  let themePanel = $state<{ openSettings: () => void } | undefined>();

  /**
   * The compact menu.
   *
   * One panel is often a phone, or a window narrowed until it is one. There the
   * bar cannot hold the settings without pushing itself wider than the window,
   * so the controls that do not fit move in here behind the hamburger — the same
   * panels, opened from a row instead of a glyph. Feeds stays the first row
   * because that is what the hamburger was for.
   */
  let menuOpen = $state(false);
  let sheet = $state<HTMLElement | null>(null);

  /**
   * The account is a door, not a label: the name is here so signing out has
   * somewhere to live, and it opens on a press rather than sitting in the bar as
   * a button of its own. In a narrow window even the name goes — signing out is
   * then a row in the menu.
   */
  /* "Narrow" is decided in exactly one place: the compact media block at the
     bottom of this file, which drops the account from the bar and
     hides the rows only the compact menu needs. It used to be mirrored in a
     `matchMedia` flag as well, and the two disagreed for a resize: the CSS went
     compact while the flag still said wide, so the wide bar offered Sign out in
     two places and a phone offered it in none. */

  let accountOpen = $state(false);
  let accountEl = $state<HTMLElement | null>(null);

  function closeAccount() {
    accountOpen = false;
  }

  function pickAccount(action: () => void) {
    closeAccount();
    action();
  }

  $effect(() => {
    if (!accountOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (accountEl !== null && target !== null && !accountEl.contains(target)) closeAccount();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAccount();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });

  function closeMenu() {
    menuOpen = false;
  }

  function pick(action: () => void) {
    closeMenu();
    action();
  }

  /** An open menu closes on a press anywhere else, and on Escape. */
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (sheet !== null && target !== null && !sheet.contains(target)) closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });

  let {
    title = "HardlyReader",
    subtitle = "",
    server = "",
    controls,
    onsignout,
    ontogglesidebar,
  }: {
    /** Layout controls, owned by the view rather than by the header. */
    controls?: Snippet;
    title?: string;
    subtitle?: string;
    /** The server this window is signed in to, exactly as it was entered. */
    server?: string;
    onsignout?: () => void;
    ontogglesidebar?: () => void;
  } = $props();

  /**
   * Which box this is. Two windows on two servers look identical otherwise, and
   * the address is the only thing that tells them apart — so it sits beside the
   * name, shrinks before the name does, and goes into the sheets when the bar
   * runs out of room.
   */
  const address = $derived(serverLabel(server));

  /** The reader owns the steps; the header only reads them. */
  const refreshing = $derived(reader.sync.active);
  const readout = $derived(syncReadout(reader.sync));
  const description = $derived(syncDescription(reader.sync));

  /**
   * The bar answers a finished sync the way the band answers a lock and an
   * unlock: one thin ring on its own edge, in the sync colour, gone in a third
   * of a second. The control is in this bar, so this is the bar that changes.
   */
  let pulse = $state(false);
  /**
   * A tick for a moment after the last fetch lands.
   *
   * The resting glyph is a pair of arrows, not a ring, so "finished" can never
   * be mistaken for a spinner that stopped mid-turn — and for a second after it
   * is done it is a tick, which is the one shape that cannot mean "working".
   */
  let justFinished = $state(false);
  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  let wasActive = reader.sync.active;
  $effect(() => {
    const activeNow = reader.sync.active;
    if (wasActive && !activeNow) {
      wasActive = false;
      pulse = true;
      justFinished = true;
      if (tickTimer !== null) clearTimeout(tickTimer);
      tickTimer = setTimeout(() => {
        tickTimer = null;
        justFinished = false;
      }, 1200);
    } else if (!wasActive && activeNow) {
      wasActive = true;
      justFinished = false;
      if (tickTimer !== null) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
    }
  });

  $effect(() => () => {
    if (tickTimer !== null) clearTimeout(tickTimer);
  });

  /** What the control says it is, which is also what it just did. */
  const label = $derived(justFinished ? "Synced" : description);

  async function refresh() {
    await reader.refresh();
  }
</script>

<header class="bar">
  {#if pulse}
    <span class="pulse" aria-hidden="true" onanimationend={() => (pulse = false)}></span>
  {/if}
  <div class="drawer" bind:this={sheet}>
    <button
      class="icon menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={menuOpen ? "Close menu" : "Menu"}
      title="Menu"
      onclick={() => (menuOpen = !menuOpen)}
    >☰</button>
    {#if menuOpen}
      <div class="sheet" role="menu" aria-label="Menu">
        <button role="menuitem" onclick={() => pick(() => ontogglesidebar?.())}>Feeds</button>
        <button role="menuitem" onclick={() => pick(() => readingControls?.openPanel())}>Reading</button>
        <button role="menuitem" onclick={() => pick(() => themePanel?.openSettings())}>Settings</button>
        <!-- Only when the name is not in the bar: the account is where signing
             out lives, and on a narrow bar the account is in here. -->
        <!-- Always rendered, hidden by the same media query that drops the
             account from the bar: the CSS decides what "narrow" means here, so
             the row cannot disagree with the bar the way a JS flag can. -->
        {#if address}
          <p class="sheet-server" title={server}>{address}</p>
        {/if}
        <!-- One row always: hidden by the media query when the bar has the name
             to press, shown when it does not. When there is no name at all the
             row is not gated, because the menu is then the only way out. -->
        <button
          role="menuitem"
          class:narrow-only={!!subtitle}
          onclick={() => pick(() => onsignout?.())}>Sign out</button>
      </div>
    {/if}
  </div>
  <span class="brand">{title}</span>
  <!-- The name is the account's handle: pressing it offers what you can do with
       the account, which is sign out. It shrinks to fit whatever it is given
       rather than pushing the controls beside it. -->
  {#if subtitle}
    <div class="account" bind:this={accountEl}>
      <button
        class="who"
        aria-haspopup="menu"
        aria-expanded={accountOpen}
        title={subtitle}
        onclick={() => (accountOpen = !accountOpen)}
      >{subtitle}</button>
      {#if address}
        <span class="server" title={server}>{address}</span>
      {/if}
      {#if accountOpen}
        <div class="who-sheet" role="menu" aria-label="Account">
          <p class="who-name" title={subtitle}>{subtitle}</p>
          <!-- The address lives here too: the bar's copy is the first thing to
               go when the window narrows, and this is where you go looking for
               "which server is this". -->
          <p class="who-server">{server}</p>
          <button role="menuitem" onclick={() => pickAccount(() => onsignout?.())}>Sign out</button>
        </div>
      {/if}
    </div>
  {/if}

  <div class="spacer"></div>

  {@render controls?.()}
  <!-- Hidden as a group when the bar is compact; their panels open from the
       menu, and a fixed panel does not care that its trigger is not drawn. -->
  <span class="tools">
    <ReadingControls bind:this={readingControls} />
    <ThemePanel bind:this={themePanel} />
  </span>

  <!-- The count and the percentage for as long as the sync lasts. The bar for
       the same numbers is the seam under this header, drawn full width there
       rather than as a stub beside the button: one progress, one place. It sits
       still to the left of the button so the control you just pressed does not
       move. -->
  {#if refreshing}
    <span
      class="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={reader.sync.total}
      aria-valuenow={reader.sync.done}
      aria-valuetext={description}
      title={description}
    >
      <span class="readout">{readout}</span>
      {#if reader.sync.step}
        <!-- What is happening, from the fetch that is really in flight. On a
             narrow bar the count keeps its place and this drops: the tooltip
             and the screen-reader text still carry it. -->
        <span class="doing">· {reader.sync.step}</span>
      {/if}
    </span>
  {/if}

  <button
    class="sync"
    class:busy={refreshing}
    class:done={justFinished}
    onclick={refresh}
    disabled={refreshing}
    aria-label={label}
    title={label}
  >
    {#if justFinished}
      <!-- Done: a tick, briefly. -->
      <svg class="glyph tick" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5 10.2 17.7 19 7.5" />
      </svg>
    {:else}
      <!-- Two arrows chasing each other: the sync mark, drawn as strokes so it
           stays crisp at 16px. At rest it is still; while syncing the whole mark
           turns, which is unmistakably "working" next to a mark that is not. -->
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12a8.5 8.5 0 0 1-14.8 5.7" />
        <path d="M3.5 12a8.5 8.5 0 0 1 14.8-5.7" />
        <path d="M18.3 2.9v3.8h-3.8" />
        <path d="M5.7 21.1v-3.8h3.8" />
      </svg>
    {/if}
  </button>
</header>

<style>
  /* A title bar, not a toolbar: enough height to hold a 34px control with air
     around it, and no more. */
  .bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 42px;
    flex: 0 0 42px;
    padding: 0 10px;
    border-bottom: 1px solid var(--edge);
    background: var(--surface);
  }

  .brand {
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .account {
    position: relative;
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
  }

  /* Shrinks before anything else in the bar: the name identifies, it does not
     inform, and it already has a tooltip with its full text. */
  .who {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 150px;
    padding: 2px 6px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .who:hover,
  .who[aria-expanded="true"] {
    background: var(--hover);
    color: var(--text);
  }

  /* The address sits beside the name and takes the slack: when the bar runs
     tight it is the first thing to lose characters, because a truncated address
     still says which box you are on while a truncated name says nothing. */
  .server {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 30ch;
    padding: 2px 2px 2px 5px;
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }

  .who-sheet {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 70;
    min-width: 148px;
    max-width: 260px;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    animation: sheet-in 120ms ease-out;
  }

  .who-name {
    margin: 0;
    padding: 4px 7px 6px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* In the sheet there is room for the whole thing, and it wraps rather than
     clipping: this is the copy you read when the bar's copy is gone. */
  .who-server,
  .sheet-server {
    margin: 0;
    padding: 4px 7px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--text-dim);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .sheet-server {
    border-bottom: 0;
    border-top: 1px solid var(--border-soft);
    margin-top: 4px;
    color: var(--muted);
  }

  /* Wide enough for the bar to hold the account itself: the menu stops
     repeating what the bar shows. One media query, so the menu and the bar can
     never disagree about how narrow the window is. */
  @media (min-width: 561px) {
    .sheet-server,
    .sheet .narrow-only {
      display: none;
    }
  }

  .who-sheet button {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 5px 7px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .who-sheet button:hover {
    background: var(--hover);
    color: var(--text);
  }

  .spacer {
    flex: 1;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .icon:hover {
    background: var(--hover);
    color: var(--text);
  }

  .icon:disabled {
    opacity: 0.5;
    cursor: default;
  }







  /* Sync is the one control in this bar that changes what you are looking at,
     so it gets room to be aimed at rather than being a 28px glyph wedged
     between two others. */
  .sync {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    margin-left: 8px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: none;
    color: var(--tone-sync);
    border-color: color-mix(in srgb, var(--tone-sync) 28%, var(--border));
    font: inherit;
    line-height: 1;
    cursor: pointer;
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease;
  }

  /* Sync keeps its own colour, chosen in Options, because it is the one control
     that means "ask the server", not "change the view". */
  .sync:hover:not(:disabled) {
    color: var(--tone-sync);
    background: color-mix(in srgb, var(--tone-sync) 12%, transparent);
    border-color: color-mix(in srgb, var(--tone-sync) 60%, transparent);
  }

  .sync:disabled {
    cursor: default;
    opacity: 0.9;
  }

  .glyph {
    display: block;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    overflow: visible;
  }

  /* While syncing the whole mark turns. Nothing else moves: a second animation
     under a spinning mark was what made the control look busy after it had
     finished. */
  .sync.busy .glyph {
    animation: turn 820ms linear infinite;
  }

  /* Done, for a second: the tick takes the full sync colour and the button's
     edge lights up, so "finished" is a different picture from "idle" and from
     "working" rather than a ring that happens to be still. */
  .sync.done {
    color: var(--tone-sync);
    border-color: color-mix(in srgb, var(--tone-sync) 65%, var(--border));
    background: color-mix(in srgb, var(--tone-sync) 10%, transparent);
  }

  .glyph.tick {
    stroke-width: 2.3;
  }

  /* The same ring the band draws on a lock or an unlock, in the sync colour. */
  .pulse {
    position: absolute;
    inset: 0;
    border-radius: 0;
    pointer-events: none;
    --pulse-tone: var(--tone-sync);
    animation: hrs-bar-pulse 360ms ease-out both;
  }

  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }

  /* The progress readout: a thin bar with the fraction over it, inside the
     header row so nothing else shifts when it appears. */
  .progress {
    display: inline-flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    margin-left: 8px;
    animation: arrive 160ms ease-out;
  }

  .readout {
    flex: 0 0 auto;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--tone-sync) 55%, var(--muted));
    line-height: 1;
    white-space: nowrap;
  }

  /* The fetch in flight, dimmer than the count so the number still reads first.
     It gives up characters before the button moves: the count says how far, the
     phrase says at what. */
  .doing {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 24ch;
    margin-left: 4px;
    overflow: hidden;
    font-size: 10px;
    color: var(--muted);
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateX(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sync.busy .glyph,
    .progress {
      animation: none;
    }

    .pulse {
      animation: none;
      box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--tone-sync) 45%, transparent);
    }
  }

  .drawer {
    position: relative;
    display: flex;
    align-items: center;
  }

  /* The menu opens against the bar's left edge, over the panes rather than
     pushing them: it is a list of doors, not a drawer. */
  .sheet {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 70;
    display: flex;
    flex-direction: column;
    min-width: 118px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    animation: sheet-in 120ms ease-out;
  }

  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  .sheet button {
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .sheet button:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .sheet button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .tools {
    display: contents;
  }

  /* The drawer toggle only exists where the sidebar is a drawer. */
  @media (min-width: 840px) {
    .menu {
      display: none;
    }

    .drawer {
      display: none;
    }
  }

  /* Compact: the bar keeps what identifies the window and what changes the
     layout, and the rest moves into the menu. Every item that leaves the bar
     here is still one press away in the sheet — nothing is lost, which is the
     point: a bar that answers a narrow window by widening itself past the
     window is worse than a menu. */
  @media (max-width: 560px) {
    .bar {
      gap: 5px;
      padding: 0 8px;
    }

    /* The triggers go, their panels stay: the panels are `position: fixed` and
       sit at the component root, so hiding `.tools` used to take Settings and
       Reading with it — the menu opened nothing. Only the bar-sized controls
       are hidden; the rows in the menu still reach the same panels. */
    .account,
    .tools > :global(.reading),
    .tools > :global(.themebar) {
      display: none;
    }

    .brand {
      font-size: 12.5px;
    }

    .sync {
      margin-left: 4px;
    }

    /* A narrow bar has room for the number, not for the sentence. The step is
       still the button's title and the progressbar's text. */
    .doing {
      display: none;
    }
  }
</style>
