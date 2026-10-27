/**
 * The lock button must not claim a passcode state it was never told.
 *
 * The bug this locks down: a PWA served from another origin cannot read the
 * adapter's `/v1/state` at all (no CORS on that route), so `available` came back
 * false and the tooltip said "Set a passcode first" on an account that had one.
 */
import { lockHint, lockOpensPanel, lockState, lockTitle } from "../../src/lib/lock-title.ts";

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

check("an answered server with a passcode is ready", lockState(true, true) === "ready");
check("a library with no server is its own case", lockState(false, false, false) === "local");
check("and it never claims a server is silent", lockTitle("local") !== lockTitle("unknown"));
check("local locks open nothing", lockOpensPanel("local") === false);
check("and show no passcode hint", lockHint("local") === null);
check("an answered server without one says none", lockState(true, false) === "none");
check("an unanswered server is unknown, not none", lockState(false, false) === "unknown");
check("and stays unknown even if a stale flag says there is one", lockState(false, true) === "unknown");

check("ready offers the lock", lockTitle("ready") === "Lock hidden categories");
check("none asks for a passcode", lockTitle("none") === "Set a passcode first");
check(
  "unknown says nobody answered, and never mentions a passcode",
  /has not said/.test(lockTitle("unknown")) && !/passcode first/i.test(lockTitle("unknown")),
  lockTitle("unknown"),
);

check("the panel opens only when there is provably no passcode", lockOpensPanel("none") === true);
check("not when one exists", lockOpensPanel("ready") === false);
check("and not when the server said nothing", lockOpensPanel("unknown") === false);

check("the hint appears only in the none case", lockHint("none") !== null);
check("not while ready", lockHint("ready") === null);
check("and not while unknown", lockHint("unknown") === null);

// The band must route all three through these helpers rather than re-deriving.
import { readFileSync } from "node:fs";
const band = readFileSync(new URL("../../src/components/SidebarBand.svelte", import.meta.url), "utf8");
check("the band asks the helper for its title", /lockTip = \$derived\(lockTitle\(lock\)\)/.test(band) && /title=\{lockTip\}/.test(band));
check("the band never branches on hiddenHasPasscode for the title", !/title=\{reader\.hiddenHasPasscode/.test(band));
check("the band gates the panel on the helper", /lockOpensPanel\(lock\)/.test(band));
check("the band renders the hint from the helper", /\{hint\}/.test(band));

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
