/**
 * The row's turn, in the direction asked for.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/turn-direction.mjs
 *
 * Two promises, both learned the hard way.
 *
 * First, direction: the pill turned its right-hand corners and the foot its bottom ones, and a row
 * that only ever turns one way is a row you cannot hang the other way. `turnCorners` is the one
 * place that decides which of the four corners a shape turns, so the row and the accent painted
 * over it cannot end up turning different corners.
 *
 * Second, size: a 60px turn on a 64px row is not a shape the browser draws — it scales every radius
 * of the box, and the accent is a box of its own a pixel different, so it scaled by a different
 * factor and the two curves parted at the corner. That was the clipped corner a row with no
 * picture to cover it showed. The vertical radius is clamped to half the row in CSS
 * (`min(60px, 50%)`), which is why each turned corner carries two values and not one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { TURN_DEFAULT, isTurnEdge, isTurnSide, turnCorners } from "../../src/lib/list-view.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${name}${detail === undefined ? "" : `  (${detail})`}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

/* ---------------------------------------------------------------------------
 * The four corners, by shape and direction
 * ------------------------------------------------------------------------ */

const turned = (corners) => Object.entries(corners).filter(([, value]) => value !== "0").map(([key]) => key).sort();

check("a fresh install turns the pill's right-hand corners", TURN_DEFAULT.side === "right" && TURN_DEFAULT.edge === "bottom");
check("the pill on the right turns tr and br", turned(turnCorners("pill", 30, "right", "bottom")).join(",") === "br,tr");
check("on the left it turns tl and bl", turned(turnCorners("pill", 30, "left", "bottom")).join(",") === "bl,tl");
check("both turns all four", turned(turnCorners("pill", 30, "both", "bottom")).join(",") === "bl,br,tl,tr");
check("the foot on the bottom turns br and bl", turned(turnCorners("foot", 30, "right", "bottom")).join(",") === "bl,br");
check("hung from the top it turns tr and tl", turned(turnCorners("foot", 30, "right", "top")).join(",") === "tl,tr");
check(
  "the pill reads the side and ignores the edge",
  JSON.stringify(turnCorners("pill", 30, "left", "top")) === JSON.stringify(turnCorners("pill", 30, "left", "bottom")),
);
check(
  "the foot reads the edge and ignores the side",
  JSON.stringify(turnCorners("foot", 30, "both", "top")) === JSON.stringify(turnCorners("foot", 30, "right", "top")),
);

/* Zero is a square corner, in every direction: no radius may leak through. */
check("zero turns nothing, whichever way it faces", ["right", "left", "both"].every((side) => turned(turnCorners("pill", 0, side, "bottom")).length === 0));
check("...and the foot the same", ["bottom", "top"].every((edge) => turned(turnCorners("foot", 0, "right", edge)).length === 0));

/* The clamp: the setting across, half the row down. */
check(
  "a turned corner carries the setting across and half the row down",
  turnCorners("pill", 60, "right", "bottom").tr === "60px min(60px, 50%)",
  turnCorners("pill", 60, "right", "bottom").tr,
);
check(
  "a short turn is not rewritten by the clamp",
  turnCorners("pill", 10, "right", "bottom").tr === "10px min(10px, 50%)",
);
check(
  "a radius that is not a number lands on zero rather than NaN",
  turnCorners("pill", Number.NaN, "right", "bottom").tr === "0",
);
check(
  "a negative radius is a square corner, not a mirrored one",
  turnCorners("pill", -20, "right", "bottom").tr === "0",
);

check("only the three sides are sides", isTurnSide("right") && isTurnSide("left") && isTurnSide("both") && !isTurnSide("top") && !isTurnSide(undefined));
check("only the two edges are edges", isTurnEdge("bottom") && isTurnEdge("top") && !isTurnEdge("left") && !isTurnEdge(1));

/* ---------------------------------------------------------------------------
 * The list draws what the model says
 * ------------------------------------------------------------------------ */

const listSource = read("src/components/ArticleList.svelte");

check(
  "the list asks the model for its corners rather than writing them out",
  /turnCorners\(\s*reading\.rowsEnd === "half" \? "foot" : "pill",\s*rowTurn,\s*reading\.turnSide,\s*reading\.turnEdge,?\s*\)/.test(listSource),
);
check(
  "all four radii reach the stylesheet",
  // All four in one attribute, not four `style:` directives: Svelte dropped the last two of those
  // at runtime, which drew a square corner while every computed style still said the setting was on.
  ["tl", "tr", "br", "bl"].every((corner) => new RegExp(`--turn-${corner}: \\$\\{corners\\.${corner}\\}`).test(listSource)),
);
check(
  "the row and its accent both read those four",
  (listSource.match(/border-bottom-right-radius: var\(--turn-br, 0\);/g) ?? []).length >= 3,
);
check(
  "the direction is a class on the list, only in the rows view",
  /class:turn-left=\{view === "regular" && reading\.rowsEnd !== "half" && reading\.turnSide === "left"\}/.test(listSource) &&
    /class:turn-both=\{view === "regular" && reading\.rowsEnd !== "half" && reading\.turnSide === "both"\}/.test(listSource) &&
    /class:turn-top=\{view === "regular" && reading\.rowsEnd === "half" && reading\.turnEdge === "top"\}/.test(listSource),
);
check(
  "a left-hung turn keeps the room its shadow needs on the left",
  /\.items\.turn-left:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row \{[^}]*margin-left: 3px;[^}]*box-shadow: -3px 2px/.test(listSource),
);
check(
  "the accent is mirrored with the end, not left pointing the old way",
  /\.items\.turn-left:not\(\.compact\):not\(\.cards\):not\(\.grid\) \.row:not\(\.read\)::after \{[^}]*border-right: 0;[^}]*border-left: 5px solid/.test(
    listSource,
  ),
);
check(
  "a foot hung from the top moves its thick band to the top edge",
  /\.items\.half-end\.turn-top[^{]*\.row:not\(\.read\)::after \{[^}]*border-top-width: var\(--foot\);[^}]*border-bottom-width: 0;/.test(listSource),
);

/* ---------------------------------------------------------------------------
 * The setting is remembered, and only from a value it knows
 * ------------------------------------------------------------------------ */

const readingSource = read("src/state/reading.svelte.ts");

check(
  "both directions travel with the rest of the reading preferences",
  /turnSide: this\.turnSide,/.test(readingSource) && /turnEdge: this\.turnEdge,/.test(readingSource),
);
check(
  "a stored direction is validated before it is believed",
  /if \(isTurnSide\(saved\.turnSide\)\) this\.turnSide = saved\.turnSide;/.test(readingSource) &&
    /if \(isTurnEdge\(saved\.turnEdge\)\) this\.turnEdge = saved\.turnEdge;/.test(readingSource),
);
check(
  "each setter writes once and only on a change",
  /setTurnSide\(side: TurnSide\): void \{\s*if \(this\.turnSide === side\) return;/.test(readingSource) &&
    /setTurnEdge\(edge: TurnEdge\): void \{\s*if \(this\.turnEdge === edge\) return;/.test(readingSource),
);

const curveComponent = read("src/components/RowCurve.svelte");
const panelComponent = read("src/components/PostListPanel.svelte");

check(
  "the corner popup offers the direction of the shape on screen",
  /reading\.setTurnSide\("right"\)/.test(curveComponent) &&
    /reading\.setTurnSide\("left"\)/.test(curveComponent) &&
    /reading\.setTurnSide\("both"\)/.test(curveComponent) &&
    /reading\.setTurnEdge\("bottom"\)/.test(curveComponent) &&
    /reading\.setTurnEdge\("top"\)/.test(curveComponent),
);
check(
  "...and a pill is never offered a top, or a foot a left",
  /\{#if footed\}[\s\S]*?setTurnEdge\("bottom"\)[\s\S]*?\{:else\}[\s\S]*?setTurnSide\("right"\)/.test(curveComponent),
);
check(
  "the panel a phone reaches has the same pair",
  /reading\.setTurnSide\("left"\)/.test(panelComponent) && /reading\.setTurnEdge\("top"\)/.test(panelComponent),
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
