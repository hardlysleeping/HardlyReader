<script lang="ts">
  /**
   * The icon chooser, where the reader noticed the wrong icon: over the row's own
   * menu, at the point that was pressed.
   *
   * It is the same grid Settings mounts (`IconGrid`), so "Let it pick" means the
   * same thing in both places and the set has one home. The popover closes on a
   * press outside, on Escape, and on any scroll — the row it belongs to may move
   * under it, and a chooser left floating over the wrong category is a way to
   * give an icon to the wrong thing.
   */
  import IconGrid from "./IconGrid.svelte";
  import { iconPicker } from "../state/icon-picker.svelte";

  let panel = $state<HTMLElement | null>(null);

  $effect(() => {
    if (iconPicker.target === null) return;
    const el = panel;
    const away = (event: PointerEvent) => {
      if (el !== null && event.target instanceof Node && el.contains(event.target)) return;
      iconPicker.close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") iconPicker.close();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", () => iconPicker.close(), true);
    window.addEventListener("resize", () => iconPicker.close());
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  });
</script>

{#if iconPicker.target !== null}
  <div
    class="chooser"
    role="dialog"
    aria-label={`Icon for ${iconPicker.target.label}`}
    tabindex="-1"
    bind:this={panel}
    style="left: {iconPicker.point.x}px; top: {iconPicker.point.y}px"
  >
    <IconGrid label={iconPicker.target.label} onclose={() => iconPicker.close()} />
  </div>
{/if}

<style>
  /* Above the menu it replaced, on the same side of the glass: this is a
     continuation of that press, not a new surface. */
  .chooser {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(288px, calc(100vw - 16px));
    max-height: min(70vh, 460px);
    padding: 10px;
    overflow: hidden;
    border: 1px solid var(--edge);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.35);
  }
</style>
