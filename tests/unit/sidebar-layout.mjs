import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../src/components/Sidebar.svelte"), "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

/** The markup half of the component. */
const markup = source.slice(source.indexOf('<nav class="sidebar"'), source.indexOf("</nav>") + 6);
/** A CSS rule's body, by selector. */
function rule(selector) {
  const at = source.indexOf(`\n  ${selector} {`);
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return source.slice(at, source.indexOf("\n  }", at));
}

/**
 * Where a `<div class="…">` ends.
 *
 * Counting tags is crude, but this component's markup is flat enough for it and
 * the point is only to say whether a block is inside the scroll area or outside
 * it — which is the whole contract this test guards.
 */
function divSpan(text, className) {
  // Attributes need not sit on the same line as the tag — the scroll area now
  // carries a gesture — so look for the class anywhere in the opening tag.
  const open = text.search(new RegExp(`<div(?=[^>]*class="${className}")`));
  assert.notEqual(open, -1, `no .${className} in the markup`);
  let depth = 0;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = open;
  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) return { start: open, end: match.index + match[0].length };
  }
  throw new Error(`.${className} is never closed`);
}

{
  const nav = rule(".sidebar");
  check("the nav is a frame, not a page: it does not scroll itself", () => {
    assert.match(nav, /overflow: hidden/);
    assert.doesNotMatch(nav, /overflow-y: auto/);
  });
  check("...and lays its children out in a column", () => {
    assert.match(nav, /display: flex/);
    assert.match(nav, /flex-direction: column/);
  });
}

{
  const scroll = rule(".scroll");
  check("one scroll area, and it is the tree", () => {
    assert.match(scroll, /overflow-y: auto/);
    assert.match(scroll, /flex: 1 1 auto/);
  });
  check("...able to shrink below its content, or the footer is pushed out", () => {
    assert.match(scroll, /min-height: 0/);
  });
}

{
  const scroll = divSpan(markup, "scroll");
  const at = (needle) => markup.indexOf(needle);

  check("the tree is inside the scroll area", () => {
    const tree = at('{#each reader.categories');
    assert.ok(tree > scroll.start && tree < scroll.end, "the categories are outside .scroll");
  });
  check("the counts stay put, under the scroll area", () => {
    const status = at('<div class="status"');
    assert.ok(status > scroll.end, "the counts are inside the scroll area");
  });
  check("the add field stays put too", () => {
    const add = at('<div class="add"');
    assert.ok(add > scroll.end, "the add field is inside the scroll area");
  });
  check("...and OPML goes with it, not with the tree", () => {
    const opml = at('<div class="opml">');
    assert.ok(opml > scroll.end, "the OPML block is inside the scroll area");
  });
  check("the search field and the band are above the scroll area", () => {
    assert.ok(at('<div class="find"') < scroll.start);
    assert.ok(at("<SidebarBand />") < scroll.start);
  });
}

{
  const status = rule(".status");
  const add = rule(".add");
  check("the counts are a strip, not a paragraph", () => {
    assert.match(status, /flex: none/);
    assert.doesNotMatch(status, /margin: 14px/);
  });
  check("the add block does not grow with the panel", () => assert.match(add, /flex: none/));
  check("the counts draw the line above themselves", () => assert.match(status, /border-top: 1px solid/));
}


// A pinned category's outline has to hold the whole row. The count is not part
// of the title button — it is the title's neighbour, opening the category's
// posts — so an outline drawn on the title stops a few pixels short of the
// number and frames the wrong thing. It belongs on the group: the row, which is
// the title and the count together.
{
  check("a pinned category's outline is drawn on the row, not the title", () => {
    assert.match(source, /\.group\.pinned,\s*\.search-title\.pinned,\s*\.feed\.pinned \{/);
    assert.doesNotMatch(source, /\.group-title\.pinned,\s*\.feed\.pinned \{/);
  });
  check("and the group says it is pinned when the category is", () => {
    assert.match(markup, /<div class="group" class:pinned>/);
  });
  check("the search row keeps its own outline, count and all", () => {
    // There the count is inside the titled row, so the row is the right box.
    assert.match(source, /class="row group-title search-title" class:pinned=/);
    assert.match(markup, /<span class="count">\{reader\.countFor\(group\.id\)\}<\/span>/);
  });
}

// A category's posts in one pane. The posts column does not exist there, so a
// press that only opens the stream paints it nowhere: the category has to be
// given the same unfolded list a feed gets, or the gesture does nothing at all.
{
  const anchor = source.slice(source.indexOf("async function anchorCategory"));
  const body = anchor.slice(0, anchor.indexOf("\n  }", anchor.indexOf("pinFeed(category.id)")));
  check("a category in one pane unfolds like a feed, by taking the same slot", () => {
    assert.match(body, /reader\.setExpandedFeed\(category\.id\)/);
    assert.match(body, /openStream\(category\.id, category\.label\)/);
  });
  check("...and it opens the stream, so the posts are the category's own", () => {
    assert.match(source, /reader\.openStream\(category\.id, category\.label\)/);
  });
  check("the category's list is drawn under its heading, not somewhere else", () => {
    assert.match(
      markup,
      /\{#if inlinePosts && expandedFeed === category\.id\}[\s\S]{0,400}<ArticleList nested \/>/,
    );
  });
  check("there is still one list, so a feed and a category cannot both be open", () => {
    assert.equal(markup.split("<ArticleList nested />").length - 1, 2);
    assert.match(markup, /\{#if inlinePosts && expandedFeed === feed\.id\}/);
  });
  check("a double tap in one pane anchors the category rather than the dead stack", () => {
    const block = source.slice(source.indexOf("if (!doubled) {"));
    assert.match(block.slice(0, 700), /if \(inlinePosts\) \{\s*void anchorCategory\(category\);/);
    assert.doesNotMatch(block.slice(0, 700), /mobileNav\.show\(2\)/);
  });
  check("and one tap, in any layout, folds the row it lands on", () => {
    // The ladder this replaces made the fold something you had to reach by
    // selecting the category first; the owner wants the arrow on the first press.
    assert.match(source, /if \(!doubled\) \{\s*pickedCategory = category\.id;\s*toggle\(category\.id\);\s*return;\s*\}/);
  });
  check("the count beside the heading opens it too, since the row itself folds", () => {
    assert.match(markup, /if \(inlinePosts\) void anchorCategory\(category\);/);
  });
  check("the posts a category opened are closed by the next tap, in the list", () => {
    // Still true where the posts are the screen: a feed's row and a category's
    // row both close the unfolded list they opened.
    assert.match(source, /function collapseInline\(/);
    assert.match(source, /if \(expandedFeed === feed\.id\) \{/);
  });
  check("the way back finds a category's row, not only a feed's", () => {
    assert.match(source, /`\[data-drop-feed="\$\{id\}"\], \[data-drop-cat-row="\$\{id\}"\]`/);
  });
  check("the heading carries the unfolded ink the feed row carries", () => {
    assert.match(source, /\.feed\.unfolded,\s*[\s\S]{0,200}\.group-title\.unfolded \{/);
  });
}

console.log(`\n${passed}/${passed} checks passed`);
