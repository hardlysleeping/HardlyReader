/**
 * Throwaway harness: the posts column alone, so its header bar can be measured
 * at a phone's width and at a desktop's. Delete with phone-list-preview.html.
 *
 * `?view=regular|list|cards|grid` picks the shape; the device comes from the
 * real detection path (`detectShape()`), so this is only a phone when the
 * browser is emulating a coarse pointer on a 390px screen.
 */
import { mount } from "svelte";
import "./app.css";
import ArticleList from "./components/ArticleList.svelte";
import { layout } from "./state/layout.svelte";
import { reader } from "./state/reader.svelte";
import { reading } from "./state/reading.svelte";
import type { StreamItem } from "./api/freshrss";

(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  new Response("unauthorised", { status: 401 });

const now = Math.floor(Date.now() / 1000);
const view = new URLSearchParams(location.search).get("view") ?? "regular";

// A module that throws is otherwise a blank page; the harness reports it in the DOM.
for (const kind of ["error", "unhandledrejection"] as const) {
  addEventListener(kind, (event) => {
    const detail =
      kind === "error"
        ? `${(event as ErrorEvent).message} @ ${(event as ErrorEvent).filename}:${(event as ErrorEvent).lineno}`
        : String((event as PromiseRejectionEvent).reason);
    document.body.dataset.err = detail;
  });
}

const svg = (w: number, h: number, tone: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${tone}"/></svg>`,
  );

function post(id: string, title: string, image: string | null, feed = "Comics"): StreamItem {
  return {
    id,
    title,
    timestampUsec: String((now - Number(id) * 900) * 1_000_000),
    published: now - Number(id) * 900,
    alternate: [{ href: "https://example.com/" + id }],
    origin: { streamId: "feed/1", title: feed },
    categories: [],
    enclosure: image === null ? [] : [{ href: image, type: "image/svg+xml" }],
    summary: { content: "<p>A page of comics, and the opening words of the post.</p>" },
  } as unknown as StreamItem;
}

const tones = ["#2b3a55", "#4a2b3a", "#2b4a3a", "#4a432b", "#3a2b4a"];

reader.items = Array.from({ length: 12 }, (_, i) =>
  post(String(i + 1), `A post with a headline long enough to be cut off somewhere near the end ${i + 1}`, svg(800, i % 3 === 0 ? 1200 : 500, tones[i % tones.length])),
);
reader.selectedId = null;
reader.activeTitle = "Comics";

reading.setListView(view as never);
for (const ms of [0, 250, 800]) {
  setTimeout(() => {
    reading.setListView(view as never);
    reading.setThumbSide("right");
  }, ms);
}

/** `App` publishes this; the harness has no `App`, so it mirrors it. */
setInterval(() => {
  if (document.documentElement.dataset.device !== layout.device) {
    document.documentElement.dataset.device = layout.device;
  }
}, 100);

mount(ArticleList, { target: document.getElementById("app")! });
