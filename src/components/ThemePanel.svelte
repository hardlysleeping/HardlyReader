<script lang="ts">
  /**
   * The Options swatch and the panel behind it. The day/night switch is not
   * here — it lives in the sidebar's settings strip (see ThemeToggle) so a
   * near-miss on this small target cannot flip the whole screen.
   *
   * The swatch is one click from the accent it edits, which is the thing most
   * people change; the panel behind it holds the colours that carry meaning —
   * hidden, favourite, the two lock states — plus the two wording choices.
   */
  import type { ThemeMode } from "../lib/theme";
  import { THEME_MODES, THEME_MODE_LABELS } from "../lib/theme";
  import {
    DWELL_SECONDS_DEFAULT,
    DWELL_SECONDS_HARD_MAX,
    DWELL_SECONDS_HARD_MIN,
    DWELL_SECONDS_MAX,
    DWELL_SECONDS_MIN,
  } from "../lib/dwell";
  import {
    EFFORT_DEFAULT,
    EFFORT_HARD_MAX,
    EFFORT_HARD_MIN,
    EFFORT_MAX,
    EFFORT_MIN,
    thresholdFor,
    travelToAdvance,
    withinSlider,
  } from "../lib/scroll-advance";
  import { reading } from "../state/reading.svelte";
  import { theme } from "../state/theme.svelte";
  import { layout } from "../state/layout.svelte";
  import { THRESHOLDS, THRESHOLD_LIMITS } from "../lib/panes";

  let open = $state(false);

  type TabId = "colours" | "layout" | "reading";

  /** Colour first: it is what someone opens this panel for most of the time. */
  const TABS: { id: TabId; label: string }[] = [
    { id: "colours", label: "Colours" },
    { id: "layout", label: "Layout" },
    { id: "reading", label: "Reading" },
  ];

  let tab = $state<TabId>("colours");

  /**
   * Arrow keys move between tabs, as a tab strip is expected to. Selection
   * follows focus here because every panel is one click away anyway — no
   * "activate" step to learn.
   */
  function tabMove(event: KeyboardEvent, current: TabId) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const last = TABS.length - 1;
    const index = TABS.findIndex((item) => item.id === current);
    let next: number | null = null;
    if (step !== 0) next = (index + step + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    tab = TABS[next].id;
    const element = document.getElementById(`settings-tab-${tab}`);
    element?.focus();
  }

  const swatches: {
    key: "accent" | "hidden" | "favourite" | "lockOpen" | "lockClosed" | "unlock" | "sync";
    label: string;
  }[] = [
    { key: "accent", label: "Accent" },
    { key: "hidden", label: "Hidden" },
    { key: "favourite", label: "Favourite" },
    { key: "lockOpen", label: "Lock open" },
    { key: "lockClosed", label: "Lock locked" },
    { key: "unlock", label: "Unlocked" },
    { key: "sync", label: "Sync" },
  ];
</script>

<div class="themebar">
  <button
    class="swatch"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Settings"
    title="Settings"
    onclick={() => (open = !open)}
  >
    <svg class="gear" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
      />
    </svg>
  </button>
</div>

{#if open}
  <div class="panel" role="dialog" aria-label="Settings">
    <!-- Three sections instead of one long column: colour, the pane widths it
         shares a panel with, and how the reader behaves. -->
    <div class="tabs" role="tablist" aria-label="Settings sections">
      {#each TABS as item (item.id)}
        <button
          class="tab"
          class:on={tab === item.id}
          role="tab"
          id={`settings-tab-${item.id}`}
          aria-selected={tab === item.id}
          aria-controls={`settings-panel-${item.id}`}
          tabindex={tab === item.id ? 0 : -1}
          onclick={() => (tab = item.id)}
          onkeydown={(event) => tabMove(event, item.id)}
        >{item.label}</button>
      {/each}
    </div>

    {#if tab === "colours"}
      <div
        class="tabpanel"
        role="tabpanel"
        id="settings-panel-colours"
        aria-labelledby="settings-tab-colours"
      >
      <div class="row">
        <span class="key">Appearance</span>
        <div class="seg" role="group" aria-label="Appearance">
          {#each THEME_MODES as mode (mode)}
            <button
              class="segbtn"
              class:on={theme.current.mode === mode}
              aria-pressed={theme.current.mode === mode}
              onclick={() => theme.setMode(mode as ThemeMode)}
            >
              {THEME_MODE_LABELS[mode]}
            </button>
          {/each}
        </div>
      </div>      {#each swatches as swatch (swatch.key)}
        <label class="row">
          <span class="key">{swatch.label}</span>
          <span class="pick">
            <input
              type="color"
              value={theme.current[swatch.key]}
              aria-label={`${swatch.label} colour`}
              oninput={(event) => theme.set(swatch.key, event.currentTarget.value)}
            />
            <code>{theme.current[swatch.key]}</code>
          </span>
        </label>
      {/each}      <!-- The lines between panes are the one place the accent appears without
           being asked: on, they take a quarter of it; off, they are the plain
           border this app used to have. -->
      <div class="row">
        <span class="key">Separators</span>
        <div class="seg" role="group" aria-label="Pane separators">
          <button
            class="segbtn"
            class:on={theme.current.accentEdges}
            aria-pressed={theme.current.accentEdges}
            title="Tint the lines between panes with the accent"
            onclick={() => theme.set("accentEdges", true)}>Accent</button>
          <button
            class="segbtn"
            class:on={!theme.current.accentEdges}
            aria-pressed={!theme.current.accentEdges}
            title="Plain borders — how this app looked before"
            onclick={() => theme.set("accentEdges", false)}>Plain</button>
        </div>
      </div>
        <div class="row end">
          <button class="reset" onclick={() => theme.reset()}>Reset colours</button>
          <button class="done" onclick={() => (open = false)}>Done</button>
        </div>
      </div>
    {:else if tab === "layout"}
      <div
        class="tabpanel"
        role="tabpanel"
        id="settings-panel-layout"
        aria-labelledby="settings-tab-layout"
      >
      <!-- Where a pane count begins. One pane has no number here on purpose: it
           is what is left when neither threshold is met, and its width is the
           smallest honest single column — the phone shape, fixed. -->
      <div class="row">
        <span class="key">Two panes from</span>
        <span class="pick">
          <input
            class="range wide"
            type="range"
            min={THRESHOLD_LIMITS.two.min}
            max={THRESHOLD_LIMITS.two.max}
            step="10"
            value={layout.thresholds.two}
            aria-label="Window width at which a second pane appears"
            oninput={(event) => layout.setThreshold("two", Number(event.currentTarget.value))}
          />
          <span class="num">
            <input
              class="value"
              type="number"
              min={THRESHOLD_LIMITS.two.min}
              max={THRESHOLD_LIMITS.two.max}
              step="10"
              value={layout.thresholds.two}
              aria-label="Two-pane threshold in pixels"
              onchange={(event) => layout.setThreshold("two", Number(event.currentTarget.value))}
              onblur={(event) => (event.currentTarget.value = String(layout.thresholds.two))}
            />
            <span class="affix" aria-hidden="true">px</span>
          </span>
          <button
            class="again"
            title={`Back to ${THRESHOLDS[layout.device].two}px`}
            aria-label="Reset the two-pane threshold"
            disabled={layout.thresholds.two === THRESHOLDS[layout.device].two}
            onclick={() => layout.setThreshold("two", THRESHOLDS[layout.device].two)}
          >↺</button>
        </span>
      </div>

      <div class="row">
        <span class="key">Three panes from</span>
        <span class="pick">
          <input
            class="range wide"
            type="range"
            min={THRESHOLD_LIMITS.three.min}
            max={THRESHOLD_LIMITS.three.max}
            step="10"
            value={layout.thresholds.three}
            aria-label="Window width at which a third pane appears"
            oninput={(event) => layout.setThreshold("three", Number(event.currentTarget.value))}
          />
          <span class="num">
            <input
              class="value"
              type="number"
              min={THRESHOLD_LIMITS.three.min}
              max={THRESHOLD_LIMITS.three.max}
              step="10"
              value={layout.thresholds.three}
              aria-label="Three-pane threshold in pixels"
              onchange={(event) => layout.setThreshold("three", Number(event.currentTarget.value))}
              onblur={(event) => (event.currentTarget.value = String(layout.thresholds.three))}
            />
            <span class="affix" aria-hidden="true">px</span>
          </span>
          <button
            class="again"
            title={`Back to ${THRESHOLDS[layout.device].three}px`}
            aria-label="Reset the three-pane threshold"
            disabled={layout.thresholds.three === THRESHOLDS[layout.device].three}
            onclick={() => layout.setThreshold("three", THRESHOLDS[layout.device].three)}
          >↺</button>
        </span>
      </div>

      <!-- The feedback is the layout itself: drag a threshold past this window's
           width and the panes change while you drag. The line says where you are
           in numbers so the change is not a mystery. -->
      <p class="hint">
        This window is {Math.round(layout.available)}px — showing {layout.mode}
        {layout.mode === 1 ? "pane" : "panes"}. Below {layout.thresholds.two}px it is always one.
      </p>
        <div class="row end">
      <button class="done" onclick={() => (open = false)}>Done</button>
        </div>
      </div>
    {:else}
      <div
        class="tabpanel"
        role="tabpanel"
        id="settings-panel-reading"
        aria-labelledby="settings-tab-reading"
      >
      <div class="row">
        <span class="key">Marker</span>
        <div class="seg" role="group" aria-label="Marker">
          <button class="segbtn" class:on={theme.current.marker === "pin"} aria-pressed={theme.current.marker === "pin"} onclick={() => theme.set("marker", "pin")}>Pin</button>
          <button class="segbtn" class:on={theme.current.marker === "star"} aria-pressed={theme.current.marker === "star"} onclick={() => theme.set("marker", "star")}>Star</button>
        </div>
      </div>      <div class="row">
        <span class="key">Call them</span>
        <div class="seg" role="group" aria-label="Wording">
          <button class="segbtn" class:on={theme.current.vocabulary === "pinned"} aria-pressed={theme.current.vocabulary === "pinned"} onclick={() => theme.set("vocabulary", "pinned")}>Pinned</button>
          <button class="segbtn" class:on={theme.current.vocabulary === "favourites"} aria-pressed={theme.current.vocabulary === "favourites"} onclick={() => theme.set("vocabulary", "favourites")}>Favourites</button>
        </div>
      </div>      <div class="row">
        <span class="key">Scroll effort</span>
        <span class="pick">
          <input
            class="range"
            type="range"
            min={EFFORT_MIN}
            max={EFFORT_MAX}
            step="0.1"
            value={withinSlider(reading.scrollEffort, EFFORT_MIN, EFFORT_MAX)}
            aria-label="How much scrolling it takes to reach the next post"
            oninput={(event) => reading.setScrollEffort(Number(event.currentTarget.value))}
          />
          <!-- The number is the exact setting and takes anything in the hard range,
               including values the slider cannot reach. -->
          <span class="num">
            <span class="affix" aria-hidden="true">×</span>
            <input
              class="value"
              type="number"
              min={EFFORT_HARD_MIN}
              max={EFFORT_HARD_MAX}
              step="0.1"
              value={reading.scrollEffort}
              aria-label="Scroll effort multiplier, any value from 0.1 to 10"
              onchange={(event) => reading.setScrollEffort(Number(event.currentTarget.value))}
              onblur={(event) => (event.currentTarget.value = String(reading.scrollEffort))}
            />
          </span>
          <button
            class="again"
            title={`Back to ×${EFFORT_DEFAULT.toFixed(1)}`}
            aria-label="Reset scroll effort to the default"
            disabled={reading.scrollEffort === EFFORT_DEFAULT}
            onclick={() => reading.setScrollEffort(EFFORT_DEFAULT)}
          >↺</button>
        </span>
      </div>
      <p class="hint">
        About {Math.round(travelToAdvance(thresholdFor(reading.scrollEffort)) / 100)} wheel notches to leave a post — the same both ways.
      </p>      <div class="row">
        <span class="key">Mark read after</span>
        <span class="pick">
          <input
            class="range"
            type="range"
            min={DWELL_SECONDS_MIN}
            max={DWELL_SECONDS_MAX}
            step="1"
            value={withinSlider(reading.autoMarkSeconds, DWELL_SECONDS_MIN, DWELL_SECONDS_MAX)}
            aria-label="Seconds a post stays open before it is marked read"
            oninput={(event) => reading.setAutoMarkSeconds(Number(event.currentTarget.value))}
          />
          <span class="num">
            <input
              class="value"
              type="number"
              min={DWELL_SECONDS_HARD_MIN}
              max={DWELL_SECONDS_HARD_MAX}
              step="1"
              value={reading.autoMarkSeconds}
              aria-label="Seconds before a post is marked read, any value from 1 to 600"
              onchange={(event) => reading.setAutoMarkSeconds(Number(event.currentTarget.value))}
              onblur={(event) => (event.currentTarget.value = String(reading.autoMarkSeconds))}
            />
            <span class="affix" aria-hidden="true">s</span>
          </span>
          <button
            class="again"
            title={`Back to ${DWELL_SECONDS_DEFAULT}s`}
            aria-label="Reset the read delay to the default"
            disabled={reading.autoMarkSeconds === DWELL_SECONDS_DEFAULT}
            onclick={() => reading.setAutoMarkSeconds(DWELL_SECONDS_DEFAULT)}
          >↺</button>
        </span>
      </div>
      <p class="hint">
        How long a post must stay open before it counts as read — only while the ⏱ button in the reader is on.
      </p>
        <div class="row end">
      <button class="done" onclick={() => (open = false)}>Done</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .themebar {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .swatch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .swatch:hover {
    background: var(--hover);
    color: var(--text);
  }

  /* A gear, drawn rather than a coloured dot: the swatch said "theme", and this
     panel has grown past being the theme's own popover. */
  .gear {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }


  /* Anchored under the header's right-hand controls rather than to the button:
     the panel is wider than the swatch, and a fixed box cannot be clipped by
     the header's overflow. */
  .panel {
    position: fixed;
    top: 52px;
    right: 12px;
    z-index: 60;
    width: 268px;
    padding: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    color: var(--text-dim);
  }

  /* Three short labels under the gear, with the chosen one carrying the accent
     instead of an underline: the panel is small and a rule under a tab would
     read as another separator in a panel full of them. */
  .tabs {
    display: flex;
    gap: 2px;
    margin: 0 0 2px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border-soft);
  }

  .tab {
    flex: 1 1 auto;
    padding: 4px 2px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .tab:hover {
    background: var(--hover);
    color: var(--text);
  }

  .tab.on {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent-text);
  }

  .tab:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }

  .row.end {
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
  }

  .pick {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .range {
    width: 74px;
    accent-color: var(--accent);
  }

  .range.wide {
    width: 96px;
  }

  .num {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }

  .affix {
    font-size: 10.5px;
    color: var(--muted);
  }

  /* A number you can tap and type into, sized like the text it replaced so the
     row does not gain a box where there was a label. */
  .value {
    width: 38px;
    padding: 1px 3px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    appearance: textfield;
  }

  .value:hover {
    border-color: var(--border-soft);
  }

  .value:focus-visible {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .value::-webkit-outer-spin-button,
  .value::-webkit-inner-spin-button {
    appearance: none;
    margin: 0;
  }

  .again {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 17px;
    height: 17px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
  }

  .again:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  .again:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .hint {
    margin: 0 0 2px;
    font-size: 10.5px;
    line-height: 1.35;
    color: var(--muted);
  }

  input[type="color"] {
    width: 24px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: none;
    cursor: pointer;
  }

  code {
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    text-transform: uppercase;
  }

  .seg {
    display: flex;
    gap: 3px;
  }

  .segbtn {
    padding: 3px 7px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
  }

  .segbtn:hover {
    color: var(--text);
    background: var(--hover);
  }

  .segbtn.on {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }

  .reset,
  .done {
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .reset:hover,
  .done:hover {
    color: var(--text);
    background: var(--hover);
  }

  .done {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    color: var(--accent-text);
  }
</style>
