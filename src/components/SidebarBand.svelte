<script lang="ts">
  import { bandFacts } from "../lib/band";
  import { lockHint, lockOpensPanel, lockState, lockTitle, lockUsable } from "../lib/lock-title";
  import { appendDigit, backspace } from "../lib/pinpad";
  import { chrome } from "../state/chrome.svelte";
  import { layout } from "../state/layout.svelte";
  import { nextHiddenView } from "../state/hidden";
  import { reader } from "../state/reader.svelte";
  import PinPad from "./PinPad.svelte";

  let lockOpen = $state(false);
  let code = $state("");

  /**
   * The band answers a lock and an unlock with one small pulse of its own
   * colour — red going down, green coming back — rather than a light thrown
   * across the window. It is the band that changed, so the band is what
   * answers.
   *
   * A window that asked for reduced motion gets no pulse at all: the ring is
   * removed on `animationend`, so drawing it with the animation switched off
   * would leave it on the band for good.
   */
  let pulse = $state<"lock" | "unlock" | null>(null);

  const mayPulse = () =>
    typeof window === "undefined" || !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** Whether the controls are being pulled out right now (see `.opening`). */
  let opening = $state(false);
  let reveal = $state<HTMLElement | undefined>(undefined);
  /** Natural height of the controls, so the expand can overshoot and settle. */
  let bandH = $state(0);
  /** The box the passcode is typed into, focused when the surface opens. */
  let field = $state<HTMLInputElement | undefined>(undefined);
  /** The surface itself, so Escape works from the field and from the pad. */
  let surface = $state<HTMLElement | undefined>(undefined);
  /** The lock glyph, so Escape can hand focus back to what opened the surface. */
  let lockBtn = $state<HTMLButtonElement | undefined>(undefined);

  let wasLocked = reader.hiddenLocked;
  let wasCollapsed = chrome.bandCollapsed;

  $effect(() => {
    const lockedNow = reader.hiddenLocked;
    if (lockedNow !== wasLocked) {
      wasLocked = lockedNow;
      if (mayPulse()) pulse = lockedNow ? "lock" : "unlock";
      // A lock on a phone folds the band away as it locks it. The curtain is
      // already down; leaving the controls on screen beside it says the
      // categories are still one press away, which is the opposite of the
      // point. The fold handle stays — it is how the band comes back.
      //
      // The fold is the lock's, not the reader's: it is remembered rather than
      // stored, and unlocking gives the band back the fold it had. Otherwise one
      // lock would leave the band folded for good, and no reader chose that.
      if (lockedNow && layout.device === "phone") chrome.collapseBandForLock();
      else if (!lockedNow) chrome.restoreBand();
    }
  });

  $effect(() => {
    const collapsedNow = chrome.bandCollapsed;
    if (collapsedNow !== wasCollapsed) {
      wasCollapsed = collapsedNow;
      // Only the way out gets the spring: closing by hand should feel like
      // putting something away, not like it is fighting back.
      if (!collapsedNow) opening = true;
    }
  });

  $effect(() => {
    if (chrome.bandCollapsed || reveal === undefined) return;
    const measured = reveal.scrollHeight;
    if (measured > 0 && measured !== bandH) bandH = measured;
  });

  /** The field is the point of the press, so focus lands in it. */
  $effect(() => {
    if (!lockOpen || chrome.pinPad) return;
    field?.focus();
  });

  /**
   * Escape puts the surface away from anywhere inside it — the field, the pad,
   * the submit key — and hands focus back to the lock glyph.
   *
   * Bound here rather than as an attribute: the surface holds a form, and a form
   * with a keydown handler is a form Svelte's checks are right to complain about.
   */
  $effect(() => {
    if (!lockOpen || surface === undefined) return;
    const node = surface;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePasscode(true);
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  });

  /**
   * All three states come from one model, and that model is derived from state
   * the app already holds — the fold on `chrome`, the view, lock and counts on
   * the reader. Nothing here is a second copy of any of it.
   */
  const facts = $derived(
    bandFacts({
      collapsed: chrome.bandCollapsed,
      locked: reader.hiddenLocked,
      available: reader.hiddenAvailable,
      authority: reader.hiddenAuthority,
      view: reader.hiddenView,
      pinnedCount: reader.pinnedCount,
      pinView: reader.pinView,
    }),
  );

  const locked = $derived(reader.hiddenLocked);

  /**
   * What the lock can honestly say.
   *
   * `unknown` is a real answer here: a build served from another origin cannot
   * read the adapter's state at all, and claiming "no passcode" in that case
   * told the reader something false about their own server.
   */
  const lock = $derived(
    lockState(
      reader.hiddenAvailable,
      reader.hiddenHasPasscode,
      reader.session !== null,
      reader.hiddenAuthority,
    ),
  );
  const hint = $derived(lockHint(lock));
  const lockTip = $derived(lockTitle(lock, reader.hiddenAuthority === "local" ? "local" : "extension"));
  // Bound here rather than called from the markup: an import used only inside a
  // template expression is pruned by the compiler and the call then throws.
  const lockEnabled = $derived(lockUsable(lock));

  /**
   * What the pin can honestly say about itself.
   *
   * A pin has two possible homes — the extension's favourites, or this device —
   * and the press means something different in each: one mark every device sees,
   * or one mark only here. The eye already names its own backing, so the pin
   * names its own in the same words rather than apologising for the extension:
   * "Pinned Categories is not enabled" said what was missing, never where the
   * pin was going.
   */
  const pinTip = $derived(
    facts.pinLabel === null
      ? `Pinned: ${facts.pinnedCount} — click to change the pin filter`
      : `Pinned: ${facts.pinLabel} — click for ${facts.pinNext}${
          reader.pinsOnDevice ? " on this device" : ""
        }`,
  );

  /**
   * The band with nothing engaged: no curtain, the eye on its own default view,
   * the pin on its own.
   *
   * That is the state a sidebar spends nearly all its time in, and on a phone it
   * was still paying two rows — a fold handle above a labelled row — to say
   * nothing had been asked of it. Idle, the handle joins the row and the two
   * words go: "Hidden" and "Active" *are* the defaults (see `emptyHidden` in
   * `state/hidden` and `PIN_VIEW_CYCLE` in `state/pins`), so on a phone they
   * named nothing the glyphs and their pressed states do not.
   *
   * The seats, their presses and every spoken name stay exactly as they are; a
   * press on either control leaves this state, and the labels come back with it.
   * Read from the stores rather than kept here: the defaults are the app's, and a
   * second copy of them would be a second answer to "what is untouched".
   */
  const idle = $derived(
    !locked && reader.hiddenView === "hidden" && reader.pinView === "all",
  );

  /**
   * The eye's next view, in whichever store is keeping the set.
   *
   * A server without the extension is not a server without the feature: the
   * press goes to this device's set and lands on the same frame, so nothing here
   * may be refused for want of an extension.
   */
  async function cycleHidden(): Promise<void> {
    if (locked) return;
    const outcome = await reader.setHiddenView(nextHiddenView(reader.hiddenView));
    // The adapter answers a locked account with 423 rather than letting a view
    // write through. That answer opens this same surface — the passcode field
    // under the band — instead of a toast that would say what is hidden.
    if (outcome?.kind === "reconciled" && outcome.status === 423) openPasscode();
  }

  function cyclePins(): void {
    void reader.cyclePinView();
  }

  function openPasscode(): void {
    lockOpen = true;
  }

  /**
   * Locking is one press.
   *
   * The curtain is the point of the control: a confirmation step makes the
   * moment it is needed the moment it is slowest. If the extension has no
   * passcode yet there is nothing to lock *with*, so that is the only case that
   * opens the inline surface, and it says so.
   */
  async function pressLock(): Promise<void> {
    if (locked) {
      openPasscode();
      return;
    }
    if (lockOpensPanel(lock)) {
      openPasscode();
      // The panel offers a passcode this server may already have; re-reading is
      // how it stops offering one it does not.
      void reader.loadHiddenState();
      return;
    }
    await reader.lockHidden();
    if (reader.hiddenLocked) closePasscode(false);
    // A lock the server refused leaves the reason in `lockNotice`; the band's
    // own surface is where it is read, so it opens rather than swallowing it.
    else openPasscode();
  }

  /** Folding the band puts its question away with it. */
  function toggleBand(): void {
    if (!chrome.bandCollapsed) closePasscode(false);
    chrome.toggleBand();
  }

  /**
   * The work, without an event around it.
   *
   * Both entry shapes call these: a typed form submits, and the keypad's own
   * submit key calls them directly. One copy of the rules, so the pad cannot
   * unlock differently from the field.
   */
  async function doUnlock(): Promise<void> {
    if (code === "" || reader.hiddenBusy) return;
    const ok = await reader.unlockHidden(code);
    if (ok) closePasscode(true);
  }

  async function submitUnlock(event: SubmitEvent) {
    event.preventDefault();
    await doUnlock();
  }

  async function doSetCode(): Promise<void> {
    if (reader.hiddenBusy) return;
    const ok = await reader.setHiddenPasscode(code);
    if (ok) closePasscode(true);
  }

  async function submitCode(event: SubmitEvent) {
    event.preventDefault();
    await doSetCode();
  }

  /** One key, one digit — the cap and the digit check live in `lib/pinpad`. */
  function typeDigit(digit: string): void {
    code = appendDigit(code, digit);
  }

  function rubOut(): void {
    code = backspace(code);
  }

  /**
   * Closes the passcode surface in place.
   *
   * `back` is false when the band itself is closing it (a lock just landed),
   * because there is nothing to return focus from. Escape and Cancel hand focus
   * to the lock glyph that opened it.
   */
  function closePasscode(back: boolean): void {
    lockOpen = false;
    code = "";
    if (back) lockBtn?.focus();
  }
</script>

{#snippet pinControl()}
  <button
    class="ctl pin"
    class:on={reader.pinView !== "without"}
    class:only={reader.pinView === "only"}
    onclick={cyclePins}
    title={pinTip}
    aria-label={`Pinned: ${facts.pinName}`}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8" />
      <!-- The "Hidden" view is the pin turned off, so it is drawn the way the
           eye is drawn when it hides: grey, and struck through. A pin sitting
           in the same lit colour in all three views said the filter was on
           while the list had the pinned rows taken out of it. -->
      {#if reader.pinView === "without"}
        <path d="M4 4l16 16" />
      {/if}
    </svg>
    {#if facts.pinLabel !== null}
      <span class="lbl">{facts.pinLabel}</span>
    {/if}
  </button>
{/snippet}

<!-- One band above the stream list: eye on the left, lock in the middle, pin on
     the right. Each control is drawn from `facts`, so the three states are one
     model rather than three branches of markup that can drift apart. -->
<div class="bandbox" class:collapsed={chrome.bandCollapsed} class:idle class:locked>
  {#if pulse}
    <span
      class="pulse {pulse}"
      aria-hidden="true"
      onanimationend={() => (pulse = null)}
    ></span>
  {/if}
  <!-- The caret is a bar across the top of the band, and it is always here —
       locked, collapsed, or neither: it is the way to fold the band, not part of
       what the curtain covers. The arrow points up while the controls are
       showing and down while they are hidden, so the direction always describes
       what a click will do. -->
  {#if locked}
    <!-- The pin, on its own strip above the caret and everything the curtain
         covers.
         It was folded away with the rest for a while, on the argument that a
         control changing the list the lock just covered is a control whose result
         nobody can check — and the owner's answer is that a pin is *what* is
         shown, not what is in it: choosing "Starred only" or "without pins" is
         reading the list that is left, and needing the passcode first is the lock
         doing something nobody asked it to. On a phone the lock also folds the
         band (`collapseBandForLock`), which is why this sits *outside* the reveal
         rather than in the compact row: folded, the band is a caret, and the pin
         stays under the thumb.
         It sits *above* the caret on the owner's word (2026-11-07): the handle
         you fold with belongs at the bottom of the strip, under the things it
         folds, not on top of them.
         The curtain still applies to what it says: while locked `bandFacts` gives
         the pin no word and names it by the count alone, so the strip cannot be
         read as a statement about what is hidden. -->
    <div class="band compact pinstrip">
      {@render pinControl()}
    </div>
  {/if}
  <button
    class="bar"
    onclick={toggleBand}
    aria-expanded={!chrome.bandCollapsed}
    aria-label={chrome.bandCollapsed ? "Expand sidebar controls" : "Collapse sidebar controls"}
    title={chrome.bandCollapsed ? "Expand" : "Collapse"}
    >
    <svg class="caret" class:up={!chrome.bandCollapsed} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>
  {#if facts.row}
    <div
      class="reveal"
      class:opening
      bind:this={reveal}
      style="--band-h: {bandH}px"
      onanimationend={() => (opening = false)}
    >
    {#if locked}
      <!-- Locked: the band compacts to low-key glyphs on a quieter face. The
           eye is not among them — a bare eye still says a filter exists — and no
           word is drawn. The pin is not here either: it keeps its own strip above
           this row (see the caret's own comment), because a phone folds the whole
           band the moment the lock lands. What is left is the way back in. -->
      <div class="band compact">
        <span class="seat" aria-hidden="true"></span>
        <button
          class="ctl lock on"
          bind:this={lockBtn}
          onclick={pressLock}
          aria-expanded={lockOpen}
          aria-controls={lockOpen ? "band-passcode" : undefined}
          title="Unlock"
          aria-label="Unlock"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </button>
      </div>
    {:else}
      <div class="band">
        {#if facts.hidden}
          <button
            class="ctl hidden"
            class:on={reader.hiddenView !== "hidden"}
            class:only={reader.hiddenView === "only"}
            onclick={cycleHidden}
            disabled={!facts.hidden.enabled}
            title={facts.hidden.enabled
              ? `${facts.hidden.label}${facts.hidden.authority === "local" ? " on this device" : ""} — click for ${facts.hidden.next}`
              : "Hidden Categories is not enabled on this server"}
            aria-label={`Hidden categories: ${facts.hidden.label}`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {#if reader.hiddenView === "hidden"}
                <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3.1 4.2M6.6 6.6C4.3 8 2.7 10.2 2 12c1 2.5 5 7 10 7a9.9 9.9 0 0 0 5.4-1.6" />
              {:else if reader.hiddenView === "revealed"}
                <!-- Revealed wears HardlyTracking's own eye — the open eye with the
                     corner-to-corner stroke (`EYE_PATHS.revealed` in that app) —
                     so the same view reads as the same control in both. One path,
                     not a shape plus a pupil: it is the glyph the owner points
                     at when he says "like that one". -->
                <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M4 20 20 4" />
              {:else}
                <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" />
                <circle cx="12" cy="12" r="3" />
              {/if}
            </svg>
            <span class="lbl">{facts.hidden.label}</span>
          </button>
        {/if}

        <!-- One press locks. Nothing to confirm: the curtain is the point. -->
        <button
          class="ctl lock"
          bind:this={lockBtn}
          onclick={pressLock}
          disabled={!lockEnabled}
          aria-expanded={lockOpen}
          aria-controls={lockOpen ? "band-passcode" : undefined}
          title={lockTip}
          aria-label="Lock hidden categories"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 7.5-2" />
          </svg>
        </button>

        {@render pinControl()}
      </div>
    {/if}

    {#if lockOpen}
      <!-- The passcode opens in place under the band, never as a modal: it is
           the band's own question, and Escape puts it away again. -->
      <div
        class="passcode"
        class:padmode={chrome.pinPad}
        class:setting={!locked}
        id="band-passcode"
        bind:this={surface}
      >
        <form
          onsubmit={locked ? submitUnlock : submitCode}
          aria-label={locked ? "Passcode" : "Set a passcode"}
        >
          {#if chrome.pinPad}
            <!-- The pad replaces the field entirely: no input means no soft
                 keyboard rising over the band on a phone. -->
            <PinPad
              value={code}
              label={locked ? "Passcode" : "New passcode"}
              length={locked ? (reader.hiddenPasscodeLength ?? undefined) : undefined}
              tone={locked ? "var(--tone-lock-closed)" : "var(--accent)"}
              submitLabel={locked ? "Unlock" : "Save passcode"}
              busy={reader.hiddenBusy}
              onDigit={typeDigit}
              onBackspace={rubOut}
              onSubmit={locked ? doUnlock : doSetCode}
            />
            <button type="button" class="cancel" onclick={() => closePasscode(true)}>Cancel</button>
          {:else}
            <svg class="key" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <input
              id="unlock-code"
              type="password"
              inputmode="numeric"
              maxlength="6"
              autocomplete="off"
              placeholder="Passcode"
              aria-label="Passcode"
              bind:this={field}
              bind:value={code}
            />
            <button type="submit" class="go" disabled={reader.hiddenBusy || code === ""}>
              {locked ? "Unlock" : "Save"}
            </button>
            <button type="button" class="cancel" onclick={() => closePasscode(true)}>Cancel</button>
          {/if}
        </form>
        {#if !locked && hint !== null}
          <p class="hint">{hint}</p>
        {/if}
        {#if reader.lockNotice}
          <p class="notice" role="status">{reader.lockNotice}</p>
        {/if}
      </div>
    {/if}
    </div>
  {/if}

</div>

<style>
  /* The band is a raised strip on the sidebar: #2f2f2f against #171717 in the
     reference. Written as a mix of the theme's own surface and ink, so the light
     theme gets greys that belong to it instead of a dark slab. */
  .bandbox {
    /* No fill at all behind the three controls. Any tint read as a grey slab
       laid over the sidebar, so the band is only a hairline and a light: the
       buttons sit on the sidebar's own colour, and the glass is what is left
       when there is nothing to see. */
    --band-face: transparent;
    --band-face-quiet: transparent;
    --band-edge: color-mix(in srgb, var(--text) 12%, transparent);
    --band-light: color-mix(in srgb, #fff 8%, transparent);
    position: relative;
    margin: 0 8px 6px;
  }

  /* Lock and unlock answer here: a thin ring that grows a hair and fades on the
     band's own edge. Red for the curtain going down, green for it coming back —
     the same two colours the controls already use, so nothing new is taught.
     Nothing is drawn over the window, and it is over in a third of a second. */
  .pulse {
    position: absolute;
    inset: -2px;
    border-radius: 12px;
    pointer-events: none;
    animation: hrs-bar-pulse 360ms ease-out both;
  }

  .pulse.lock {
    --pulse-tone: var(--tone-hidden, #e5484d);
  }

  .pulse.unlock {
    --pulse-tone: var(--tone-unlock, #3fbf6f);
  }

  /* The controls are pulled out from under the bar: clipped while they move,
     overshooting their own height and a couple of percent of scale before they
     settle. Quick — a quarter of a second — and the overshoot is small enough
     that it reads as weight, not as a bounce. */
  .reveal {
    overflow: hidden;
  }

  .reveal.opening {
    animation: band-unfold 260ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    transform-origin: top center;
  }

  @keyframes band-unfold {
    0% {
      max-height: 0;
      opacity: 0;
      transform: translateY(-3px) scaleY(0.92);
    }
    58% {
      max-height: calc(var(--band-h, 80px) + 7px);
      opacity: 1;
      transform: translateY(1px) scaleY(1.035);
    }
    82% {
      max-height: var(--band-h, 80px);
      transform: translateY(0) scaleY(0.995);
    }
    100% {
      max-height: var(--band-h, 80px);
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pulse-tone) 45%, transparent);
    }

    .reveal.opening {
      animation: none;
    }
  }

  /* Full-width caret bar: the handle for the whole band, in both states. Kept
     short — it is a handle, not a row, and with the search field above it the
     list has already paid for two strips. */
  .bar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 8px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    opacity: 0.45;
    cursor: pointer;
    border-radius: 6px;
  }

  /* Collapsed it is all that is left of the band, so it keeps enough body to be
     a target without pretending to be a full row. */
  .bandbox.collapsed .bar {
    height: 12px;
  }

  /* Folded on a phone it is the whole band, so it is a row: 16px of handle above
     a 34px target would be a hairline you have to find. 20px was a row paying for
     the words it no longer draws — folded there is one caret and nothing else. */
  :global(html[data-device="phone"]) .bandbox.collapsed .bar {
    height: 16px;
    opacity: 0.85;
  }

  /* Folded, it is the pane's width, edge to edge, and it sits closer to the
     search row than the open band does. The rail's right padding exists to keep
     the day/night switch off the glass while the controls are showing; folded
     there is no switch beside it, so the same padding left an 11px stripe of
     nothing at the end of a hairline — invisible on a flat colour, obvious
     against a picture. */
  :global(html[data-device="phone"]) .bandbox.collapsed {
    /* Right, the rail's own 10px of padding is taken back: that padding exists
       to keep the day/night switch off the glass, and folded there is no switch
       beside the handle. A negative margin rather than a rule on the rail,
       because the rail is another component's box and this one is ours. */
    margin: 0 -10px 0 0;
  }

  /* On a phone the band shares a row with the day / night switch (the rail in
     `Sidebar`), so it takes the width that is left instead of a margin of its
     own on the right: the rail's padding is what keeps the pair off the edge. */
  :global(html[data-device="phone"]) .bandbox {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0 0 6px;
  }

  /* Open or folded, the handle sits in the same place: the strip across the top
     of the band. A phone used to move it to the trailing edge while the controls
     were showing, so folding the band made the control it was pressed with jump
     to a different corner — one control in two places reads as two controls, and
     the one you just pressed is never where your thumb has learned to go. */
  :global(html[data-device="phone"]) .bandbox.idle:not(.collapsed) {
    margin-bottom: 4px;
  }

  :global(html[data-device="phone"]) .bandbox.idle:not(.collapsed) > .bar {
    height: 16px;
    opacity: 0.85;
  }

  :global(html[data-device="phone"]) .bandbox.idle:not(.collapsed) > .bar .caret {
    width: 14px;
    height: 14px;
  }

  /* The seats lose their labels and the padding that spaced them, never their
     glyphs: three presses in a 26px row are still three 26px targets, which is
     what the coarse-pointer rule below asks for everywhere else. */
  :global(html[data-device="phone"]) .bandbox.idle .ctl {
    min-height: 26px;
    padding: 1px 4px;
  }

  :global(html[data-device="phone"]) .bandbox.idle .lbl {
    display: none;
  }

  .bar:hover,
  .bar:focus-visible {
    opacity: 1;
    background: var(--hover);
  }

  .bar .caret {
    width: 11px;
    height: 11px;
    transition: transform 0.15s ease;
  }

  .bar .caret.up {
    transform: rotate(180deg);
  }

  /* Three seats, one row: eye, lock, pin. The lock sits in the middle because
     its column is sized to the glyph, so the two halves either side are equal at
     every sidebar width and the labels give up their ends evenly. */
  /* One glass slab: translucent, blurred, hairline edge. Every seat inside is
     inset by the same 2px, so its ring lines up with the band's edge instead of
     cutting a second, smaller curve across it. */
  .band {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: stretch;
    gap: 2px;
    padding: 2px;
    border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
    border-radius: 11px;
    background: color-mix(in srgb, var(--band-face) 52%, transparent);
    -webkit-backdrop-filter: blur(12px) saturate(1.25);
    backdrop-filter: blur(12px) saturate(1.25);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent),
      0 10px 20px -16px rgba(0, 0, 0, 0.75);
  }

  /* Locked: the same glass, dimmer — a curtain, not a menu. */
  .band.compact {
    border-color: color-mix(in srgb, var(--text) 6%, transparent);
    background: color-mix(in srgb, var(--band-face) 30%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent);
  }

  /* Locked, on a phone, the band is two glyphs and nothing else: a lock and a
     pin. The full-width pill it used to draw around them was a border with no
     edge to hold — one control centred in a slab across the column reads as a
     disabled row, not as a lock. The slab stays on a window, where the band is
     a row of three seats with words in it. */
  :global(html[data-device="phone"]) .bandbox.locked .band.compact {
    border: 0;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: none;
  }

  .ctl {
    --tone: var(--muted, #999);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    min-width: 0;
    min-height: 26px;
    padding: 2px 6px;
    border: 0;
    /* The band's 11px minus its 1px border minus the 2px inset: every seat's
       ring follows the same curve, one step inside the band's own edge. */
    border-radius: 8px;
    background: transparent;
    color: var(--tone);
    font: inherit;
    cursor: pointer;
    transition:
      background-color 0.14s ease,
      color 0.14s ease,
      box-shadow 0.14s ease,
      transform 0.08s ease;
  }

  /* A seat carrying a state wears its tone as GLASS: a wash thin enough to see
     the list through, and a 1px ring in the same tone so the edge reads as
     coloured light rather than a painted border. Grey fill is what made hidden,
     lock and pinned look like three disabled buttons. */
  .ctl.hidden.on,
  .ctl.lock,
  .ctl.pin.on {
    background: color-mix(in srgb, var(--tone) 11%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 32%, transparent);
  }

  .ctl.hidden.on {
    --tone: var(--tone-hidden);
  }

  /* The pin keeps its tone while it is filtering the list — "Active" and "Only"
     are both working states, so a grey seat would read as a disabled control.
     "Hidden" is the pin switched off, and it is drawn the way the eye is when it
     hides: the quiet ink, no glass, and its glyph struck through. */
  .ctl.pin.on {
    --tone: var(--tone-pinned);
  }

  /* "Only" narrows the list to one thing, so both seats say it the same way:
     the tone lifts towards white, and the ring with it. Subtle on purpose —
     the word under the glyph already says which view this is, so the light only
     has to confirm it. Owner, 2026-11-06: "brighter red for hidden, brighter
     blue for pinned, but subtle, maybe just make the text lighter and
     brighter". */
  .ctl.hidden.only,
  .ctl.pin.only {
    --tone: color-mix(in srgb, var(--only-base) 68%, #fff);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 46%, transparent);
  }

  .ctl.hidden.only {
    --only-base: var(--tone-hidden);
  }

  .ctl.pin.only {
    --only-base: var(--tone-pinned);
  }

  .ctl.lock {
    --tone: var(--tone-lock-open);
    /* Two of the band's three seats carry a word and take 85–137px; the lock has
       only a shackle. 26px read as a sliver, and 44 still looked like the odd one
       out beside them, so it takes a third of the band's own width instead: a
       square-ish seat the size of the thing it sits between. Measured at 56px
       with the band at 223px (desktop) and 317px (phone), no overflow. */
    min-width: 56px;
  }

  .ctl.lock svg {
    width: 18px;
    height: 18px;
  }

  .ctl.lock.on {
    --tone: var(--tone-lock-closed);
  }

  /* Hover lifts a seat in its OWN tone: the glass takes more of the colour and
     the ring brightens, so the light in the pane changes rather than a grey
     overlay landing on it. */
  .ctl:hover:not(:disabled) {
    background: color-mix(in srgb, var(--tone) 20%, transparent);
    color: var(--tone);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 52%, transparent);
  }

  /* Pressed: the seat takes the tone, so the click is answered on the frame the
     pointer goes down. */
  .ctl:active:not(:disabled) {
    transform: scale(0.97);
    background: color-mix(in srgb, var(--tone) 30%, transparent);
    color: var(--tone);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 74%, transparent);
  }

  .ctl:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Locked, the band is glyphs only: shorter seats, and the pin keeps to the
     right edge of its third rather than filling it. */
  .band.compact .ctl {
    min-height: 22px;
    padding: 2px 3px;
  }

  /* The pin's own strip above the locked row: one control, on the quiet face the
     locked band wears. It used to keep the right edge of a two-column row — a
     22px glyph in a 200px band, which read as something left behind rather than
     the one control the strip has. Alone, it takes the strip's whole width and
     centres its glyph: the seat is the width of the band, so the strip reads as
     one wide button instead of a stray mark at its end. */
  .band.compact.pinstrip {
    grid-template-columns: minmax(0, 1fr);
    margin-bottom: 2px;
  }

  .band.compact.pinstrip .ctl.pin {
    justify-self: stretch;
    min-width: 0;
    min-height: 30px;
  }

  .band.compact.pinstrip .ctl.pin svg {
    width: 16px;
    height: 16px;
  }

  /* A thumb is not a cursor: on touch the same seats keep enough body to be
     pressed without changing the band's height on a desktop. */
  @media (pointer: coarse) {
    .ctl,
    .band.compact .ctl {
      min-height: 34px;
    }

    .band.compact.pinstrip .ctl.pin {
      min-height: 38px;
    }
  }

  svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .lbl {
    max-width: 100%;
    overflow: hidden;
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.05em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
    opacity: 0.9;
  }

  /* The passcode surface: in place under the band, on the band's own face, so
     it reads as the band asking rather than a window interrupting. */
  .passcode {
    margin-top: 3px;
    padding: 5px 6px;
    border: 1px solid var(--band-edge);
    border-radius: 7px;
    background: var(--band-face);
  }

  .passcode form {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }

  /* With the keypad the surface is a column: dots and keys need the full width,
     and a Cancel under them reads as leaving, not as a third key. */
  .passcode.padmode form {
    flex-direction: column;
    align-items: stretch;
  }

  .passcode .key {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--tone-lock-closed);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .passcode input {
    flex: 1 1 4.5rem;
    min-width: 0;
    padding: 5px 7px;
    border: 1px solid color-mix(in srgb, var(--tone-lock-closed) 45%, transparent);
    border-radius: 7px;
    background: var(--sunken, #171717);
    color: inherit;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.18em;
  }

  .passcode input::placeholder {
    color: var(--muted);
    letter-spacing: 0.04em;
  }

  .passcode input:focus-visible {
    outline: 2px solid var(--tone-lock-closed);
    outline-offset: 1px;
  }

  /* 12px is the size that fits the band's surface, and it is also the size that
     makes iOS zoom the whole app in the moment the box takes focus — the page
     comes back unzoomed only if something else zooms it out, which nothing here
     does. So a thumb device gets 16, the size iOS refuses to zoom for, and a
     pointer keeps the 12 that fits beside 11px buttons. The floor for every
     other field in the app is in `app.css`. This rule sits after the size it
     overrides on purpose: same specificity, so the later one wins. */
  @media (pointer: coarse) {
    .passcode input {
      font-size: 16px;
      letter-spacing: 0.14em;
    }
  }

  .passcode .go {
    flex: 0 0 auto;
    padding: 5px 9px;
    border: 1px solid color-mix(in srgb, var(--tone-lock-closed) 55%, transparent);
    border-radius: 7px;
    background: none;
    color: var(--tone-lock-closed);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .passcode .go:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .passcode .cancel {
    flex: 0 0 auto;
    padding: 4px 9px;
    border: 1px solid var(--band-edge);
    border-radius: 7px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .passcode .cancel:hover {
    color: inherit;
  }

  .passcode.padmode .cancel {
    align-self: center;
    padding: 4px 12px;
  }

  /* Setting a passcode is not unlocking with one: same surface, the app's own
     accent rather than the lock's orange. */
  .passcode.setting .key {
    stroke: var(--accent);
  }

  .passcode.setting input {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .passcode.setting input:focus-visible {
    outline-color: var(--accent);
  }

  .passcode.setting .go {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    color: var(--accent);
  }

  .passcode .hint,
  .passcode .notice {
    margin: 5px 0 0;
    font-size: 11px;
    color: var(--muted);
  }

  .passcode .notice {
    color: var(--danger, #e06c75);
  }
  /* The seat's tint is an 11–20% wash, so the tone at full strength reads
     3.1:1 there in the light theme. Dark faces keep the tone; light faces take
     it darkened, which is the same hue at a contrast a 9px word can carry. */
  :global([data-theme="light"]) .lbl,
  :global(:root:not([data-theme])) .lbl {
    color: color-mix(in srgb, var(--tone) 64%, #04121c);
  }
  :global([data-theme="dark"]) .lbl,
  :global([data-theme="oled"]) .lbl {
    color: var(--tone);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .lbl {
      color: var(--tone);
    }
  }
</style>
