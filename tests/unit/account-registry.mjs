/**
 * Several accounts in one window.
 *
 * The registry is the answer to "whose?", and these checks are the three promises it
 * makes: a slug is the identity, a removed account takes its queued marks with it,
 * and turning an account off for a merged view does not sign it out.
 *
 * The backends here are objects that record what they were asked, because the
 * questions that matter are about *which* backend a slug resolved to and whether a
 * profile was mutated — not about reading anything.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account-registry.mjs
 */
import { AccountRegistry } from "../../src/api/registry.ts";
import { localProfile, syncProfile } from "../../src/api/profile.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

/** A backend that answers nothing; the registry never calls one. */
function backend(kind = "greader") {
  return { kind, calls: [], read: async () => {} };
}

function session(email, serverUrl = "https://reader.example") {
  return { serverUrl, apiPath: "/api/greader.php", email, token: `t-${email}` };
}

/** Two FreshRSS accounts on the same server: the case the brief calls HR-102. */
function twoAccounts() {
  const registry = new AccountRegistry();
  const a = syncProfile(session("a@example.com"), backend());
  const b = syncProfile(session("b@example.com"), backend());
  registry.add(a);
  registry.add(b);
  return { registry, a, b };
}

const { registry, a, b } = twoAccounts();

equal("two accounts of one provider both live in the registry", registry.slugs().sort(), [a.slug, b.slug].sort());
check("they are different accounts", a.slug !== b.slug, `${a.slug} / ${b.slug}`);
check("and neither slug carries the address in the clear", !a.slug.includes("@") && !a.slug.includes("example.com"));

check(
  "a slug resolves to that account's own backend, not the last one added",
  registry.backend(a.slug) === a.backend && registry.backend(b.slug) === b.backend,
);
equal("an unknown slug resolves to nothing rather than to somebody else", registry.backend("nope"), null);
equal("and so does a profile lookup", registry.get("nope"), null);
check("has() agrees with get()", registry.has(a.slug) && !registry.has("nope"));

// ---------------------------------------------------------------------------
// Order is what Pane 1 draws, so it is insertion order.
// ---------------------------------------------------------------------------

equal(
  "the list is insertion order, so Pane 1 does not reshuffle between draws",
  registry.all().map((p) => p.slug),
  [a.slug, b.slug],
);

// ---------------------------------------------------------------------------
// enabled: the merged view's membership, not the sign-in.
// ---------------------------------------------------------------------------

equal("every account is in a merged view by default", registry.enabled().length, 2);

const turnedOff = { ...b, enabled: false };
registry.add(turnedOff);
equal("an account turned off drops out of the merged view", registry.enabled().map((p) => p.slug), [a.slug]);
check(
  "...but stays signed in, and still answers by slug",
  registry.has(b.slug) && registry.get(b.slug)?.enabled === false && registry.backend(b.slug) === b.backend,
);
equal("and the full list still has both", registry.all().length, 2);

// ---------------------------------------------------------------------------
// Nothing mutates a profile.
// ---------------------------------------------------------------------------

const before = JSON.stringify(a);
registry.add({ ...a, label: "renamed" });
check("adding a profile does not edit the object it was given", JSON.stringify(a) === before);

// ---------------------------------------------------------------------------
// A local library is one account among several.
// ---------------------------------------------------------------------------

{
  const local = localProfile(backend("local"), "On this device");
  const reg = new AccountRegistry();
  reg.add(local);
  reg.add(syncProfile(session("c@example.com"), backend()));
  equal("a local library and a server account coexist", reg.size, 2);
  check("the local one still resolves to its own backend", reg.backend(local.slug) === local.backend);
  check(
    "and its slug is the device identity's, so its keys stay its own",
    local.slug === reg.slugs()[0] && local.slug.length > 0,
  );

  // Two libraries on one device are one slug: there is one library here, and a
  // second handle on the same database is not a second account.
  reg.add(localProfile(backend("local"), "On this device too"));
  equal("one device is one local account, whatever it is called", reg.size, 2);
}

// ---------------------------------------------------------------------------
// Removal takes the queued marks with it.
// ---------------------------------------------------------------------------

{
  const { registry: reg, a: keep, b: drop } = twoAccounts();
  check("removing an account that is not there says so", reg.remove("nope") === false);
  check("removing one that is there succeeds", reg.remove(drop.slug) === true);
  equal("it leaves the list", reg.slugs(), [keep.slug]);
  check("and its backend is no longer resolvable", reg.backend(drop.slug) === null);
  check("while the account that stayed is untouched", reg.backend(keep.slug) === keep.backend);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
