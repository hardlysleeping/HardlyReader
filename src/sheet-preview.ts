/**
 * Throwaway harness: the reading controls alone, so the sheet can be dragged
 * with real pointer events at a phone's width. Delete with sheet-preview.html.
 *
 * The device comes from the real detection path (`detectShape()` through
 * `layout`), so this is a phone only when the browser is emulating a coarse
 * pointer on a short screen — the same condition the app uses.
 */
import { mount } from "svelte";
import "./app.css";
import ReadingControls from "./components/ReadingControls.svelte";
import { layout } from "./state/layout.svelte";

(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  new Response("unauthorised", { status: 401 });

for (const kind of ["error", "unhandledrejection"] as const) {
  addEventListener(kind, (event) => {
    const detail =
      kind === "error"
        ? `${(event as ErrorEvent).message} @ ${(event as ErrorEvent).filename}:${(event as ErrorEvent).lineno}`
        : String((event as PromiseRejectionEvent).reason);
    document.body.dataset.err = detail;
  });
}

// The bar the controls live in, so the popover's containing block is real.
const bar = document.createElement("div");
bar.style.cssText =
  "position:fixed;top:0;left:0;right:0;height:46px;display:flex;align-items:center;justify-content:flex-end;padding:0 8px;background:var(--surface)";
document.getElementById("app")?.appendChild(bar);

mount(ReadingControls, { target: bar });
document.body.dataset.device = layout.device;
