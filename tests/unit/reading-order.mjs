import { flatten, step, landingItem } from "../../src/lib/reading-order.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const order = [
  { id: "rl", title: "Reading list", items: [{ id: "a" }, { id: "b" }] },
  { id: "feed/1", title: "Blog", items: [{ id: "c" }, { id: "d" }] },
  { id: "feed/2", title: "Empty", items: [] },
  { id: "feed/3", title: "Comics", items: [{ id: "e" }] },
];

const flat = flatten(order);
check("flatten keeps stream order", flat.map((e) => e.itemId).join(",") === "a,b,c,d,e", flat.map((e) => e.itemId).join(","));
check("flatten indexes continuously", flat.map((e) => e.index).join(",") === "0,1,2,3,4");
check("flatten carries the stream title", flat[2].streamTitle === "Blog");

const next = (from, dir = 1) => step(order, from, dir);

check("inside a stream is the neighbouring item", JSON.stringify(next({ streamId: "rl", itemId: "a" })) ===
  JSON.stringify({ kind: "item", streamId: "rl", streamTitle: "Reading list", itemId: "b" }));
check("backwards inside a stream", next({ streamId: "feed/1", itemId: "d" }, -1).itemId === "c");
check("end of stream asks for the next stream", JSON.stringify(next({ streamId: "rl", itemId: "b" })) ===
  JSON.stringify({ kind: "stream", streamId: "feed/1", streamTitle: "Blog", direction: 1 }));
check("start of stream asks for the previous stream", next({ streamId: "feed/1", itemId: "c" }, -1).kind === "stream");
check("end of the whole order is the end", next({ streamId: "feed/3", itemId: "e" }).kind === "end");
check("start of the whole order is the end", next({ streamId: "rl", itemId: "a" }, -1).kind === "end");
check("with nothing open, forward starts at the first item", next(null).itemId === "a");
check("with nothing open, backward starts at the last item", next(null, -1).itemId === "e");
check(
  "a stream that no longer exists falls back to the first item",
  next({ streamId: "feed/gone", itemId: "x" }).itemId === "a",
);
check(
  "an item that no longer exists moves to the stream's neighbour",
  next({ streamId: "feed/1", itemId: "gone" }).kind === "stream",
);
check("an empty order has no step", step([], null, 1).kind === "end");
check("empty streams are skipped", step([{ id: "x", title: "X", items: [] }, order[1]], null, 1).streamId === "feed/1");

check("landing forward is the first item", landingItem(order[1], 1) === "c");
check("landing backward is the last item", landingItem(order[1], -1) === "d");
check("landing in an empty stream is nothing", landingItem({ id: "z", title: "Z", items: [] }, 1) === null);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
