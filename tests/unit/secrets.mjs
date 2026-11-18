/**
 * The secret seam: one answer to "where does a token live on this device".
 *
 *   node --experimental-strip-types --import ./register-ts.mjs secrets.mjs
 *
 * Two backends, and the whole point of the module is that the page can tell which
 * one it got: `native` when the shell answers `secret_get`/`secret_set`/
 * `secret_delete`, `device` when the page is on its own (a browser tab, the PWA,
 * a suite). Neither branch is allowed to be silent about where the value went.
 */
import {
  DEVICE_PREFIX,
  secretBackend,
  secretDelete,
  secretGet,
  secretSet,
} from "../../src/lib/secrets.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A Storage-shaped stub, so the device branch is exercised without a browser. */
function stubbed() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** A shell that records what the page asked it to do. */
function shell(answer = { get: null, set: true, del: true }) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "secret_get") return answer.get;
    if (command === "secret_set") {
      if (answer.set === false) throw new Error("no store");
      return undefined;
    }
    if (command === "secret_delete") {
      if (answer.del === false) throw new Error("no store");
      return undefined;
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { calls, invoke };
}

// ---------------------------------------------------------------------------
// Which backend, and how it is decided
// ---------------------------------------------------------------------------
check("a page with no shell is the device backend", secretBackend({ invoke: null, storage: stubbed() }) === "device");
const s1 = shell();
check("a shell is the native backend", secretBackend({ invoke: s1.invoke, storage: null }) === "native");

// ---------------------------------------------------------------------------
// The device branch: a plain round trip, under a prefix of its own
// ---------------------------------------------------------------------------
{
  const storage = stubbed();
  const deps = { invoke: null, storage };
  check("nothing stored reads as null", (await secretGet("a|b", deps)) === null);
  check("a write lands", (await secretSet("a|b", "tok-1", deps)) === true);
  check("...under the device's own prefix", storage.map.has(`${DEVICE_PREFIX}a|b`), [...storage.map.keys()].join(","));
  check("...and reads back", (await secretGet("a|b", deps)) === "tok-1");
  check("a delete removes it", (await (async () => { await secretDelete("a|b", deps); return secretGet("a|b", deps); })()) === null);
  check("deleting what is not there is not an error", (await (async () => { await secretDelete("gone", deps); return true; })()) === true);
  check(
    "a key with a slash in it is storage, not a path",
    (await (async () => {
      await secretSet("https://example.test/api|me@example.test", "tok-2", deps);
      return secretGet("https://example.test/api|me@example.test", deps);
    })()) === "tok-2",
  );
}

// ---------------------------------------------------------------------------
// The native branch: one command per operation, the value never in the name
// ---------------------------------------------------------------------------
{
  const s = shell({ get: "tok-native", set: true, del: true });
  const deps = { invoke: s.invoke, storage: null };
  check("a native write goes to secret_set", (await secretSet("k", "v", deps)) === true);
  check("...with the key and the value", JSON.stringify(s.calls.at(-1)) === JSON.stringify(["secret_set", { key: "k", value: "v" }]), JSON.stringify(s.calls.at(-1)));
  check("a native read comes from secret_get", (await secretGet("k", deps)) === "tok-native");
  check("...asking only for the key", JSON.stringify(s.calls.at(-1)) === JSON.stringify(["secret_get", { key: "k" }]), JSON.stringify(s.calls.at(-1)));
  await secretDelete("k", deps);
  check("a native delete goes to secret_delete", s.calls.at(-1)[0] === "secret_delete");
  check("three operations, three calls", s.calls.length === 3, String(s.calls.length));
}

// ---------------------------------------------------------------------------
// A store that refuses is a fallback, never a failed launch
// ---------------------------------------------------------------------------
{
  const refused = shell({ get: null, set: false, del: false });
  const deps = { invoke: refused.invoke, storage: null };
  check("a refusing store answers false on write", (await secretSet("k", "v", deps)) === false);
  check("...null on read", (await secretGet("k", deps)) === null);
  check("...and a delete still resolves", (await (async () => { await secretDelete("k", deps); return true; })()) === true);
}

// ---------------------------------------------------------------------------
// No storage at all (a server render, a locked-down browser)
// ---------------------------------------------------------------------------
{
  const deps = { invoke: null, storage: null };
  check("no store means nothing to read", (await secretGet("k", deps)) === null);
  check("...nowhere to write", (await secretSet("k", "v", deps)) === false);
  check("...and a delete is quiet", (await (async () => { await secretDelete("k", deps); return true; })()) === true);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
