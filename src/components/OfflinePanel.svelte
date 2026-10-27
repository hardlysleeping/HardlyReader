<script lang="ts">
  /**
   * The Offline section of the settings panel.
   *
   * Six things, and every one of them is about a copy the app is holding rather
   * than about the reader's library: how much is stored, what the cache is
   * allowed to keep, how large it may get, and the one button that empties it.
   * A subscription, a title, a read mark and a star are not cache — they are the
   * library — so nothing here can delete them, and the words say so.
   *
   * What is missing is deliberate. There is no "download everything": the
   * reader fetches what it is asked for, and a switch that mirrored every feed
   * ahead of time would spend data nobody agreed to spend and keep other
   * people's prose far past reading it. The hint at the foot says that in a
   * sentence, so its absence reads as a decision rather than an omission.
   *
   * The panel owns no policy of its own. `state/offline.svelte.ts` holds the
   * answers and applies them; this file is rows and words, and every value it
   * shows comes from that module or from the library it is attached to.
   */
  import { CACHE_LIMIT_CHOICES, formatBytes, formatLimit } from "../api/local/cache";
  import { offline } from "../state/offline.svelte";
  import { reader } from "../state/reader.svelte";

  /**
   * Re-read the numbers whenever this section is drawn.
   *
   * One scan of the library, not one per render: the section is drawn when the
   * settings sheet is mounted, and again only when a policy change has just
   * written something.
   */
  $effect(() => {
    void offline.refresh();
  });

  /** The pinned feeds, as the reader spells them; the policy turns them into URLs. */
  const pinned = $derived(reader.localPins.feeds);

  /** Any policy change lands at once — a limit that only applied later would lie. */
  function apply(): void {
    void offline.apply(pinned);
  }

  function setLimit(bytes: number): void {
    offline.setLimit(bytes);
    apply();
  }

  function setKeepRead(keep: boolean): void {
    offline.setKeepRead(keep);
    apply();
  }

  function setKeepStarred(keep: boolean): void {
    offline.setKeepStarred(keep);
    apply();
  }

  /**
   * The storage line's own sentence: what is in there, in the terms the reader
   * chose the limit in. A bare megabyte count is a number nobody can act on.
   */
  const breakdown = $derived.by(() => {
    const usage = offline.usage;
    if (usage === null) {
      return offline.picturesCached && offline.pictures.bytes > 0
        ? `${formatBytes(offline.pictures.bytes)} of pictures`
        : null;
    }
    const parts = [
      `${usage.items} article${usage.items === 1 ? "" : "s"}`,
      `${usage.cached} kept for offline`,
    ];
    if (offline.pictures.bytes > 0) parts.push(`${formatBytes(offline.pictures.bytes)} of pictures`);
    return parts.join(" · ");
  });
</script>

<div class="row">
  <span class="key">Storage used</span>
  <span class="state">
    {offline.hasLibrary || offline.pictures.bytes > 0 ? formatBytes(offline.totalBytes) : "—"}
  </span>
</div>
{#if breakdown !== null}
  <p class="hint">{breakdown}</p>
{:else}
  <p class="hint">No offline library on this device yet — local mode keeps one.</p>
{/if}

<div class="row">
  <span class="key">Keep read articles</span>
  <div class="seg" role="group" aria-label="Keep read articles">
    <button
      class="segbtn"
      class:on={!offline.policy.keepRead}
      aria-pressed={!offline.policy.keepRead}
      title="Drop an article's copy once you have read it"
      onclick={() => setKeepRead(false)}>Off</button>
    <button
      class="segbtn"
      class:on={offline.policy.keepRead}
      aria-pressed={offline.policy.keepRead}
      title="Keep an article readable after you have read it"
      onclick={() => setKeepRead(true)}>On</button>
  </div>
</div>

<div class="row">
  <span class="key">Keep starred and pinned</span>
  <div class="seg" role="group" aria-label="Keep starred and pinned">
    <button
      class="segbtn"
      class:on={!offline.policy.keepStarred}
      aria-pressed={!offline.policy.keepStarred}
      title="Let the limit reach starred posts and pinned feeds too"
      onclick={() => setKeepStarred(false)}>Off</button>
    <button
      class="segbtn"
      class:on={offline.policy.keepStarred}
      aria-pressed={offline.policy.keepStarred}
      title="Starred posts and pinned feeds are never evicted"
      onclick={() => setKeepStarred(true)}>On</button>
  </div>
</div>

<div class="row">
  <span class="key">Cache pictures</span>
  <div class="seg" role="group" aria-label="Cache pictures">
    <button
      class="segbtn"
      class:on={!offline.policy.cacheImages}
      aria-pressed={!offline.policy.cacheImages}
      title="Do not keep a copy of article pictures on this device"
      onclick={() => offline.setCacheImages(false)}>Off</button>
    <button
      class="segbtn"
      class:on={offline.policy.cacheImages}
      aria-pressed={offline.policy.cacheImages}
      title="Keep a copy of article pictures on this device"
      onclick={() => offline.setCacheImages(true)}>On</button>
  </div>
</div>
{#if !offline.picturesCached}
  <!-- The switch is a real preference — it is read by the picture cache when
       one is attached — but this build has none, and a control that changed
       nothing without saying so would be the dishonest kind. -->
  <p class="hint">No picture cache in this build yet, so nothing is stored for it.</p>
{/if}

<div class="row wide">
  <span class="key">Cache limit</span>
  <div class="seg wrap" role="group" aria-label="Cache limit">
    {#each CACHE_LIMIT_CHOICES as bytes (bytes)}
      <button
        class="segbtn"
        class:on={offline.policy.limitBytes === bytes}
        aria-pressed={offline.policy.limitBytes === bytes}
        title={bytes === 0
          ? "Let the cache grow without a ceiling"
          : `Keep cached article text under ${formatLimit(bytes)}`}
        onclick={() => setLimit(bytes)}>{formatLimit(bytes)}</button>
    {/each}
  </div>
</div>

<div class="row end">
  <span class="key">Clear cache</span>
  <button
    class="do"
    aria-label="Clear cache"
    disabled={offline.busy || offline.cacheBytes === 0}
    title={offline.cacheBytes === 0
      ? "There is nothing cached to clear"
      : "Drop cached article text and pictures — your feeds, read marks and stars stay"}
    onclick={() => void offline.clear()}
  >{offline.busy ? "Clearing…" : "Clear"}</button>
</div>

{#if offline.note !== null}
  <p class="hint" role="status">{offline.note}</p>
{/if}

<p class="hint">
  Articles are kept as you read them. Nothing is mirrored ahead of time, so there
  is no download-everything switch.
</p>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }

  /* The limit's five answers get a line of their own: beside the label they
     were packed against the scrollbar, which read as a squeezed row of 10px
     buttons. Full width, still right-aligned with the controls above them. */
  .row.wide {
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .row.wide .seg {
    flex: 1 1 100%;
    justify-content: flex-end;
    margin-top: 1px;
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

  /* A state, not a control: the value of a row with nothing to press beside it,
     so it is drawn in the text colour rather than in a button's chrome. */
  .state {
    flex: 0 0 auto;
    color: var(--text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .seg {
    display: flex;
    gap: 3px;
  }

  .seg.wrap {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .segbtn {
    padding: 3px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
  }

  .segbtn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border);
  }

  .segbtn.on {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .segbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .segbtn:focus-visible,
  .do:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .do {
    padding: 3px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
  }

  .do:hover:not(:disabled) {
    border-color: var(--border);
  }

  .do:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .hint {
    margin: 0 0 2px;
    font-size: 10.5px;
    line-height: 1.35;
    color: var(--muted);
  }
</style>
