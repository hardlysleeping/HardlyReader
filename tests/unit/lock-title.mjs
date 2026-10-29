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

// A server with no Hidden Categories at all (Miniflux, a stock FreshRSS) has
// nowhere to keep a passcode: that is a fact about this backend, not a server
// that has not answered, and the sentence has to be its own.
check("a backend with no extension is missing the piece, not silent", lockState(false, false, true, "local") === "missing");
check("...and says which piece", /Hidden Categories/.test(lockTitle("missing")), lockTitle("missing"));
check("...without claiming the server never spoke", !/has not said/.test(lockTitle("missing")));
check("...and opens nothing: there is no passcode to set", lockOpensPanel("missing") === false);
check("a library with no server keeps its own answer", lockState(false, false, false, "local") === "local");
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
check("the band asks the helper for its title", /lockTip = \$derived\(lockTitle\(lock\)\)/.test(band) && /title=\{lockTip\}/.test(band));
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
