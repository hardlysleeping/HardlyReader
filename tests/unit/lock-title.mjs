/**
 * The lock button must not claim a passcode state it was never told.
 *
 * The bug this locks down: a PWA served from another origin cannot read the
 * adapter's `/v1/state` at all (no CORS on that route), so `available` came back
 * false and the tooltip said "Set a passcode first" on an account that had one.
 */
import { lockHint, lockOpensPanel, lockState, lockTitle, lockUsable } from "../../src/lib/lock-title.ts";

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
// A library with no server keeps its own passcode (`LocalHidden.passcode`), so it can lock: the
// old "Locking needs a connected service" answer refused a lock the app now performs.
check("a library with no server can lock once it has a code", lockState(false, true, false) === "ready");
check("...and asks for one when it has none", lockState(false, false, false) === "none");
check("...which is the same sentence a server without the extension gets", lockTitle("none") === "Set a passcode first");
check("the local answer is never 'nobody answered'", lockState(false, true, false) !== "unknown");
check("a set kept on the device behind a server locks the same way", lockState(true, true, true, "local") === "ready");
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

// A server with no Hidden Categories at all (Miniflux, a stock FreshRSS) has
// nowhere to keep a passcode: that is a fact about this backend, not a server
// that has not answered, and the sentence has to be its own.
check("a backend with no extension is offered the lock, not told it is missing a piece", lockState(false, false, true, "local") === "none");
check("...in the same words as any other set without a code", lockTitle("none") === "Set a passcode first");
check("...without claiming the server never spoke", !/has not said/.test(lockTitle("none")));
check("...and the press opens the panel to set one", lockOpensPanel("none") === true);
check("a library with no server answers for itself", lockState(false, false, false, "local") === "none");
check("an extension that answered stays ready", lockState(true, true, true, "extension") === "ready");

check("the lock is usable only where it can lock or ask for a code", lockUsable("ready") === true);
check("...including the press that opens the panel", lockUsable("none") === true);
check("...and not where it cannot act", lockUsable("missing") === false && lockUsable("local") === false && lockUsable("unknown") === false);

check("the hint appears only in the none case", lockHint("none") !== null);
check("not while ready", lockHint("ready") === null);
check("and not while unknown", lockHint("unknown") === null);

// The band must route all three through these helpers rather than re-deriving.
import { readFileSync } from "node:fs";
const band = readFileSync(new URL("../../src/components/SidebarBand.svelte", import.meta.url), "utf8");
check(
  "the band asks the helper for its title",
  /lockTip = \$derived\(lockTitle\(lock, reader\.hiddenAuthority === "local" \? "local" : "extension"\)\)/.test(band) &&
    /title=\{lockTip\}/.test(band),
);
check(
  "a lock kept on this device says so, and the extension's words are unchanged",
  lockTitle("ready", "local") === "Lock hidden categories on this device" &&
    lockTitle("ready") === "Lock hidden categories" &&
    lockTitle("none", "local") === "Set a passcode first — it stays on this device" &&
    lockTitle("none", "extension") === "Set a passcode first",
);
check("the band never branches on hiddenHasPasscode for the title", !/title=\{reader\.hiddenHasPasscode/.test(band));
check("the band gates the panel on the helper", /lockOpensPanel\(lock\)/.test(band));
check("the band renders the hint from the helper", /\{hint\}/.test(band));
check("the band tells the helper where the set lives", /lockState\([\s\S]{0,200}reader\.hiddenAuthority,\s*\)/.test(band));
check(
  "the band disables the lock from the helper, not from `available`",
  /const lockEnabled = \$derived\(lockUsable\(lock\)\)/.test(band) &&
    /disabled=\{!lockEnabled\}/.test(band) &&
    !/disabled=\{!reader\.hiddenAvailable\}/.test(band),
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
