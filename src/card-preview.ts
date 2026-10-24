/**
 * Throwaway harness: the Cards view in a 420px column, with a comic page and a
 * wide photograph, so the picture window can be measured instead of guessed.
 * Delete with card-preview.html and preview-*.png.
 */
import { mount } from "svelte";
import ArticleList from "./components/ArticleList.svelte";
import { reader } from "./state/reader.svelte";
import { reading } from "./state/reading.svelte";
import type { StreamItem } from "./api/freshrss";

(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  new Response("unauthorised", { status: 401 });

const now = Math.floor(Date.now() / 1000);

function post(id: string, title: string, image: string): StreamItem {
  return {
    id,
    title,
    timestampUsec: String(now * 1_000_000),
    published: now,
    alternate: [{ href: "https://example.com/" + id }],
    origin: { streamId: "feed/1", title: "Comics" },
    categories: [],
    enclosure: [{ href: image, type: "image/png" }],
    summary: { content: '<p>A page of comics, and the opening words of the post.</p>' },
  } as unknown as StreamItem;
}

reading.setListView("cards");
// prefs arrive from storage/server after mount and would overwrite this, so
// the harness re-asserts after they land.
for (const ms of [0, 250, 800]) setTimeout(() => { reading.setListView("cards"); reading.setThumbSide("right"); }, ms);
reader.items = [
  post("a", "A comic page, 800 x 1200", location.origin + "/preview-comic.png"),
  post("b", "A wide photograph, 1600 x 900", location.origin + "/preview-wide.png"),
];
reader.selectedId = null;
reader.activeTitle = "Cards preview";

mount(ArticleList, { target: document.getElementById("app")! });
