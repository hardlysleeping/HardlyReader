<script lang="ts">
  /**
   * The Options swatch and the panel behind it. The day/night switch is not
   * here — it lives in the sidebar's settings strip (see ThemeToggle) so a
   * near-miss on this small target cannot flip the whole screen.
   *
   * The swatch is one click from the accent it edits, which is the thing most
   * people change; the panel behind it holds the colours that carry meaning —
   * hidden, pinned, the two lock states.
   */
  import type { ThemeMode } from "../lib/theme";
  import {
    MAX_BG_BLUR,
    MAX_BG_DIM,
    PAGE_COLOURS,
    THEME_MODES,
    THEME_MODE_LABELS,
  } from "../lib/theme";
  import { backgroundFromFile } from "../lib/background-image";
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
  import { chrome } from "../state/chrome.svelte";
  import { AUTO_SYNC_HOURS, autoSyncLabel, parseAutoSyncHours } from "../lib/auto-sync";
  import { reading } from "../state/reading.svelte";
  import { theme } from "../state/theme.svelte";
  import { layout } from "../state/layout.svelte";
  import { lan } from "../state/lan.svelte";
  import { LAN_LABELS, LAN_PORT_MAX, LAN_PORT_MIN, lanNote } from "../lib/lan";
  import { openExternal } from "../lib/open-external";
  import { DEFAULT_WIDTHS, MODE_HYSTERESIS, THRESHOLD_LIMITS } from "../lib/panes";

  let open = $state(false);

  /** The Web tab's two verbs: open the address, and copy it for a phone. */
  let copied = $state(false);

  async function openWeb(): Promise<void> {
    if (lan.url === null) return;
    await openExternal(lan.url);
  }

  async function copyWeb(): Promise<void> {
    if (lan.url === null) return;
    try {
      await navigator.clipboard.writeText(lan.url);
      copied = true;
      window.setTimeout(() => (copied = false), 1500);
    } catch {
      // A webview with no clipboard permission: the address is on screen to be
      // read out, which is how it would be typed anyway.
    }
  }

  type TabId = "colours" | "layout" | "reading" | "web";

  /** Colour first: it is what someone opens this panel for most of the time. */
  const TABS: { id: TabId; label: string }[] = [
    { id: "colours", label: "Colours" },
    { id: "layout", label: "Layout" },
    { id: "reading", label: "Reading" },
    // The reader is a web app in a window; this is the tab that says so, and the
    // switch that puts it on the network for a phone.
    { id: "web", label: "Web" },
  ];

  let tab = $state<TabId>("colours");

  // After a window reload the Rust side may still be serving; ask once, on open,
  // rather than polling a server that is almost always off.
  let asked = false;
  $effect(() => {
    if (!open || asked) return;
    asked = true;
    void lan.sync();
  });

  /** Opened from the compact menu, where the gear has no room to sit. */
  export function openSettings() {
    tab = "colours";
    open = true;
  }

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

  type SwatchKey =
    | "accent"
    | "trim"
    | "hidden"
    | "pinned"
    | "lockOpen"
    | "unlock"
    | "lockClosed"
    | "sync"
    | "star"
    | "link";

  /**
   * The colours, in the groups they belong to.
   *
   * Ten swatches in one block was a wall of chips with no reading order. Four
   * headings, each with its own rule, say what the tones are for before the eye
   * has to work it out — and because the heading says "Lock", the colours under
   * it do not have to say it again.
   */
  /** The colour the page is right now: the theme's, or whichever mode is showing. */
  function pageColour(): string {
    if (theme.current.bg !== null) return theme.current.bg;
    const mode = theme.current.mode;
    const dark =
      mode === "dark" ||
      (mode === "system" &&
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    return dark ? PAGE_COLOURS.dark : PAGE_COLOURS.light;
  }

  /**
   * A picked file, turned into a stored background.
   *
   * The input is cleared first: choosing the same file twice in a row fires no
   * change event otherwise, and "replace it with the one I already had" is a
   * thing people do.
   */
  async function pickBackground(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (file === null) return;
    const url = await backgroundFromFile(file);
    if (url !== null) theme.set("bgImage", url);
  }

  const swatchGroups: {
    id: string;
    label: string;
    items: { key: SwatchKey; label: string }[];
  }[] = [
    {
      id: "palette",
      label: "Palette",
      items: [
        { key: "accent", label: "Accent" },
        { key: "trim", label: "Trim" },
      ],
    },
    {
      id: "lists",
      label: "Feed lists",
      items: [
        { key: "hidden", label: "Hidden" },
        { key: "pinned", label: "Pinned" },
      ],
    },
    {
      id: "lock",
      label: "Lock",
      items: [
        { key: "lockOpen", label: "Open" },
        { key: "lockClosed", label: "Locked" },
        { key: "unlock", label: "Unlocked" },
      ],
    },
    {
      id: "controls",
      label: "Controls",
      items: [{ key: "sync", label: "Sync" }],
    },
    {
      id: "marks",
      label: "Row marks",
      items: [
        { key: "star", label: "Star" },
        { key: "link", label: "Link" },
      ],
    },
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
      </div>
      <!-- The lines between panes are the one place the accent appears without
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
        <!-- The three row actions: a gold star, the trim for read, the link blue.
             Monotone is what they were before there were colours at all, kept
             because three coloured glyphs on every row is a lot of signal. -->
        <div class="row">
          <span class="key">Buttons</span>
          <div class="seg" role="group" aria-label="Row button colours">
            <button
              class="segbtn"
              class:on={!theme.current.monotoneActions}
              aria-pressed={!theme.current.monotoneActions}
              title="Star gold, read in the trim, link in its own blue"
              onclick={() => theme.set("monotoneActions", false)}>Colour</button>
            <button
              class="segbtn"
              class:on={theme.current.monotoneActions}
              aria-pressed={theme.current.monotoneActions}
              title="One quiet ink for all three, as they were before"
              onclick={() => theme.set("monotoneActions", true)}>Monotone</button>
          </div>
        </div>
        <!-- Colours, two to a line, paired by what they answer: accent and trim,
             then what the app hides and what it keeps, then the lock's states,
             then the row's marks. Every cell is a label and a swatch — the hex
             would not fit twice over in 268px, so the value is in the tooltip
             and the picker itself is the colour. -->
        <div class="swatches">
          {#each swatchGroups as group (group.id)}
            <div class="swgroup">
              <span class="sglabel">{group.label}</span>
              {#each group.items as swatch (swatch.key)}
                <label class="sw" title={`${swatch.label} — ${theme.current[swatch.key].toUpperCase()}`}>
                  <span class="key">{swatch.label}</span>
                  <input
                    type="color"
                    value={theme.current[swatch.key]}
                    aria-label={`${swatch.label} colour`}
                    oninput={(event) => theme.set(swatch.key, event.currentTarget.value)}
                  />
                  <code>{theme.current[swatch.key]}</code>
                </label>
              {/each}
            </div>
          {/each}
        </div>
        <!-- The page itself. Everything above is ink and signal; this is what
             they sit on, and it is the one setting with a picture in it.

             "Default" is not a colour, it is the absence of one: cleared, the
             page follows the mode, so a light window and a dark window each get
             their own page without the theme carrying two. -->
        <div class="swgroup bgsection">
          <span class="sglabel">Background</span>
          <div class="row bgrow">
            <span class="key">Page</span>
            <span class="pick">
              <input
                type="color"
                value={pageColour()}
                aria-label="Page colour"
                oninput={(event) => theme.set("bg", event.currentTarget.value)}
              />
              <button
                class="mini"
                title="Follow the light or dark page"
                disabled={theme.current.bg === null}
                onclick={() => theme.set("bg", null)}>Default</button>
            </span>
          </div>
          <div class="row bgrow">
            <span class="key">Picture</span>
            <span class="pick">
              <label class="mini file">
                {theme.current.bgImage === null ? "Choose" : "Replace"}
                <input type="file" accept="image/*" onchange={pickBackground} />
              </label>
              <button
                class="mini"
                title="Remove the picture"
                disabled={theme.current.bgImage === null}
                onclick={() => theme.set("bgImage", null)}>Clear</button>
            </span>
          </div>
          <div class="row slider bgslider">
            <span class="key">Blur</span>
            <span class="num"><span class="affix">{theme.current.bgBlur}px</span></span>
            <input
              class="range wide"
              type="range"
              min="0"
              max={MAX_BG_BLUR}
              step="1"
              value={theme.current.bgBlur}
              aria-label="Background blur"
              oninput={(event) => theme.set("bgBlur", Number(event.currentTarget.value))}
            />
          </div>
          <div class="row slider bgslider">
            <span class="key">Dim</span>
            <span class="num"><span class="affix">{theme.current.bgDim}%</span></span>
            <input
              class="range wide"
              type="range"
              min="0"
              max={MAX_BG_DIM}
              step="5"
              value={theme.current.bgDim}
              aria-label="Dim over the background"
              oninput={(event) => theme.set("bgDim", Number(event.currentTarget.value))}
            />
          </div>
          <div class="row bgrow">
            <span class="key">Glass</span>
            <div class="seg" role="group" aria-label="Panels over the background">
              <button
                class="segbtn"
                class:on={!theme.current.bgGlass}
                aria-pressed={!theme.current.bgGlass}
                title="Panels stay solid"
                onclick={() => theme.set("bgGlass", false)}>Solid</button>
              <button
                class="segbtn"
                class:on={theme.current.bgGlass}
                aria-pressed={theme.current.bgGlass}
                title="Let the background through the panels"
                onclick={() => theme.set("bgGlass", true)}>Glass</button>
            </div>
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
      <!-- What each pane count needs, and the width the "1" button collapses to.
           The first two are sums of the panes below the layout, so they move when
           a divider is dragged and writing one resizes that mode's columns. The
           1 row is the odd one: it is not a threshold (nothing appears at it) but
           the width "1" collapses to, and it started life as the fixed
           single-column floor. Its default is still that floor.

           Hidden where it cannot apply: a phone has one column as wide as the
           screen, so a width at which a second pane appears is a setting with no
           effect. Both rows and the number line go together. -->
      {#if layout.caps.paneThresholds}
      <!-- Two lines: the label and its number, then the slider across the whole
           panel. It used to share the row and got 96px for a 360-2000px range —
           17px of window per pixel of travel, which is why it felt twitchy. -->
      <div class="row slider">
        <span class="key">Two panes from</span>
        <span class="num">
          <input
            class="value"
            type="number"
            min={THRESHOLD_LIMITS.two.min}
            max={layout.rangeFor("two").max}
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
          title="Back to the default posts width"
          aria-label="Reset the two-pane columns"
          disabled={!layout.paneEdited(2)}
          onclick={() => layout.resetWidths(2)}
        >↺</button>
        <input
          class="range wide"
          type="range"
          min={THRESHOLD_LIMITS.two.min}
          max={layout.rangeFor("two").max}
          step="10"
          value={layout.thresholds.two}
          aria-label="Window width at which a second pane appears"
          oninput={(event) => layout.setThreshold("two", Number(event.currentTarget.value))}
        />
      </div>

      <div class="row slider">
        <span class="key">Three panes from</span>
        <span class="num">
          <input
            class="value"
            type="number"
            min={THRESHOLD_LIMITS.three.min}
            max={layout.rangeFor("three").max}
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
          title="Back to the default posts and article widths"
          aria-label="Reset the three-pane columns"
          disabled={!layout.paneEdited(3)}
          onclick={() => layout.resetWidths(3)}
        >↺</button>
        <input
          class="range wide"
          type="range"
          min={THRESHOLD_LIMITS.three.min}
          max={layout.rangeFor("three").max}
          step="10"
          value={layout.thresholds.three}
          aria-label="Window width at which a third pane appears"
          oninput={(event) => layout.setThreshold("three", Number(event.currentTarget.value))}
        />
      </div>

      <!-- The one width that is not a threshold: where the "1" button puts the
           window. Under the other two because it is the same kind of number and
           read in the same breath. -->
      <div class="row slider">
        <span class="key">One pane at</span>
        <span class="num">
          <input
            class="value"
            type="number"
            min={THRESHOLD_LIMITS.one.min}
            max={layout.rangeFor("one").max}
            step="10"
            value={layout.thresholds.one}
            aria-label="One-pane window width in pixels"
            onchange={(event) => layout.setThreshold("one", Number(event.currentTarget.value))}
            onblur={(event) => (event.currentTarget.value = String(layout.thresholds.one))}
          />
          <span class="affix" aria-hidden="true">px</span>
        </span>
        <button
          class="again"
          title={`Back to ${DEFAULT_WIDTHS.sidebar}px`}
          aria-label="Reset the one-pane width"
          disabled={layout.thresholds.one === DEFAULT_WIDTHS.sidebar}
          onclick={() => layout.setThreshold("one", DEFAULT_WIDTHS.sidebar)}
        >↺</button>
        <input
          class="range wide"
          type="range"
          min={THRESHOLD_LIMITS.one.min}
          max={layout.rangeFor("one").max}
          step="10"
          value={layout.thresholds.one}
          aria-label="Width the one-pane button collapses the window to"
          oninput={(event) => layout.setThreshold("one", Number(event.currentTarget.value))}
        />
      </div>

      <!-- The feedback is the layout itself: drag a divider and these two numbers
           move with the panes; drag a number and that mode's columns resize. The
           line says where you are so the change is not a mystery. -->
      <p class="hint">
        These follow your dividers: two panes need {layout.paneWidthFor(2)}px,
        three need {layout.paneWidthFor(3)}px. Moving a slider resizes that mode's
        columns instead. This window is {Math.round(layout.available)}px
        {#if layout.monitor}of a {layout.monitor}px screen{/if} — showing {layout.mode}
        {layout.mode === 1 ? "pane" : "panes"}. It changes {MODE_HYSTERESIS}px past
        these numbers, not on them, so a drag does not flicker. The 1/2/3 buttons
        {layout.keepWidths ? "resize the window to your columns" : "grow the window to fit your columns"},
        never past the screen.
      </p>
      {/if}

      <!-- One control, two shapes. It edits the answer for the shape the device
           is in when it is pressed — held upright, or turned sideways — and that
           shape's answer is remembered, so the same row means the right thing
           when the phone is the other way round. Outside the gate above because
           this question belongs to the shape with the least room to spare. -->
      <div class="row">
        <span class="key">On a switch</span>
        <div class="seg" role="group" aria-label="What a layout switch does with the width">
          <button
            class="segbtn"
            class:on={layout.keepWidths}
            aria-pressed={layout.keepWidths}
            title="The window shrinks and grows with the panes, so every pane keeps its width"
            onclick={() => layout.setKeepWidths(true)}>Keep widths</button>
          <button
            class="segbtn"
            class:on={!layout.keepWidths}
            aria-pressed={!layout.keepWidths}
            title="The window stays where it is and the posts column takes the width of the pane that left"
            onclick={() => layout.setKeepWidths(false)}>Keep window</button>
        </div>
      </div>
      <p class="hint">
        Remembered for this way up: {layout.keepWidthsInPortrait ? "keep widths" : "keep window"} held
        upright, {layout.keepWidthsInLandscape ? "keep widths" : "keep window"} turned sideways. Turn the
        device and this row shows the other answer.
      </p>

      <!-- How the columns move when a press changes the layout. Outside the
           gate above because a phone changes layout too (the walk, and the
           stack arriving) even though it has no thresholds to set. One row, one
           choice: Instant is the animation off, not a separate switch, so what
           you pick is exactly what you get. -->
      <div class="row">
        <span class="key">Pane slide</span>
        <div class="seg" role="group" aria-label="How the panes move when the layout changes">
          <button
            class="segbtn"
            class:on={layout.motion === "off"}
            aria-pressed={layout.motion === "off"}
            title="No slide: the panes change in one frame"
            onclick={() => layout.setMotion("off")}>Instant</button>
          <button
            class="segbtn"
            class:on={layout.motion === "quick"}
            aria-pressed={layout.motion === "quick"}
            title="A short slide with a little spring — the default"
            onclick={() => layout.setMotion("quick")}>Quick</button>
          <button
            class="segbtn"
            class:on={layout.motion === "smooth"}
            aria-pressed={layout.motion === "smooth"}
            title="The same slide, a little longer and softer"
            onclick={() => layout.setMotion("smooth")}>Smooth</button>
        </div>
      </div>
      <p class="hint">
        A press changes the mode at once; this is how quickly the columns catch
        up. It starts at Instant when your system asks for less motion, and the
        setting is still yours.
      </p>

      <!-- How three panes are *arranged*, which is a different question from how
           wide they are — so this row is outside the pixel sliders above, and
           outside their gate on purpose: a phone has no thresholds, no pane
           switch and no dividers, but it does draw the stack, and a setting the
           phone cannot reach is a setting that does not exist there. -->
      <div class="row">
        <span class="key">Three panes</span>
        <div class="seg" role="group" aria-label="How three panes are arranged">
          <button
            class="segbtn"
            class:on={!layout.stackChosen}
            aria-pressed={!layout.stackChosen}
            title="Feeds, posts and article side by side, one column each"
            onclick={() => layout.setStacked(false)}>Side by side</button>
          <button
            class="segbtn"
            class:on={layout.stackChosen}
            aria-pressed={layout.stackChosen}
            title="Feeds on the left; posts above the article in one right column"
            onclick={() => layout.setStacked(true)}>Stacked</button>
        </div>
      </div>
      <p class="hint">
        {#if layout.stackForced}
          This window is narrower than three columns need, so three panes are drawn
          as the stacked pair — turn the device or widen the window and they are
          columns again. Drag the seam between the posts and the article to change
          the split.
        {:else}
          Stacked spends the width once instead of twice, so three panes fit a
          narrow window: drag the seam between the posts and the article to change
          the split.
        {/if}
      </p>

      <!-- How a passcode is entered, not what it is. Off by default because a
           keyboard is faster with a mouse; on because a phone's own keyboard
           covers the band it is unlocking. Device-local. -->
      <div class="row">
        <span class="key">PIN entry</span>
        <div class="seg" role="group" aria-label="How a passcode is entered">
          <button
            class="segbtn"
            class:on={!chrome.pinPad}
            aria-pressed={!chrome.pinPad}
            title="Type the passcode into a field"
            onclick={() => chrome.setPinPad(false)}>Type</button>
          <button
            class="segbtn"
            class:on={chrome.pinPad}
            aria-pressed={chrome.pinPad}
            title="Tap the digits on a number pad — made for a phone, works with a mouse"
            onclick={() => chrome.setPinPad(true)}>Keypad</button>
        </div>
      </div>
      <p class="hint">Keypad shows a number pad when a passcode is asked for. Off, it is a text field.</p>
        <div class="row end">
      <button class="done" onclick={() => (open = false)}>Done</button>
        </div>
      </div>
    {:else if tab === "reading"}
      <div
        class="tabpanel"
        role="tabpanel"
        id="settings-panel-reading"
        aria-labelledby="settings-tab-reading"
      >
      <!-- Reader view: the one switch that changes where article text comes
           from. Off by default — it costs a request per post, and the feed's own
           text is already here. -->
      <div class="row">
        <span class="key">Reader view</span>
        <div class="seg" role="group" aria-label="Where article text comes from">
          <button
            class="segbtn"
            class:on={!reading.extract}
            aria-pressed={!reading.extract}
            title="Show the text the feed sent"
            onclick={() => reading.setExtract(false)}>Feed</button>
          <button
            class="segbtn"
            class:on={reading.extract}
            aria-pressed={reading.extract}
            title="Fetch the original page and keep just the article"
            onclick={() => reading.setExtract(true)}>Article</button>
        </div>
      </div>
      <p class="hint">
        Article fetches the original page and keeps only the text; if the page
        cannot be fetched, the feed's own text is shown.
      </p>
      <div class="row">
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

      <!-- Automatic sync. Off by default: a sync is five requests against
           someone else's server, and spending them unprompted is the user's
           choice to make, not the app's. -->
      <div class="row">
        <span class="key">Auto sync</span>
        <div class="seg" role="group" aria-label="Sync automatically">
          <button
            class="segbtn"
            class:on={!chrome.autoSync}
            aria-pressed={!chrome.autoSync}
            title="Only fetch when sync is pressed"
            onclick={() => chrome.setAutoSync(false)}>Off</button>
          <button
            class="segbtn"
            class:on={chrome.autoSync}
            aria-pressed={chrome.autoSync}
            title="Sync when the app opens, and on a timer after that"
            onclick={() => chrome.setAutoSync(true)}>On</button>
        </div>
      </div>
      <div class="row">
        <span class="key">Every</span>
        <div class="seg wrap" role="group" aria-label="How often to sync automatically">
          {#each AUTO_SYNC_HOURS as hours (hours)}
            <button
              class="segbtn"
              class:on={chrome.autoSyncHours === hours}
              aria-pressed={chrome.autoSyncHours === hours}
              aria-label={autoSyncLabel(hours)}
              title={autoSyncLabel(hours)}
              disabled={!chrome.autoSync}
              onclick={() => chrome.setAutoSyncHours(hours)}>{hours}h</button
            >
          {/each}
        </div>
      </div>
      <p class="hint">
        Off, nothing is fetched until you press sync. On, it syncs when the app opens
        and {autoSyncLabel(chrome.autoSyncHours).toLowerCase()} while it stays open.
      </p>
        <div class="row end">
      <button class="done" onclick={() => (open = false)}>Done</button>
        </div>
      </div>
    {:else}
      <div
        class="tabpanel"
        role="tabpanel"
        id="settings-panel-web"
        aria-labelledby="settings-tab-web"
      >
      <!-- The reader is a web app; the desktop build is that app in a window, and
           the phone build is the same app in a browser. This tab is the bridge:
           the address, the switch, and nothing that pretends to be a sync
           service. The phone keeps its own session and its own cached posts. -->
      {#if !lan.available}
        <p class="hint">
          This is the web version. Open it on a phone at the address of the
          machine serving it, and add it to the home screen — it runs in the
          browser there, with its own session.
        </p>
      {:else}
        <div class="row">
          <span class="key">Share on network</span>
          <div class="seg" role="group" aria-label="Serve the reader to the network">
            <button
              class="segbtn"
              class:on={lan.url === null}
              aria-pressed={lan.url === null}
              title="Nothing is served"
              disabled={lan.busy}
              onclick={() => void lan.stop()}>Off</button>
            <button
              class="segbtn"
              class:on={lan.url !== null}
              aria-pressed={lan.url !== null}
              title="Serve the reader to anything on this network"
              disabled={lan.busy}
              onclick={() => void lan.start()}>On</button>
          </div>
        </div>
        <div class="row">
          <span class="key">Port</span>
          <span class="num">
            <input
              class="value"
              type="number"
              min={LAN_PORT_MIN}
              max={LAN_PORT_MAX}
              step="1"
              value={lan.port}
              aria-label="Port to serve on"
              onchange={(event) => void lan.setPort(Number(event.currentTarget.value))}
              onblur={(event) => (event.currentTarget.value = String(lan.port))}
            />
          </span>
        </div>
        {#if lan.url !== null}
          <div class="row">
            <span class="key">Address</span>
            <span class="pick">
              <button class="mini" title="Open in the browser" onclick={() => void openWeb()}>Open</button>
              <button class="mini" title="Copy the address" onclick={() => void copyWeb()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          <p class="hint"><code class="lanurl">{lan.url}</code></p>
        {/if}
        <p class="hint">{LAN_LABELS[lan.state]} — {lanNote(lan.state)}</p>
        {#if lan.error !== null}
          <p class="hint error">{lan.error}</p>
        {/if}
      {/if}
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
    /* A popup, not a page: it is capped by the window, not by a fixed number of
       pixels. 72vh was a guess that scrolled the colours tab on a tall window
       with room to spare; the room the window actually has is what it gets, so a
       tab scrolls only when the window itself is too short to hold it. */
    max-height: calc(100vh - 68px);
    overflow-y: auto;
    overscroll-behavior: contain;
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
    position: sticky;
    top: -10px;
    z-index: 1;
    display: flex;
    gap: 2px;
    margin: 0 0 2px;
    padding: 10px 0 6px;
    background: var(--surface);
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

  /* Two to a line. The panel is 268px, so a half cell is a label and a swatch
     and nothing else — the hex would push the label into an ellipsis on the
     longer names, and the value is one hover away. */
  /* A rule above the colours, because the three rows above them are switches and
     these ten are paint: without the line the grid read as more of the same list
     and the section had no beginning. */
  .swatches {
    margin-top: 5px;
    padding: 7px 0 4px;
    border-top: 1px solid var(--border-soft);
  }

  .swgroup {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px 12px;
  }

  /* The group's name, and the reason the colours under it are called Open and
     Locked rather than Lock open and Lock locked. */
  .sglabel {
    grid-column: 1 / -1;
    padding-bottom: 1px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* A group is a section: a short rule and a breath, so accent and trim do not
     read as the first two of ten. */
  /* The background's controls are rows, not swatch cells: they are a colour, a
     file, two sliders and a switch, and only the first of those is square. */
  .bgsection {
    display: block;
    margin-top: 4px;
    padding-top: 5px;
    border-top: 1px solid var(--border-soft);
  }

  .bgsection .bgrow {
    padding: 2px 0;
  }

  .bgslider {
    padding: 3px 0;
  }

  .mini {
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .mini:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  .mini:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The file input is the button: a label with an invisible input over it, so it
     looks like the Clear beside it and the picker is still the browser's. */
  .file {
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
  }

  .file input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }

  .swgroup + .swgroup {
    margin-top: 4px;
    padding-top: 5px;
    border-top: 1px solid var(--border-soft);
  }

  .sw {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
    padding: 2px 0;
  }

  /* No hex in the cells: at half width the label and the swatch are the whole
     cell, and the value is in the tooltip. */
  .sw code {
    display: none;
  }

  .sw .key {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .range {
    width: 74px;
    accent-color: var(--accent);
  }

  .range.wide {
    width: 96px;
  }

  /* A threshold reads on two lines: label and its number, then the slider across
     the whole panel. Sharing one line left the track 96px wide for a range of
     360-2000, so a pixel of travel moved the threshold by 17 — the difference
     between a control and a trap. */
  .row.slider {
    flex-wrap: wrap;
    row-gap: 1px;
  }

  .row.slider .key {
    flex: 1 1 auto;
  }

  .row.slider .range.wide {
    flex: 1 1 100%;
    width: auto;
    margin: 0;
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

  /* Six intervals do not fit one line in a 268px panel, and a squeezed row of
     10px buttons is worse than two clean ones. */
  .seg.wrap {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .segbtn:disabled {
    opacity: 0.4;
    cursor: default;
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

  /* The address is long and gets typed into a phone: it is set as code, on its
     own line, and it wraps rather than being cut. */
  .lanurl {
    display: inline-block;
    padding: 3px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    background: var(--bg);
    font-size: 11px;
    word-break: break-all;
  }

  .hint.error {
    color: var(--tone-hidden);
  }
</style>
