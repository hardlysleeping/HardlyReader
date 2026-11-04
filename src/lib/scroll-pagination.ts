/** Passive pagination: input grants permission; only a downward scroll spends it.
 * No observer/effect/timer can fetch a page. A failed/non-growing page stays latched
 * until the manual fallback changes the page or the reader changes context.
 */
export interface ScrollPageState {
  context: string;
  count: number;
  hasMore: boolean;
  loading: boolean;
  blocked: boolean;
}

export function scrollPagination(
  node: HTMLElement,
  options: {
    port: HTMLElement;
    state: () => ScrollPageState;
    load: () => Promise<void>;
  },
) {
  const { port } = options;
  let top = port.scrollTop;
  let armed = false;
  let pending = false;
  let attempted = "";
  let context = options.state().context;
  let pointer: { id: number; y: number } | null = null;
  let destroyed = false;
  const intent = (down: boolean) => { armed = down && !pending; };
  const wheel = (event: WheelEvent) => intent(event.deltaY > 0);
  const down = (event: PointerEvent) => {
    pointer = { id: event.pointerId, y: event.clientY };
    armed = false;
  };
  const move = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    intent(event.clientY < pointer.y);
    pointer.y = event.clientY;
  };
  const up = () => { pointer = null; };
  const key = (event: KeyboardEvent) => {
    if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) intent(!event.shiftKey);
    else armed = false;
  };
  const scroll = () => {
    const previous = top;
    top = port.scrollTop;
    const state = options.state();
    if (state.context !== context) {
      context = state.context;
      attempted = "";
      armed = false;
      return;
    }
    if (top <= previous || top <= 0 || !armed || pending) return;
    if (state.loading || state.blocked || !state.hasMore) {
      armed = false;
      return;
    }
    // Nested lists travel in the sidebar's port: measure the list's end, not
    // the sidebar footer. Standalone lists use their own scroll geometry.
    const remaining = port === node
      ? port.scrollHeight - top - port.clientHeight
      : node.getBoundingClientRect().bottom - port.getBoundingClientRect().bottom;
    if (remaining > port.clientHeight * 0.5 || port.clientHeight <= 0) return;
    const page = `${context}\n${state.count}`;
    if (attempted === page) return;
    attempted = page;
    armed = false;
    pending = true;
    // ReaderState owns errors and cursors; guard a rejecting caller too. Never
    // retry from completion, even if the new page still leaves the end visible.
    void Promise.resolve().then(() => { if (!destroyed) return options.load(); })
      .catch(() => {})
      .finally(() => { pending = false; armed = false; });
  };
  node.addEventListener("wheel", wheel, { passive: true, capture: true });
  node.addEventListener("pointerdown", down, { passive: true });
  node.addEventListener("keydown", key);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  port.addEventListener("scroll", scroll, { passive: true });
  return {
    destroy() {
      destroyed = true;
      node.removeEventListener("wheel", wheel, true);
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("keydown", key);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      port.removeEventListener("scroll", scroll);
    },
  };
}
