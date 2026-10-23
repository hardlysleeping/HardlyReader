<script lang="ts">
  /**
   * The one context menu.
   *
   * It is deliberately trigger-agnostic: the sidebar decides whether the open
   * came from a right-click, a long press or Shift+F10, and hands over a point.
   * Everything below is about behaving like a menu once it is open — clamping
   * to the viewport, taking focus, arrow keys, Escape, and closing when the page
   * moves under the anchor.
   */
  import { placeMenu, type MenuAction, type MenuModel } from "../lib/contextmenu";

  let {
    x,
    y,
    model,
    busy = false,
    onselect,
    onclose,
    onindent = () => {},
  }: {
    x: number;
    y: number;
    model: MenuModel;
    busy?: boolean;
    onselect: (action: MenuAction) => void;
    onclose: () => void;
    onindent?: (px: number) => void;
  } = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  /** Measured on mount; until then the menu sits at the anchor. */
  let measured = $state<{ x: number; y: number } | null>(null);
  const position = $derived(measured ?? { x, y });

  /** Items a keyboard can reach: everything drawn, minus the disabled ones. */
  function reachable(): HTMLButtonElement[] {
    if (menuEl === null) return [];
    return [...menuEl.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].filter(
      (item) => !item.disabled,
    );
  }

  function focusItem(index: number): void {
    const items = reachable();
    if (items.length === 0) return;
    items[(index + items.length) % items.length].focus();
  }

  function step(delta: number): void {
    const items = reachable();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    focusItem(current === -1 ? (delta > 0 ? 0 : items.length - 1) : current + delta);
  }

  $effect(() => {
    // Measured after the first paint, because the menu's size is what decides
    // whether it hangs below the anchor or flips above it.
    const element = menuEl;
    if (element === null) return;
    measured = placeMenu(
      { x, y },
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
  });

  $effect(() => {
    // The row that opened the menu should get the keyboard back when it closes;
    // for a pointer open this is the row too, so nothing surprising happens.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusItem(0);
    return () => {
      // Only take focus back if it was ours to give: closing for a click on
      // another row must not yank the keyboard off that row's new menu.
      const active = document.activeElement;
      const ours =
        active === null || active === document.body || (menuEl !== null && menuEl.contains(active));
      if (ours && previous !== null && previous.isConnected) previous.focus();
    };
  });

  $effect(() => {
    // Everything that should dismiss the menu, in one place. Capture phase, so
    // a click on another row closes this menu before that row opens its own.
    const isInside = (event: Event) =>
      menuEl !== null && event.target instanceof Node && menuEl.contains(event.target);

    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event)) onclose();
    };
    const onContextMenu = (event: MouseEvent) => {
      // Our own menu has no native menu of its own to offer.
      if (isInside(event)) {
        event.preventDefault();
        return;
      }
      onclose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onclose();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKey, true);
    // A menu anchored to a point on screen must not survive that point moving.
    window.addEventListener("scroll", onclose, true);
    window.addEventListener("resize", onclose);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onclose, true);
      window.removeEventListener("resize", onclose);
    };
  });

  function onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(-1);
        break;
      case "Tab":
        onclose();
        break;
      default:
        break;
    }
  }
</script>

<div
  class="menu"
  role="menu"
  aria-label={`Actions for ${model.label}`}
  tabindex="-1"
  bind:this={menuEl}
  style="left: {position.x}px; top: {position.y}px"
  onkeydown={onKeydown}
>
  <p class="title">{model.label}</p>

  {#if model.toggle}
    {@const toggle = model.toggle}
    <button
      class="item"
      role="menuitem"
      disabled={toggle.disabled || busy}
      onclick={() => onselect(toggle.action)}
    >{toggle.label}</button>
  {/if}

  {#if model.favorite}
    {@const favorite = model.favorite}
    <button
      class="item"
      role="menuitem"
      disabled={favorite.disabled || busy}
      onclick={() => onselect(favorite.action)}
    >
      <span class="pin-glyph" aria-hidden="true">{favorite.glyph ?? "📌"}</span>
      <span class="option">{favorite.label}</span>
    </button>
  {/if}

  {#if model.pin}
    {@const pin = model.pin}
    <button
      class="item"
      role="menuitem"
      disabled={pin.disabled || busy}
      onclick={() => onselect(pin.action)}
    >
      <span class="pin-glyph" aria-hidden="true">🔖</span>
      <span class="option">{pin.label}</span>
    </button>
  {/if}

  {#if model.indent}
    {@const indent = model.indent}
    <div class="indent" role="group" aria-label="Sidebar indent">
      <span class="indent-label">Indent</span>
      <input
        type="range"
        min={indent.min}
        max={indent.max}
        step="1"
        value={indent.px}
        aria-label="Sidebar indent in pixels"
        oninput={(event) => onindent(Number(event.currentTarget.value))}
      />
      <span class="indent-value">{indent.px}px</span>
    </div>
  {/if}

  {#if model.remove}
    {@const remove = model.remove}
    <div class="separator" role="separator"></div>
    <button
      class="item"
      class:danger={remove.action.type === "remove-feed"}
      role="menuitem"
      disabled={remove.disabled || busy}
      onclick={() => onselect(remove.action)}
    >{remove.label}</button>
  {/if}

  {#if model.confirm.length > 0}
    <div class="separator" role="separator"></div>
    <div role="group" aria-label="Confirm removal">
      {#each model.confirm as item (item.label)}
        <button
          class="item"
          class:danger={item.action.type === "remove-feed"}
          role="menuitem"
          disabled={item.disabled || busy}
          onclick={() => onselect(item.action)}
        >{item.label}</button>
      {/each}
    </div>
  {/if}

  {#if model.note}
    <p class="note">{model.note}</p>
  {/if}
</div>

<style>
  /* Indent lives in the menu because it is a sidebar setting, not a menu action:
     it applies as the slider moves and never closes the menu. */
  .indent {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--muted, #999);
  }

  .indent-label {
    flex: 0 0 auto;
  }

  .indent input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
    accent-color: var(--accent);
  }

  .indent-value {
    flex: 0 0 auto;
    min-width: 2.6em;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .menu {
    position: fixed;
    z-index: 41;
    min-width: 188px;
    max-width: 260px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
  }

  .title {
    margin: 2px 8px 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--hover);
    outline: none;
  }

  .item:disabled {
    color: var(--muted);
    cursor: default;
  }


  .danger {
    color: #d9534f;
  }

  .danger:hover:not(:disabled),
  .danger:focus-visible {
    background: rgb(217 83 79 / 14%);
  }


  .option {
    flex: 1;
  }


  .separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--border-soft);
  }

  .note {
    margin: 6px 8px 2px;
    font-size: 11px;
    line-height: 1.4;
    color: var(--muted);
  }
</style>
