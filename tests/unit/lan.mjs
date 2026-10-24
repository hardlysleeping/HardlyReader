/**
 * Headless checks for the network share: the port rules, the address, and the
 * three states the Web tab has to be able to say.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/lan.mjs
 *
 * The server is Rust and is not run here. What is checked is the part that would
 * otherwise be wrong in a way nobody notices — a port of 80 that needs root, an
 * address a phone cannot open, a state that lies about being reachable.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_LAN_PORT,
  LAN_KEY,
  LAN_LABELS,
  LAN_PORT_MAX,
  LAN_PORT_MIN,
  clampPort,
  lanNote,
  lanStateFor,
  lanUrl,
} from "../../src/lib/lan.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  // A check written as a closure is run, not counted as truthy: the whole point
  // of these is the assertion inside it.
  const passed = typeof ok === "function" ? ok() === true : ok === true;
  checks++;
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

check("the key is namespaced and versioned", LAN_KEY === "hardlyreader.lan.v1", LAN_KEY);
check("the default port is not a common one", DEFAULT_LAN_PORT === 8450);

check("a port outside the usable range is brought back into it", () => {
  return (
    clampPort(80) === LAN_PORT_MIN &&
    clampPort(70000) === LAN_PORT_MAX &&
    clampPort(9000) === 9000 &&
    clampPort("9000") === 9000
  );
});

check("nonsense keeps the default", clampPort("http") === DEFAULT_LAN_PORT && clampPort(undefined) === DEFAULT_LAN_PORT);
check("a fractional port is a whole one", clampPort(8450.7) === 8451);

check("an address is a URL anybody could type", lanUrl("192.168.1.24", 8450) === "http://192.168.1.24:8450/");
check("the address clamps the port too", lanUrl("10.0.0.5", 12) === `http://10.0.0.5:${LAN_PORT_MIN}/`);

check("nothing served reads as off", lanStateFor(null) === "off");
check("a network address reads as on", lanStateFor("http://192.168.1.24:8450/") === "on");
check("a loopback address is honest about it", () => {
  return (
    lanStateFor("http://127.0.0.1:8450/") === "local-only" &&
    lanStateFor("http://localhost:8450/") === "local-only" &&
    lanStateFor("http://0.0.0.0:8450/") === "local-only"
  );
});

check("every state has a label and a sentence", () => {
  return (["off", "on", "local-only"]).every(
    (state) => typeof LAN_LABELS[state] === "string" && LAN_LABELS[state].length > 0 && lanNote(state).length > 0,
  );
});
check("the loopback state says a phone cannot open it", /phone cannot/.test(lanNote("local-only")));

// The switch only exists where there is a shell to serve from.
const panel = readFileSync(join(root, "src/components/ThemePanel.svelte"), "utf8");
check("the Web tab is a tab", /\{ id: "web", label: "Web" \}/.test(panel));
check("the switch is desktop-only", /\{#if !lan\.available\}/.test(panel) && /lan\.start\(\)/.test(panel) && /lan\.stop\(\)/.test(panel));
check("the address can be opened and copied", /openExternal\(lan\.url\)/.test(panel) && /clipboard\.writeText\(lan\.url\)/.test(panel));

const rust = readFileSync(join(root, "src-tauri/src/lan.rs"), "utf8");
check("the server binds the network, not just this machine", /0\.0\.0\.0/.test(rust));
check("it serves the assets already in the binary", /asset_resolver\(\)/.test(rust));
check("an unknown path gets the shell, not a 404", /index\.html/.test(rust));
check("closing the window stops it", /WindowEvent::Destroyed/.test(readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8")));

const manifest = JSON.parse(readFileSync(join(root, "public/manifest.webmanifest"), "utf8"));
check("the manifest can be installed", manifest.display === "standalone" && manifest.start_url === "/");
check("it has the two sizes an installer wants", () => {
  const sizes = manifest.icons.map((icon) => icon.sizes);
  return sizes.includes("192x192") && sizes.includes("512x512");
});

const main = readFileSync(join(root, "src/main.ts"), "utf8");
check("the browser registers a worker, the shell does not", () => {
  return /__TAURI_INTERNALS__/.test(main) && /serviceWorker\.register\("\/sw\.js"\)/.test(main);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
