/**
 * Headless checks for the background picture: the size it is kept at, and the
 * policy around it — a picture is a data URL in the theme, never a path.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/background.mjs
 *
 * The drawing itself needs a canvas and is not tested here; the arithmetic that
 * decides how much of the picture is kept is, because that is what stops a phone
 * photograph from filling localStorage.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MAX_BG_CHARS, MAX_BG_EDGE, fit } from "../../src/lib/background-image.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

check("the long edge is a screen size, not a photo size", MAX_BG_EDGE === 1800 && MAX_BG_CHARS > 0);

check("a photograph is scaled to the long edge", () => {
  const out = fit(4000, 3000);
  return out.width === 1800 && out.height === 1350;
});

check("a portrait photograph is scaled by its height", () => {
  const out = fit(3000, 4000);
  return out.height === 1800 && out.width === 1350;
});

check("a small picture is left alone", () => {
  const out = fit(640, 480);
  return out.width === 640 && out.height === 480;
});

check("a degenerate size does not divide by zero", () => {
  const out = fit(0, 0);
  return out.width === 0 && out.height === 0;
});

check("the aspect ratio survives rounding", () => {
  const out = fit(1920, 1080);
  return Math.abs(out.width / out.height - 1920 / 1080) < 0.02;
});

const helper = readFileSync(join(root, "src/lib/background-image.ts"), "utf8");
check("it stores a data URL, never a path", /data:image\//.test(helper) === false && /toDataURL\("image\/jpeg"/.test(helper));
check("it re-encodes rather than refusing a large picture", /MAX_BG_CHARS/.test(helper) && /0\.6/.test(helper));
check("it releases the decoded bitmap", /bitmap\.close\(\)/.test(helper));

const panel = readFileSync(join(root, "src/components/ThemePanel.svelte"), "utf8");
check("picking the same file twice still fires", /input\.value = "";/.test(panel));
check("the background is cleared without touching the colours", /theme\.set\("bgImage", null\)/.test(panel) && /theme\.set\("bg", null\)/.test(panel));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
