// Which indent the app draws, and where the number lives.
//
// The extension owns the setting, so the server wins whenever it can store one.
// Both cases where it cannot used to lose the number entirely: no extension, and
// an extension that cannot write (the server still reports its own old value,
// which then won on every reload).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveIndent } from "../../src/lib/indent.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const server = (px, available = true) => ({ available, px, max: 60 });

check("a server that can store it owns it", resolveIndent(server(12), 30, false).px === 12);
check("and its max comes along", resolveIndent(server(12), 30, false).max === 60);
check("nothing set on this device means the server's number", resolveIndent(server(12), null, false).px === 12);
check("no extension: this device's number, on a control that says it is off", () => {
  const out = resolveIndent(server(8, false), 30, false);
  return out.px === 30 && out.available === false;
});
check(
  "an extension that cannot write is this device's number, but still a live control",
  () => {
    const out = resolveIndent(server(8, true), 30, true);
    return out.px === 30 && out.available === true;
  },
);
check("the device's number is clamped to the server's max", resolveIndent({ available: false, px: 0, max: 24 }, 40, false).px === 24);
check("a wild stored value cannot escape the cap", resolveIndent(server(0, false), 9999, false).px === 60);
check("zero is a real indent, not an absence", resolveIndent(server(0, false), 0, false).px === 0);

const reader = read("src/state/reader.svelte.ts");
const sidebar = read("src/components/Sidebar.svelte");

check("the reader asks the rule instead of repeating it", /resolveIndent\(/.test(reader));
check("a failed or unwritten value is kept on this device", /this\.localIndentPx = clamped;/.test(reader));
check(
  "and it wins while the server is unhappy, or has not taken the last value yet",
  /this\.indentLocalOnly \|\| this\.indentUnsent !== null \|\| this\.indentError !== null/.test(reader),
);

// A write that never landed must survive a restart, and be tried again.
check("the unwritten value is remembered", /indentUnsent: this\.indentUnsent/.test(reader));
check("a state read retries it", /this\.retryUnsentIndent\(state\.sidebarIndent\.px\)/.test(reader));
check("and a value the server already has is not written again", /if \(unsent === serverPx\)/.test(reader));
check("only one write is in flight", /if \(session === null \|\| this\.indentWriting\) return;/.test(reader));
check("a server that cannot write is remembered, not rediscovered", /indentLocal: this\.indentLocalOnly/.test(reader) && /this\.indentLocalOnly = raw\?\.indentLocal === true/.test(reader));
check("releasing the slider writes at once instead of waiting out the debounce", /onchange=\{\(event\) => reader\.setSidebarIndentPx\(Number\(event\.currentTarget\.value\), true\)\}/.test(sidebar));
check("the release also stores this device's copy", /if \(flush\) this\.savePrefs\(\);/.test(reader));

// Without the extension the number is still the reader's: the slider used to be
// disabled there, which made "keep it on this device" impossible to reach.
check("the slider works with no extension to store it", !/disabled=\{!reader\.sidebarIndent\.available\}/.test(sidebar));
check("and it says where the number lives", /reader\.indentDeviceOnly/.test(sidebar));
check("which is the extension's absence or its refusal", /this\.indentLocalOnly \|\| !this\.sidebarIndent\.available/.test(reader));

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
