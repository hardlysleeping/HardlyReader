/**
 * The folded band on a phone: one hairline across the pane, no space spent on
 * what it is not drawing.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs phone-band-fold.mjs
 *
 * The band carries the eye, the lock and the pin. Folded it is a caret in a 16px
 * strip. Its complaints were all of one kind: it was taller than a caret needs,
 * and it answered to margins meant for another row — first reaching past the
 * glass, then (once the day / night switch left the rail) sitting on the left of
 * the search field with a stripe of nothing on its right, which measures as the
 * three seats ending short of the field above them. The rule now is one inset on
 * every state, the same 8px the search field wears. CSS is read as text —
 * measured on a browser too (390x844 phone: field x=8 w=373 right=381; open band
 * x=8 w=373 right=381; folded band x=8 w=373; seats 154 / 56 / 154).
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
  "...which wears the same 8px inset the search field wears, on both sides",
  /margin:\s*0\s+8px\s+0/.test(foldedBox),
  foldedBox.trim().slice(0, 60),
);
check(
  "...and spends no bottom margin, since the rail's gap was for the row it drew",
  !/margin:\s*0 0 6px/.test(foldedBox),
);
check(
  "the open band wears the same 8px inset plus its 6px of air below",
  /:global\(html\[data-device="phone"\]\) \.bandbox \{[\s\S]{0,120}margin:\s*0 8px 6px/.test(band),
);
// The rail is the band's only parent now that the day / night switch lives in
// the title bar, so any padding it keeps becomes an asymmetric stripe: 0 on the
// left, 10 on the right was exactly the owner's "slightly to the left".
const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.svelte"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rail = sidebar.slice(sidebar.indexOf(':global(html[data-device="phone"]) .rail'));
check("the phone rail keeps no padding of its own", !/padding-right:\s*10px/.test(rail.slice(0, rail.indexOf("}"))));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
