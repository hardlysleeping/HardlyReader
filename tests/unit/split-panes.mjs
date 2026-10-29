/**
 * The split family's arithmetic: where a pane goes, where focus lands, and what
 * a restart is handed.
 *
 * Pure model, no reader and no DOM: what a pane is holding is the reader's
 * business, and the arrangement is this file's.
 */
import {
  SPLIT_GUTTER,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_MIN_PANE,
  canClose,
  canSplit,
  indexOf,
  insertAfter,
  newPane,
  paneLabel,
  paneWidth,
  parseSave,
  readSave,
  removePane,
  saveShape,
  splitTracks,
  squeezed,
  visibleCount,
} from "../../src/lib/split.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function four() {
  return [
    newPane("a", "feed/one", "One"),
    newPane("b", "feed/two", "Two"),
    newPane("c", "feed/three", "Three"),
    newPane("d", "feed/four", "Four"),
  ];
}

// The family's own numbers.
check("four is the ceiling and two is the floor", SPLIT_MAX === 4 && SPLIT_MIN === 2);
check("the seam is the app's 6px gutter", SPLIT_GUTTER === 6);
check("a pane is never drawn narrower than the three-pane list", SPLIT_MIN_PANE === 260);

// Adding a pane.
check("splitting is offered below four", canSplit(2) && canSplit(3) && !canSplit(4));

{
  const panes = four().slice(0, 2);
  const added = insertAfter(panes, "a", newPane("x", "feed/new", "New"));
  check("a split goes in to the RIGHT of the focused pane", added.map((p) => p.id).join(",") === "a,x,b");
  check("and the panes it passes keep their streams", added[0].streamId === "feed/one" && added[2].streamId === "feed/two");
  check("splitting the last pane appends", insertAfter(panes, "b", newPane("y", "s", "S")).map((p) => p.id).join(",") === "a,b,y");
  check("an unknown focus appends rather than failing", insertAfter(panes, "nope", newPane("z", "s", "S")).map((p) => p.id).join(",") === "a,b,z");
  check("a full row cannot be split again", insertAfter(four(), "a", newPane("e", "s", "S")).length === SPLIT_MAX);
  check("and the refusal hands back the same row, not a truncated one", insertAfter(four(), "a", newPane("e", "s", "S")).map((p) => p.id).join(",") === "a,b,c,d");
  check("the list passed in is not mutated", panes.length === 2 && panes[0].id === "a");
}

// Closing a pane.
check("a two-pane row cannot close, and three can", !canClose(2) && canClose(3));

{
  const panes = four();
  const closed = removePane(panes, "b", "b");
  check("focus falls to the right-hand neighbour", closed.focusedId === "c");
  check("and only that pane is gone", closed.panes.map((p) => p.id).join(",") === "a,c,d");
  const last = removePane(panes, "d", "d");
  check("the last pane hands focus to its left", last.focusedId === "c");
  const elsewhere = removePane(panes, "b", "d");
  check("closing a pane you are not in leaves the focus alone", elsewhere.focusedId === "d");
  const stray = removePane(four(), "a", "gone");
  check("a focus that named nothing in the row lands on a real pane", stray.focusedId === "b");
  const refused = removePane([panes[0], panes[1]], "a", "a");
  check("the floor is two panes", refused.panes.length === 2 && refused.focusedId === "a");
  check("closing an id that is not there changes nothing", removePane(panes, "zz", "c").panes.length === 4);
}

// Drawn panes, and the frame that has to hold them.
{
  const need = SPLIT_MIN_PANE * 4 + SPLIT_GUTTER * 3;
  check("four panes fit a frame that holds four", visibleCount(4, need) === 4);
  check("one pixel short of that draws three", visibleCount(4, need - 1) === 3);
  check("three panes need three shares and two seams", visibleCount(3, SPLIT_MIN_PANE * 3 + SPLIT_GUTTER * 2) === 3);
  check("a narrow frame still draws one pane", visibleCount(4, 300) === 1 && visibleCount(2, 120) === 1);
  check("the count never exceeds what there is", visibleCount(2, 4000) === 2);
  check("and an empty row draws nothing", visibleCount(0, 4000) === 0);
  check("the split is squeezed only when a pane is not drawn", squeezed(4, 700) && !squeezed(4, 1200));
  check("tracks are one per pane with a seam between", splitTracks(2) === "1fr 6px 1fr");
  check("four tracks carry three seams", splitTracks(4) === "1fr 6px 1fr 6px 1fr 6px 1fr");
  check("a single drawn pane fills the frame", splitTracks(1) === "1fr" && splitTracks(0) === "1fr");
  check("every drawn pane gets the same width", paneWidth(1000, 4) === Math.floor((1000 - 18) / 4));
  check("and the seams come out of the room first", paneWidth(818, 2) === 406);
  check("a frame narrower than its seams is zero, not negative", paneWidth(3, 4) === 0);
}

// The label a control says out loud.
{
  const panes = [newPane("a", "s", "  "), newPane("b", "s", "Feed two")];
  check("an untitled pane is named by its place", paneLabel(panes, 0) === "Pane 1");
  check("a titled one by its stream", paneLabel(panes, 1) === "Feed two");
}

// What a restart is handed.
{
  const panes = four();
  panes[1].selectedId = "post-2";
  panes[1].listScroll = 240;
  panes[1].articleScroll = 96;
  const shape = saveShape(true, panes, "b");
  check("the save is versioned and carries the focus", shape.v === 1 && shape.active === true && shape.focusedId === "b");
  check("every pane travels with its stream, post and scroll", shape.panes[1].streamId === "feed/two" && shape.panes[1].selectedId === "post-2" && shape.panes[1].listScroll === 240 && shape.panes[1].articleScroll === 96);
  const back = parseSave(JSON.parse(JSON.stringify(shape)));
  check("and comes back whole", back !== null && back.panes.length === 4 && back.focusedId === "b" && back.panes[3].streamTitle === "Four");
  check("the copy is not the same object", back.panes[0] !== panes[0]);
}

// Tolerance: a stored blob is a hint, and a broken one is not a crash.
{
  check("no blob is no arrangement", parseSave(null) === null && parseSave(undefined) === null && parseSave("x") === null);
  check("another shape's version is not read as this one", parseSave({ v: 2, panes: [] }) === null);
  check("an empty list is nothing to restore", parseSave({ v: 1, active: true, panes: [] }) === null);
  check("bad JSON falls back to nothing", readSave("{not json") === null && readSave(null) === null && readSave("") === null);
  const tolerant = parseSave({
    v: 1,
    active: true,
    panes: [
      { id: "a", streamId: "feed/one", streamTitle: "One", listScroll: -4, articleScroll: "x" },
      { id: "a", streamId: "feed/two" },
      { streamId: "" },
      "nope",
      { id: "c", streamId: "feed/three", selectedId: "" },
    ],
    focusedId: "ghost",
  });
  check("entries that are not panes are dropped", tolerant !== null && tolerant.panes.length === 3);
  check("a repeated id is renamed, not trusted", tolerant.panes[1].id !== "a");
  check("bad numbers come back as zero", tolerant.panes[0].listScroll === 0 && tolerant.panes[0].articleScroll === 0);
  check("an empty selection is no selection", tolerant.panes[2].selectedId === null);
  check("a focus naming no pane falls to the first", tolerant.focusedId === "a");
  check("active is only true when it says so", parseSave({ v: 1, panes: [{ streamId: "s" }] }).active === false);
  const capped = parseSave({ v: 1, active: true, panes: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `p${n}`, streamId: `feed/${n}` })) });
  check("more panes than the family draws are capped", capped.panes.length === SPLIT_MAX);
  check("the first ones survive the cap", capped.panes.map((p) => p.id).join(",") === "p1,p2,p3,p4");
  const missing = parseSave({ v: 1, active: true, panes: [{ id: "a", streamId: "s" }] });
  check("a missing focus falls to the only pane", missing.focusedId === "a");
}

check("indexOf answers -1 for nothing", indexOf(four(), null) === -1 && indexOf(four(), "c") === 2);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
