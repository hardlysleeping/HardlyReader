/**
 * Where a dragged row lands, decided from the geometry under the pointer.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/drop-target.mjs
 *
 * The bug this suite exists for: dragging a feed *above* a folder filed it
 * *into* that folder, and the gap just over a folder's title resolved to
 * nothing at all — so a feed could only ever be dropped inside a category,
 * never next to one, and the end of a category was unreachable. The rules here
 * are the answers that were missing:
 *
 *   - a row's halves still mean before-it / after-it;
 *   - a folder title's top half means *the end of the folder above it*;
 *   - its bottom half means *this folder's first row*;
 *   - an empty area inside a folder's own block means its end;
 *   - a gap thin enough to land on the container still resolves, because the
 *     nearest title below the pointer names the boundary.
 *
 * There is no DOM here: `dropTargetAt` takes its two lookups from `hooks`, so a
 * handful of stubs can describe a whole sidebar.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dropTargetAt } from "../../src/lib/feed-drag.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

/** An element stub: attributes, a rect, its children by selector, and a parent. */
function el(attrs, rect, children = {}, parent = null) {
  const node = {
    attrs,
    rect,
    children,
    parent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    closest(selector) {
      const name = selector.slice(1, -1);
      let node = this;
      while (node !== null) {
        if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node;
        node = node.parent;
      }
      return null;
    },
    querySelector(selector) {
      return this.children[selector] ?? null;
    },
    querySelectorAll(selector) {
      return this.children[selector] ?? [];
    },
  };
  return node;
}

const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 300 });

/** A feed row: `data-drop-feed`, the folder it is filed under, the row after it. */
function feed(id, category, next, top) {
  return el(
    {
      "data-drop-feed": id,
      "data-drop-cat": category,
      "data-drop-next": next === null ? null : next,
    },
    rect(top, 24),
  );
}

/**
 * A folder's title bar, with the label of the folder before it and the id of
 * its own first row — which exists even when the folder is folded, so filing
 * into a folded folder still has a target.
 */
function header(category, prev, first, top) {
  return el(
    {
      "data-drop-head": category,
      "data-drop-cat": category,
      "data-drop-head-prev": prev === null ? null : prev,
      "data-drop-head-first": first === null ? null : first,
    },
    rect(top, 28),
  );
}

const at = (element) => ({ elementFromPoint: () => element, headers: () => [] });

// ---------------------------------------------------------------------------
// A feed row, unchanged
// ---------------------------------------------------------------------------

{
  const row = feed("f1", "News", "f2", 100);
  const upper = dropTargetAt(10, 104, undefined, at(row));
  check("a row's top half lands before that row", upper?.before === "f1", upper);
  check("and stays in that row's folder", upper?.target === "News", upper);
  const lower = dropTargetAt(10, 118, undefined, at(row));
  check("its bottom half lands after it", lower?.before === "f2", lower);
}
{
  const last = feed("f9", "News", null, 100);
  check(
    "the last row's bottom half is the end of the folder",
    dropTargetAt(10, 118, undefined, at(last))?.before === null,
  );
}

// ---------------------------------------------------------------------------
// A folder title: above is the folder before it, below is its own top
// ---------------------------------------------------------------------------

{
  const title = header("Tech", "News", "t1", 200);
  const upper = dropTargetAt(10, 204, undefined, at(title));
  check("a title's top half means the end of the folder above it", upper?.target === "News", upper);
  check("which is an end, not a before-row", upper?.before === null, upper);
  const lower = dropTargetAt(10, 216, undefined, at(title));
  check("its bottom half means the top of this folder", lower?.target === "Tech", lower);
  check("before this folder's first row", lower?.before === "t1", lower);
}
{
  const firstTitle = header("News", null, "n1", 100);
  check(
    "the first folder has nothing above it, so its top half is its own top",
    dropTargetAt(10, 104, undefined, at(firstTitle))?.target === "News",
  );
  const emptyPrev = header("News", "", "n1", 100);
  check(
    "an empty previous label is the same as none",
    dropTargetAt(10, 104, undefined, at(emptyPrev))?.target === "News",
  );
}

// ---------------------------------------------------------------------------
// A folder's own block: its gaps
// ---------------------------------------------------------------------------

{
  const title = header("Tech", "News", "t1", 200);
  const rows = [feed("t1", "Tech", "t2", 230), feed("t2", "Tech", null, 256)];
  const block = el({ "data-drop-section": "Tech" }, rect(200, 84), {
    "[data-drop-head]": title,
    "[data-drop-feed]": rows,
  });
  const aboveTitle = dropTargetAt(10, 198, undefined, at(block));
  check("the block's space above its title belongs to the folder above", aboveTitle?.target === "News", aboveTitle);
  const belowLast = dropTargetAt(10, 290, undefined, at(block));
  check("its space below the last row is its own end", belowLast?.target === "Tech", belowLast);
  check("with nothing after it", belowLast?.before === null, belowLast);
}
{
  // A folded folder draws no rows: its whole block below the title is its end,
  // so a feed can still be filed into it while it is shut.
  const title = header("Tech", "News", "t1", 200);
  const folded = el({ "data-drop-section": "Tech" }, rect(200, 28), {
    "[data-drop-head]": title,
    "[data-drop-feed]": [],
  });
  const inside = dropTargetAt(10, 224, undefined, at(folded));
  check("a folded folder still takes a feed at its end", inside?.target === "Tech", inside);
  check("named by the row id it keeps even while folded", inside?.before === "t1", inside);
}

// ---------------------------------------------------------------------------
// The thin gap that lands on the container
// ---------------------------------------------------------------------------

{
  const title = header("Tech", "News", "t1", 200);
  const container = el({}, rect(0, 600));
  const result = dropTargetAt(10, 190, undefined, {
    elementFromPoint: () => container,
    headers: () => [header("News", null, "n1", 100), title],
  });
  check("a gap just over a title still resolves", result !== null, result);
  check("to the end of the folder above it", result?.target === "News", result);
}
{
  const title = header("Tech", "News", "t1", 200);
  const container = el({}, rect(0, 600));
  const far = dropTargetAt(10, 160, undefined, {
    elementFromPoint: () => container,
    headers: () => [title],
  });
  check("a gap far from any title is not a drop", far === null, far);
}

// ---------------------------------------------------------------------------
// Nothing droppable, and the category list's own rules untouched
// ---------------------------------------------------------------------------

check("nothing under the pointer is no drop", dropTargetAt(0, 0, undefined, at(null)) === null);

{
  const options = {
    rowAttr: "data-drop-cat-row",
    targetAttr: "data-drop-cat-row",
    nextAttr: "data-drop-cat-next",
    sectionAttr: "data-cat-section",
    sectionNextAttr: "data-cat-next",
    listName: "categories",
  };
  const title = el(
    { "data-drop-cat-row": "c1", "data-drop-cat-next": "c2" },
    rect(100, 28),
  );
  const section = el({ "data-cat-section": "c1", "data-cat-next": "c2" }, rect(100, 200));
  title.parent = section;
  const upper = dropTargetAt(10, 104, options, at(title));
  check("a category's top half is still before it", upper?.before === "c1", upper);
  // Categories are one flat list, so the drop target is not consulted: the
  // arrangement only reads `before`. That is unchanged here.
  check("and the category drag never consults a list name", upper?.target === "c1", upper);
  const lower = dropTargetAt(10, 290, options, at(section));
  check("and its block's lower half is the next category", lower?.before === "c2", lower);
}

// ---------------------------------------------------------------------------
// How it feels, which is also code: the row is carried, not re-laid out
// ---------------------------------------------------------------------------

const drag = read("src/lib/feed-drag.ts");
const css = read("src/app.css");

check(
  "the ghost is carried with a transform, never repositioned with `top`",
  /ghost\.style\.transform = `translate3d\(\$\{x - grabX\}px, \$\{y - grabY\}px, 0\) scale/.test(drag) &&
    !/ghost\.style\.top =/.test(drag),
);
check(
  "pointer events are coalesced into one frame, so a 125Hz mouse is not 125 layouts",
  /requestAnimationFrame\(flush\)/.test(drag) && /cancelAnimationFrame\(frame\)/.test(drag),
);
check(
  "the ghost moves on the event, and only the hit test waits for a frame",
  /placeGhost\(event\.clientX, event\.clientY\);\s*pending = \{/.test(drag) &&
    !/placeGhost\(at\.x, at\.y\)/.test(drag),
);
check(
  "nothing in the move path reads a layout value it then writes against",
  !/offsetHeight/.test(drag),
);
check(
  "the lifted row stays in the list and is dimmed, so the rows below do not shift",
  /setAttribute\("data-lifted", ""\)/.test(drag) && /removeAttribute\("data-lifted"\)/.test(drag) &&
    /html\.feed-dragging \.feed\[data-lifted\]/.test(css),
);
check(
  "the ghost lifts (deeper shadow) and is put down (fades) rather than blinking out",
  /\.feed-ghost\.lifted/.test(css) && /\.feed-ghost\.dropping/.test(css) &&
    /classList\.add\("dropping"\)/.test(drag),
);
check(
  "the ghost does not transition its transform, which would trail the pointer",
  !/\.feed-ghost[\s\S]{0,400}transition:[^;]*transform/.test(css),
);


// A folder drag picks the folder up. The title is the handle; what moves is the
// block — the title and the feeds inside it — and the list it came from dims
// whole, so the gesture reads as carrying something rather than renaming it.
check(
  "a folder is carried as the whole folder",
  /blockAttr\?: string;/.test(drag) &&
    /row\.closest<HTMLElement>\(`\[\$\{options\.blockAttr\}\]`\)/.test(drag) &&
    /const source = block \?\? row;/.test(drag) &&
    /if \(block\) clone\.classList\.add\("block"\);/.test(drag),
);
check(
  "and a tall one is clipped, so it cannot hide the list it is carried over",
  /function blockHeight\(height: number\): number \{[\s\S]{0,220}Math\.min\(height, cap\)/.test(drag) &&
    /block === null \? rect\.height : blockHeight\(rect\.height\)/.test(drag),
);
check(
  "the block it came from dims, and the ghost is a block rather than a row",
  /html\.feed-dragging \[data-drag-block\]\[data-lifted\]/.test(css) &&
    /\.feed-ghost\.block \{[\s\S]{0,220}display: block;/.test(css),
);
check(
  "the sidebar marks the block a category drag lifts",
  /data-drag-block/.test(read("src/components/Sidebar.svelte")) &&
    /blockAttr: "data-drag-block"/.test(read("src/components/Sidebar.svelte")),
);

console.log(`${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exitCode = 1;
