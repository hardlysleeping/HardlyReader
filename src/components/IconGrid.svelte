<script lang="ts">
  /**
   * The glyph grid, once.
   *
   * Two surfaces want to choose a category's icon — Settings (where the whole
   * list is) and the category row's own menu (where a reader notices the wrong
   * picture and reaches for it). Two grids would be two opinions about the set,
   * the filter and what "Let it pick" means, so the grid lives here and both
   * mount it: the panel inline, the menu in a popover.
   *
   * It writes the choice itself and then closes: a picker that returned a value
   * for someone else to store would still be right, but it would also mean every
   * caller could store it differently.
   */
  import Glyph from "./Glyph.svelte";
  import { icons } from "../state/icons.svelte";
  import { guessIcon } from "../lib/category-icon";
  import { iconKeywords, iconNames } from "../lib/icons";

  interface Props {
    /** The category label the choice lands on. */
    label: string;
    /** Called after a choice, a reset or "No icon" — the surface closes itself. */
    onclose: () => void;
    /** Shows a back link to a list, for the panel; the popover has no list. */
    back?: boolean;
    onback?: () => void;
  }

  let { label, onclose, back = false, onback }: Props = $props();

  let query = $state("");

  const matches = $derived.by(() => {
    const wanted = query.trim().toLowerCase();
    const names = iconNames();
    if (wanted === "") return names;
    return names.filter(
      (name) => name.includes(wanted) || iconKeywords(name).some((word) => word.includes(wanted)),
    );
  });

  const guess = $derived(guessIcon(label));
  const chosen = $derived(icons.map[label]);

  function pick(name: string): void {
    icons.setIcon(label, name);
    onclose();
  }

  function clear(): void {
    icons.setIcon(label, null);
    onclose();
  }

  function letItPick(): void {
    icons.resetIcon(label);
    onclose();
  }
</script>

{#if back}
  <button class="back" onclick={() => onback?.()}>← Icons</button>
{/if}
<p class="target">{label}</p>

<input class="filter" type="search" placeholder="Filter — cpu, music, camera…" bind:value={query} />

<div class="grid" role="listbox" aria-label="Icons">
  {#each matches as name (name)}
    <button
      class="pick"
      class:on={chosen === name}
      role="option"
      aria-selected={chosen === name}
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
  <button class="act" onclick={letItPick} disabled={guess === null && chosen === undefined}>
    {guess === null ? "Let it pick" : `Let it pick (${guess})`}
  </button>
  <button class="act quiet" onclick={clear}>No icon</button>
</div>

<style>
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

  .hint {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
</style>
