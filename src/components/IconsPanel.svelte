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
  import { icons } from "../state/icons.svelte";
  import { guessIcon } from "../lib/category-icon";
  import { iconKeywords, iconNames } from "../lib/icons";
  import { reader } from "../state/reader.svelte";

  /** The label being edited, or null while the list is showing. */
  let editing = $state<string | null>(null);
  let query = $state("");

  const categories = $derived(
    reader.categories.map((category) => ({
      label: category.label,
      feeds: category.feeds.length,
    })),
  );

  /** The grid, filtered by the name and by what the glyph is about. */
  const matches = $derived.by(() => {
    const wanted = query.trim().toLowerCase();
    const names = iconNames();
    if (wanted === "") return names;
    return names.filter(
      (name) => name.includes(wanted) || iconKeywords(name).some((word) => word.includes(wanted)),
    );
  });

  /** What the guess would say for the label being edited, for the offer. */
  const guess = $derived(editing === null ? null : guessIcon(editing));

  function open(label: string): void {
    query = "";
    editing = label;
  }

  function pick(name: string): void {
    if (editing === null) return;
    icons.setIcon(editing, name);
    editing = null;
  }

  function clear(): void {
    if (editing === null) return;
    icons.setIcon(editing, null);
    // With auto on the row immediately wears the guess again; with auto off it
    // wears nothing. Either way the answer is visible behind the picker.
    editing = null;
  }

  function letItPick(): void {
    if (editing === null) return;
    icons.resetIcon(editing);
    editing = null;
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
    <button class="back" onclick={() => (editing = null)}>← Icons</button>
    <p class="target">{editing}</p>

    <input
      class="filter"
      type="search"
      placeholder="Filter — cpu, music, camera…"
      bind:value={query}
    />

    <div class="grid" role="listbox" aria-label="Icons">
      {#each matches as name (name)}
        <button
          class="pick"
          class:on={icons.map[editing] === name}
          role="option"
          aria-selected={icons.map[editing] === name}
          title={name}
          onclick={() => pick(name)}
        >
          <Glyph {name} size={18} />
        </button>
      {:else}
        <p class="hint">Nothing matches “{query}”.</p>
      {/each}
    </div>

    <div class="actions">
      <button class="act" onclick={letItPick} disabled={guess === null && icons.map[editing] === undefined}>
        {guess === null ? "Let it pick" : `Let it pick (${guess})`}
      </button>
      <button class="act quiet" onclick={clear}>No icon</button>
    </div>
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

  .back {
    align-self: flex-start;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .target {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .filter {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--edge-soft);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
  }

  .filter:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  /* A grid that fills the panel's width at any size: the glyphs are all the
     same box, so a wrap reads as a catalogue rather than a spill. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
    gap: 4px;
    max-height: 46vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px;
  }

  .pick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }

  .pick:hover {
    background: var(--hover);
    color: var(--text);
  }

  .pick.on {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: var(--accent-soft);
    color: var(--text);
  }

  /* A finger needs the box, not the drawing: 44px is the smallest target that
     does not turn picking an icon into a game of darts. */
  @media (pointer: coarse) {
    .pick {
      min-width: 44px;
      min-height: 44px;
    }

    .grid {
      grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
      gap: 6px;
    }
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .act {
    padding: 6px 10px;
    border: 1px solid var(--edge-soft);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .act.quiet {
    color: var(--muted);
  }

  .act:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
