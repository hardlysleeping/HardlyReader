<script lang="ts">
  /**
   * The text this device keeps, as the Settings section draws it.
   *
   * Three answers, one ceiling, and two sentences that a reader has to be able to
   * find: what "ahead" costs them, and who sees the request. The latter is not
   * fine print to be discovered later — fetching a body puts this device's own
   * address in the publisher's log, and a library on this device has no server in
   * between to take that address instead. So it is drawn here, in the same
   * section, in words rather than in a link.
   *
   * The section appears only for a library on this device (`showsSavedText`): a
   * reader whose articles live on a server has no ceiling and nothing to keep,
   * and a row that would do nothing is worse than no row.
   */
  import {
    BODY_BUDGET_CHOICES_MB,
    BODY_KEEP_LABELS,
    BODY_KEEP_MODES,
    BODY_KEEP_TITLES,
    describeBodies,
  } from "../lib/bodies";
  import { bodies } from "../state/bodies.svelte";

  /** Bytes, as the three buttons name them. */
  const MIB = 1024 * 1024;

  /**
   * The three answers, with their words, built in the script rather than read out
   * of the markup: the panel renders through Svelte's server target in a suite,
   * and a helper used only inside a template is elided before it gets there.
   */
  const keepChoices = BODY_KEEP_MODES.map((mode) => ({
    mode,
    label: BODY_KEEP_LABELS[mode],
    title: BODY_KEEP_TITLES[mode],
  }));

  const budgetChoices = BODY_BUDGET_CHOICES_MB;

  /** "12 articles, 1.2 MB of 24 MB" — or that nothing is kept yet. */
  const keptText = $derived(
    describeBodies({ count: bodies.count, bytes: bodies.bytes }, bodies.limit),
  );
</script>

<div class="row">
  <span class="key">Saved text</span>
  <div class="seg" role="group" aria-label="What article text this device keeps">
    {#each keepChoices as choice (choice.mode)}
      <button
        class="segbtn"
        class:on={bodies.mode === choice.mode}
        aria-pressed={bodies.mode === choice.mode}
        title={choice.title}
        onclick={() => bodies.setMode(choice.mode)}>{choice.label}</button>
    {/each}
  </div>
</div>

<p class="hint">
  Saved text is the article itself, kept beside the post on this device, so it
  opens with no network and reads the same tomorrow. <strong>Ahead</strong> also
  prepares the posts just after the one you are reading. Off is the default: the
  feed's own text is always here either way, and nothing is fetched behind your
  back.
</p>

<div class="row">
  <span class="key">Space for text</span>
  <div class="seg" role="group" aria-label="How much article text this device keeps">
    {#each budgetChoices as mb (mb)}
      <button
        class="segbtn"
        class:on={bodies.limit === mb * MIB}
        aria-pressed={bodies.limit === mb * MIB}
        title={`Keep up to ${mb} MB of article text, clearing the least recently read when it is full`}
        onclick={() => bodies.setLimit(mb * MIB)}>{mb} MB</button>
    {/each}
  </div>
</div>

<p class="hint" role="status">{keptText}</p>

{#if bodies.note}
  <p class="hint" role="status">{bodies.note}</p>
{/if}

<p class="hint">
  A saved body is fetched from the publisher's own page, so the request carries
  this device's address into that publisher's log. A reader with a server has
  that server in front of them; a library on this device has nothing in between.
</p>

<p class="hint">
  Text stays on the device that fetched it: the sync file carries feeds, read
  marks, stars, preferences and positions, never articles.
</p>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-dim);
  }

  /* Three short answers side by side; a phone's sheet is narrow, so they wrap
     rather than squeezing into a row of unreadable slivers. */
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    justify-content: flex-end;
  }

  .segbtn {
    padding: 2px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .segbtn.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .hint {
    margin: 2px 0 6px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .hint strong {
    color: var(--text-dim);
    font-weight: 600;
  }
</style>
