/**
 * The pan's two hands: what a finger is allowed to drag, and what it is not.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/drag-scroll-touch.mjs
 *
 * `lib/drag-scroll.ts` is an installer rather than a pure function, so the rules
 * it enforces are only visible by pressing and moving. There is no DOM in Node
 * and no jsdom in this tree, so this suite builds the smallest page the module
 * can be run against — elements with a `closest`, one scrollable box, one window
 * with listeners — and drives the real module through `installDragScroll`.
 * Nothing here is a description of the source: every check is a scroll position,
 * a click counter or a class on the document element, read after the gesture.
 *
 * What it pins:
 *
 * - a finger that starts on a button inside `[data-no-drag-scroll]` pans the
 *   list, and the click it ends on is swallowed;
 * - the mouse on the same element is refused, exactly as before;
 * - a shaky tap (a few px) is still a tap on both;
 * - a finger that starts on a plain row pans;
 * - the wider control threshold is per press, not global;
 * - a finger is still refused by a text field, a range and the pane gutter;
 * - the pan marks the document, so the pressed look can go with the gesture;
 * - `feed-drag` refuses a finger outright, so panning from a feed row cannot
 *   start a reorder.
 *
 * What it cannot pin: how a particular iOS or Android build decides when a
 * touch becomes a click, or whether `preventDefault` on a synthetic pointermove
 * has the same effect it has on a real one. Those are device questions — see
 * the note at the end of this file.
 */
let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// A page, small enough to run the module against.
// ---------------------------------------------------------------------------

/** The five selector shapes the module's lists use, and nothing else. */
const SIMPLE =
  /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[^\]="']*(?:=(?:'[^']*'|"[^"]*"))?\])*)$/;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  add(...names) {
    for (const name of names) this.names.add(name);
  }
  remove(...names) {
    for (const name of names) this.names.delete(name);
  }
  contains(name) {
    return this.names.has(name);
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.parentElement = null;
    this.children = [];
    /** The element's own click handler, as a real target would have one. */
    this.onclick = null;
    /** How many times that handler actually ran. */
    this.clicks = 0;
    /** Not scrollable unless a subclass says so: `scrollableFrom` reads these. */
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.overflowY = "visible";
    this.overflowX = "visible";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }

  matches(selector) {
    return selector.split(",").some((part) => matchesOne(this, part.trim()));
  }

  closest(selector) {
    let node = this;
    while (node !== null) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

/**
 * One simple selector against one element.
 *
 * Deliberately throws on anything it does not understand: if the module grows a
 * selector this stub cannot read, that is a check that has stopped meaning
 * anything, and it should say so rather than quietly match nothing.
 */
function matchesOne(element, part) {
  const shape = SIMPLE.exec(part);
  if (!shape) {
    throw new Error(`the stub cannot read the selector ${JSON.stringify(part)} — teach it first`);
  }
  const [, tag, rest] = shape;
  if (tag !== undefined && element.tagName !== tag.toUpperCase()) return false;
  for (const token of rest.match(/\[[^\]]*\]|\.[\w-]+/g) ?? []) {
    if (token.startsWith(".")) {
      if (!element.classList.contains(token.slice(1))) return false;
      continue;
    }
    const attribute = /^\[\s*([\w-]+)\s*(?:=\s*(?:'([^']*)'|"([^"]*)"))?\s*\]$/.exec(token);
    if (!attribute) {
      throw new Error(`the stub cannot read the attribute ${JSON.stringify(token)} — teach it first`);
    }
    const [, name, single, double] = attribute;
    if (!element.hasAttribute(name)) return false;
    const wanted = single ?? double;
    if (wanted !== undefined && element.getAttribute(name) !== wanted) return false;
  }
  return true;
}

/** A box with something to scroll, which is the ancestor the module looks for. */
class Scroller extends FakeElement {
  constructor(tag = "div", { height = 400, content = 2000, top = 600 } = {}) {
    super(tag);
    this.overflowY = "auto";
    this.clientHeight = height;
    this.scrollHeight = content;
    this.clientWidth = 320;
    this.scrollWidth = 320;
    this.top = top;
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value) {
    this.top = clamp(value, 0, this.scrollHeight - this.clientHeight);
  }
}

// The window: everything the module registers, and the dispatch order that makes
// a capture listener able to take a click away from the element underneath.
const registrations = new Map();
const fakeWindow = {
  addEventListener(type, fn, options) {
    const list = registrations.get(type) ?? [];
    list.push({ fn, capture: options === true || options?.capture === true });
    registrations.set(type, list);
  },
  removeEventListener(type, fn) {
    const list = registrations.get(type) ?? [];
    registrations.set(
      type,
      list.filter((entry) => entry.fn !== fn),
    );
  },
  count(type) {
    return (registrations.get(type) ?? []).length;
  },
};

/** Frames the module queued, so the deferred work can be run on purpose. */
let rafSeq = 0;
const frames = new Map();
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn(performance.now());
  return pending.length;
}

globalThis.window = fakeWindow;
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.getComputedStyle = (element) => ({
  overflowY: element.overflowY,
  overflowX: element.overflowX,
});
globalThis.requestAnimationFrame = (fn) => {
  rafSeq += 1;
  frames.set(rafSeq, fn);
  return rafSeq;
};
globalThis.cancelAnimationFrame = (id) => {
  frames.delete(id);
};

const { installDragScroll } = await import("../../src/lib/drag-scroll.ts");
const { createFeedDrag } = await import("../../src/lib/feed-drag.ts");

// ---------------------------------------------------------------------------
// The gesture, as the browser would deliver it.
// ---------------------------------------------------------------------------

/**
 * One pointer event through the listeners the module registered on the window.
 *
 * Pointer events bubble, so the window sees them whatever they were dispatched
 * on — which is exactly the assumption the module is built on. A click is
 * different: the module listens for it in the capture phase, so it runs before
 * the element's own handler and can stop it there. That order is the whole
 * point of check "the click it ends on is not the star's", so it is modelled.
 */
function send(type, target, props = {}) {
  const event = {
    type,
    target,
    currentTarget: fakeWindow,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerType: "touch",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...props,
  };
  const registered = registrations.get(type) ?? [];
  const capture = registered.filter((entry) => entry.capture);
  const bubble = registered.filter((entry) => !entry.capture);
  for (const entry of capture) {
    entry.fn(event);
    if (event.propagationStopped) return event;
  }
  if (type === "click" && typeof target.onclick === "function") {
    target.onclick();
    target.clicks += 1;
  }
  for (const entry of bubble) {
    entry.fn(event);
    if (event.propagationStopped) return event;
  }
  return event;
}

/** A clock of our own, so a release is a placement and never a throw. */
let clock = 10_000;
const tick = (step = 200) => (clock += step);

/**
 * Down, travel, up — the shape of every gesture below.
 *
 * The moves are slow on purpose: the release speed is read from the last 90ms of
 * the gesture, and nothing in this suite is about the throw (`fling.mjs` is).
 */
function drag(target, { pointerType = "touch", pixels = 30, x = 120, y = 300 } = {}) {
  send("pointerdown", target, { pointerType, clientX: x, clientY: y, timeStamp: tick() });
  if (pixels > 0) {
    const half = Math.round(pixels / 2);
    send("pointermove", target, { pointerType, clientX: x, clientY: y - half, timeStamp: tick() });
    send("pointermove", target, { pointerType, clientX: x, clientY: y - pixels, timeStamp: tick() });
  }
  const up = send("pointerup", target, { pointerType, clientX: x, clientY: y - pixels, timeStamp: tick() });
  return up;
}

/**
 * A fresh page per check.
 *
 * The fixtures mirror the two dead zones: the row action strip the list marks
 * `data-no-drag-scroll`, and a sidebar feed row, which is a button inside the
 * same opt-out. The rest is what a finger must still be refused by.
 */
function page() {
  const documentElement = new FakeElement("html");
  const document = { documentElement };
  globalThis.document = document;

  const scroller = new Scroller("div");
  scroller.classList.add("items");
  documentElement.append(scroller);

  /** A feed row: a button, marked as an opt-out, with text inside it. */
  const feedRow = new FakeElement("button");
  feedRow.classList.add("row", "feed");
  feedRow.setAttribute("data-no-drag-scroll", "");
  const feedText = new FakeElement("span");
  feedRow.append(feedText);

  /** The article list's action strip, and the star inside it. */
  const acts = new FakeElement("div");
  acts.classList.add("acts");
  acts.setAttribute("data-no-drag-scroll", "");
  const star = new FakeElement("button");
  star.classList.add("act", "star");
  const mark = new FakeElement("button");
  mark.classList.add("act", "mark");
  acts.append(star, mark);

  /** A plain row: no opt-out, still a button, which is what a row is. */
  const row = new FakeElement("button");
  row.classList.add("row");
  const rowText = new FakeElement("span");
  row.append(rowText);

  /** The row's own padding, which is not a control at all. */
  const gap = new FakeElement("div");
  gap.classList.add("gap");

  const range = new FakeElement("input");
  range.setAttribute("type", "range");
  const field = new FakeElement("input");
  field.setAttribute("type", "search");
  const gutter = new FakeElement("div");
  gutter.classList.add("gutter");
  const note = new FakeElement("div");
  note.setAttribute("contenteditable", "true");

  scroller.append(feedRow, acts, row, gap, range, field, gutter, note);

  for (const element of [feedRow, star, mark, row, range, field]) {
    element.onclick = () => {};
  }

  const dispose = installDragScroll();
  return {
    documentElement,
    scroller,
    feedRow,
    feedText,
    acts,
    star,
    mark,
    row,
    rowText,
    gap,
    range,
    field,
    gutter,
    note,
    dispose,
  };
}

const top = (scroller) => scroller.scrollTop;
const panning = (documentElement) => documentElement.classList.contains("drag-panning");

// ---------------------------------------------------------------------------
// The dead zone the list has: a finger on the action strip.
// ---------------------------------------------------------------------------
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.star, { pointerType: "touch", pixels: 30 });
  check(
    "a finger that starts on the star pans the list",
    top(ui.scroller) === before + 30,
    `${before} → ${top(ui.scroller)}`,
  );
  const click = send("click", ui.star);
  check("and the click it ends on never reaches the star", ui.star.clicks === 0, `clicks ${ui.star.clicks}`);
  check("...because it was swallowed where it was caught", click.defaultPrevented === true);
  check("no throw follows a slow drag", (flushFrames(), top(ui.scroller) === before + 30), String(top(ui.scroller)));
  // The swallow is a grace, not a disarmed button: a moment later the star works
  // again. Without this, one scroll with a finger on the strip would make the
  // row's toggles look broken for as long as the list stayed open.
  await new Promise((resolve) => setTimeout(resolve, 280));
  const later = send("click", ui.star);
  check("and a tap after the grace still stars", ui.star.clicks === 1 && !later.defaultPrevented);
  ui.dispose();
}

// ---------------------------------------------------------------------------
// The mouse is not to change: the opt-out is still the mouse's.
// ---------------------------------------------------------------------------
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.star, { pointerType: "mouse", pixels: 30 });
  check("a mouse on the star does not pan", top(ui.scroller) === before, `${before} → ${top(ui.scroller)}`);
  const click = send("click", ui.star);
  check("and its click is still a click", ui.star.clicks === 1 && !click.defaultPrevented);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.acts, { pointerType: "mouse", pixels: 30 });
  check("the strip itself refuses the mouse too, not just its buttons", top(ui.scroller) === before);
  ui.dispose();
}
{
  // The mouse path on a row is unchanged: it pans there, as it always has.
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.rowText, { pointerType: "mouse", pixels: 30 });
  check("the mouse still pans from a row's body", top(ui.scroller) === before + 30, `${before} → ${top(ui.scroller)}`);
  ui.dispose();
}

// ---------------------------------------------------------------------------
// A tap must stay a tap — that is what the wider control threshold is for.
// ---------------------------------------------------------------------------
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.star, { pointerType: "touch", pixels: 3 });
  const click = send("click", ui.star);
  check("a shaky tap on a finger still hits the star", ui.star.clicks === 1 && !click.defaultPrevented);
  check("and does not move the list", top(ui.scroller) === before, `${before} → ${top(ui.scroller)}`);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.star, { pointerType: "touch", pixels: 9 });
  check("nine pixels of shake is still a tap", top(ui.scroller) === before, String(top(ui.scroller) - before));
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.star, { pointerType: "touch", pixels: 12 });
  check("twelve is a drag, not a tap", top(ui.scroller) === before + 12, `${before} → ${top(ui.scroller)}`);
  ui.dispose();
}
{
  // The same travel on something that is not a control pans at the plain
  // threshold: the wider one is per press, not a new rule for the whole app.
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.gap, { pointerType: "touch", pixels: 6 });
  check("six pixels from the row's padding already pans", top(ui.scroller) === before + 6, `${before} → ${top(ui.scroller)}`);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.rowText, { pointerType: "touch", pixels: 6 });
  check("six pixels on a control does not", top(ui.scroller) === before, String(top(ui.scroller) - before));
  ui.dispose();
}

// ---------------------------------------------------------------------------
// The sidebar's dead zone: a finger on a feed row.
// ---------------------------------------------------------------------------
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.feedText, { pointerType: "touch", pixels: 30 });
  check("a finger that starts on a feed row pans the feed tree", top(ui.scroller) === before + 30, `${before} → ${top(ui.scroller)}`);
  const click = send("click", ui.feedRow);
  check("and does not open the feed it started on", ui.feedRow.clicks === 0);
  ui.dispose();
}
{
  // ...and the reason taking the opt-out off that row cannot disturb the
  // reorder: the reorder never armed in the first place.
  const listeners = fakeWindow.count("pointermove");
  let started = 0;
  const feedDrag = createFeedDrag({
    onStart: () => (started += 1),
    onHover: () => {},
    onEnd: () => {},
    onDrop: () => {},
  });
  feedDrag.arm(
    {
      pointerType: "touch",
      button: 0,
      pointerId: 41,
      clientX: 10,
      clientY: 10,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: { closest: () => null },
    },
    "feed/1",
  );
  check(
    "feed reordering refuses a finger outright",
    fakeWindow.count("pointermove") === listeners && started === 0 && feedDrag.justDropped() === false,
  );
  feedDrag.dispose();
}

// ---------------------------------------------------------------------------
// What a finger is still refused by: the things that own the gesture.
// ---------------------------------------------------------------------------
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.range, { pointerType: "touch", pixels: 30 });
  check("a finger on a range does not pan: the slider slides", top(ui.scroller) === before, String(top(ui.scroller) - before));
  const click = send("click", ui.range);
  check("and the slider keeps its click", ui.range.clicks === 1 && !click.defaultPrevented);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.field, { pointerType: "touch", pixels: 30 });
  check("a finger on a text field does not pan", top(ui.scroller) === before);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.note, { pointerType: "touch", pixels: 30 });
  check("a finger on a contenteditable does not pan", top(ui.scroller) === before);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.gutter, { pointerType: "touch", pixels: 30 });
  check("a finger on the pane gutter does not pan", top(ui.scroller) === before);
  ui.dispose();
}
{
  const ui = page();
  const before = top(ui.scroller);
  drag(ui.rowText, { pointerType: "pen", pixels: 30 });
  check("a pen is still left entirely to the browser", top(ui.scroller) === before);
  ui.dispose();
}

// ---------------------------------------------------------------------------
// The pan says so, so the pressed look can go with the gesture.
// ---------------------------------------------------------------------------
{
  const ui = page();
  send("pointerdown", ui.star, { pointerType: "touch", clientX: 120, clientY: 300, timeStamp: tick() });
  check("a press does not mark the document before it travels", !panning(ui.documentElement));
  send("pointermove", ui.star, { pointerType: "touch", clientX: 120, clientY: 290, timeStamp: tick() });
  check("the pan marks it as it takes over", panning(ui.documentElement));
  send("pointermove", ui.star, { pointerType: "touch", clientX: 120, clientY: 270, timeStamp: tick() });
  check("and keeps it while the hand is on the content", panning(ui.documentElement));
  send("pointerup", ui.star, { pointerType: "touch", clientX: 120, clientY: 270, timeStamp: tick() });
  check("it outlives the release by a frame, as it always did", panning(ui.documentElement));
  flushFrames();
  check("and is gone once that frame has run", !panning(ui.documentElement));
  ui.dispose();
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

// Device note, deliberately last: a synthetic `pointermove` proves the module
// makes the decision it says it does, not that iOS will hand it the same
// gestures. Whether Safari fires `click` after a `touch-action: none` drag, and
// how much hand-shake it forgives before it calls a touch a scroll, are its own
// numbers and can only be measured on hardware.
