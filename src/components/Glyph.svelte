<script lang="ts">
  /**
   * One glyph, drawn by the app rather than by the picture.
   *
   * Lucide's output is geometry with its own stroke; the generated set keeps
   * only the geometry (`scripts/gen-icons.mjs` strips `stroke`, `fill`,
   * `stroke-width` and the rest) so the weight and the size are decided here,
   * once. That is what makes a row of six different icons look like one set —
   * and it is why the paths are not vendored as complete `<svg>` strings.
   *
   * `stroke-width` is 1.7 rather than Lucide's 2: at 16px on a phone the 2px
   * weight closes up the small counters (the `user` glyph's head disappears into
   * the shoulders). 1.7 is the weight the app's own carets are drawn at.
   */
  import { iconMarkup } from "../lib/icons";

  interface Props {
    name: string | null | undefined;
    /** Edge length in px. */
    size?: number;
    /** Anything the caller needs to line it up; the colour is `currentColor`. */
    class?: string;
  }

  let { name, size = 16, class: extra = "" }: Props = $props();

  const markup = $derived(iconMarkup(name));
</script>

{#if markup !== null}
  <svg
    class="glyph {extra}"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- Geometry from the generated set: our own file, never user input. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html markup}
  </svg>
{/if}

<style>
  .glyph {
    display: inline-block;
    flex: none;
    vertical-align: middle;
    overflow: visible;
  }
</style>
