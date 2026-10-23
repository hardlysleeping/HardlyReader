import { resolveKey, resolveShiftKey, isTypingTarget } from "../../src/lib/keys.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = { typing: false, menuOpen: false, hasArticle: false, atArticleStart: false, atArticleEnd: false };
const reading = { ...base, hasArticle: true };

// Up/Down are feeds, not articles, and that is the whole point of this map.
check("ArrowDown is the next feed", JSON.stringify(resolveKey("ArrowDown", base)) === JSON.stringify({ type: "stream", delta: 1 }));
check("ArrowUp is the previous feed", JSON.stringify(resolveKey("ArrowUp", base)) === JSON.stringify({ type: "stream", delta: -1 }));
check(
  "ArrowDown is still the next feed while reading",
  JSON.stringify(resolveKey("ArrowDown", reading)) === JSON.stringify({ type: "stream", delta: 1 }),
);
check("Home is the first feed", resolveKey("Home", base).type === "first");
check("End is the last feed", resolveKey("End", base).type === "last");
check("ArrowRight enters", resolveKey("ArrowRight", base).type === "enter");
check("Enter enters", resolveKey("Enter", base).type === "enter");
check("ArrowLeft backs out", resolveKey("ArrowLeft", reading).type === "back");
check("Escape escapes", resolveKey("Escape", reading).type === "escape");
check("an unrelated key does nothing", resolveKey("q", base).type === "none");

// Space pages, and turns into an advance at the end.
const mid = resolveKey(" ", { ...reading, atArticleEnd: false });
check("Space pages down mid-article", mid.type === "page" && mid.direction === 1 && mid.advance === false, JSON.stringify(mid));
const atEnd = resolveKey(" ", { ...reading, atArticleEnd: true });
check("Space at the end advances", atEnd.type === "page" && atEnd.advance === true, JSON.stringify(atEnd));
check("Space with no article enters", resolveKey(" ", base).type === "enter");
const shiftEnd = resolveShiftKey(" ", { ...reading, atArticleStart: true });
check("Shift+Space at the top advances backwards", shiftEnd.type === "page" && shiftEnd.direction === -1 && shiftEnd.advance === true);
const shiftMid = resolveShiftKey(" ", reading);
check("Shift+Space pages up mid-article", shiftMid.type === "page" && shiftMid.direction === -1 && shiftMid.advance === false);
check("Shift+ArrowDown is still a feed move", resolveShiftKey("ArrowDown", base).type === "stream");

// Guards: never steal a key from a field, never fight the menu.
for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", " ", "Enter", "Home", "Escape"]) {
  check(`typing swallows ${key.trim() || "space"}`, resolveKey(key, { ...reading, typing: true }).type === "none");
  check(`the menu owns ${key.trim() || "space"}`, resolveKey(key, { ...reading, menuOpen: true }).type === "none");
}
check("typing detects inputs", isTypingTarget({ tagName: "INPUT" }) === true);
check("typing detects contenteditable", isTypingTarget({ tagName: "DIV", isContentEditable: true }) === true);
check("typing ignores a div", isTypingTarget({ tagName: "DIV", isContentEditable: false }) === false);
check("typing ignores null", isTypingTarget(null) === false);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
