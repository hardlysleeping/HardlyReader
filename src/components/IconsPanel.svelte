<script lang="ts">
  /**
   * Category icons: one row per category, and the picker behind it.
   *
   * The guess is good at Tech, Comics and Music and wrong about a two-word
   * publication name (it reads `Ars Technica` as a person), so the correction has
   * to be somewhere a reader can reach without leaving the app — this is that
   * place, and it is also the only way to give a category an icon that the guess
   * would never have chosen.
   *
   * The picker opens **in place** rather than as a second sheet: the settings
   * sheet is already a sheet on a phone, and a popover inside it would be the
   * third layer over the thing being edited. One row pressed, the list becomes
   * the grid, Done returns.
   */
  import Glyph from "./Glyph.svelte";
  import IconGrid from "./IconGrid.svelte";
  import { icons } from "../state/icons.svelte";
  import { reader } from "../state/reader.svelte";

  /** The label being edited, or null while the list is showing. */
  let editing = $state<string | null>(null);

  const categories = $derived(
    reader.categories.map((category) => ({
      label: category.label,
      feeds: category.feeds.length,
    })),
  );

  function open(label: string): void {
    editing = label;
  }
</script>

{#if editing === null}
  <div class="row">
    <span class="key">Icons</span>
    <button
      class="switch"
      aria-pressed={icons.auto}
      onclick={() => icons.setAuto(!icons.auto)}
      title="Give a category a guessed icon when it has no choice of its own"
    >
      {icons.auto ? "Auto" : "Manual"}
    </button>
  </div>
  <p class="hint">
    {icons.auto
      ? "A category with no icon of its own gets one guessed from its name."
      : "Only the icons you choose are drawn."}
  </p>

  {#each categories as category (category.label)}
    {@const glyph = icons.iconFor(category.label)}
    <button class="row entry" onclick={() => open(category.label)}>
      <span class="mark" aria-hidden="true">
        {#if glyph !== null}
          <Glyph name={glyph} size={16} />
        {:else}
          <span class="none"></span>
        {/if}
      </span>
      <span class="key">{category.label}</span>
      <span class="value">{category.feeds}</span>
    </button>
  {:else}
    <p class="hint">No categories yet — an icon needs a category to sit on.</p>
  {/each}

  {#if Object.keys(icons.map).length > 0}
    <button class="clear-all" onclick={() => icons.resetAll()}>Reset all to guesses</button>
  {/if}
{:else}
  <div class="picker">
    <IconGrid label={editing} onclose={() => (editing = null)} back onback={() => (editing = null)} />
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 0;
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: var(--text);
    text-align: left;
  }

  .value {
    flex: none;
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .switch {
    flex: none;
    padding: 4px 10px;
    border: 1px solid var(--edge-soft);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .switch[aria-pressed="true"] {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .entry {
    border: 0;
    border-top: 1px solid var(--border-soft);
    background: none;
    cursor: pointer;
    font: inherit;
  }

  .entry:hover {
    background: var(--hover);
  }

  /* A fixed box whether or not there is a glyph, so the labels line up down the
     column instead of stepping in and out by 16px. */
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 18px;
    height: 18px;
    color: var(--muted);
  }

  .none {
    width: 8px;
    height: 1px;
    background: var(--edge-soft);
  }

  .hint {
    margin: 4px 0 10px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--muted);
  }

  .clear-all {
    margin-top: 6px;
    padding: 5px 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    cursor: pointer;
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }





  /* A grid that fills the panel's width at any size: the glyphs are all the
     same box, so a wrap reads as a catalogue rather than a spill. */








</style>
