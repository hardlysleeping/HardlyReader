/**
 * The folded band on a phone: one hairline across the pane, no space spent on
 * what it is not drawing.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs phone-band-fold.mjs
 *
 * The band carries the eye, the lock and the pin. Folded it is a caret in a 16px
 * strip, and the owner's three complaints were all of the same kind: it did not
 * reach the glass, it was taller than a caret needs, and it answered to a margin
 * the open band needed rather than its own. CSS is read as text — measured on a
 * browser too (440x956: bar 0–439 x 79–95, tree starting 95 rather than 117).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const band = readFileSync(join(ROOT, "src/components/SidebarBand.svelte"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const rule = (selector) => {
  const at = band.indexOf(selector);
  if (at < 0) return "";
  const open = band.indexOf("{", at);
  const close = band.indexOf("}", open);
  return band.slice(open, close);
};

const foldedBar = rule(':global(html[data-device="phone"]) .bandbox.collapsed .bar');
check("the folded handle is a phone rule", foldedBar.length > 0);
check("...and it is 16px, not a full row's 20", /height:\s*16px/.test(foldedBar), foldedBar.trim().slice(0, 60));
check("...and it keeps its lift, so it still reads as a control", /opacity:\s*0\.85/.test(foldedBar));

const foldedBox = rule(':global(html[data-device="phone"]) .bandbox.collapsed {');
check("the folded box has a rule of its own", foldedBox.length > 0);
check(
  "...which takes back the rail's right padding, so the strip reaches the glass",
  /margin:\s*0\s+-10px\s+0\s+0/.test(foldedBox),
  foldedBox.trim().slice(0, 60),
);
check(
  "...and spends no bottom margin, since the rail's gap was for the row it drew",
  !/margin:\s*0 0 6px/.test(foldedBox),
);
check(
  "the open band keeps its own 6px, so nothing about the unfolded row moved",
  /:global\(html\[data-device="phone"\]\) \.bandbox \{[\s\S]{0,80}margin:\s*0 0 6px/.test(band),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
