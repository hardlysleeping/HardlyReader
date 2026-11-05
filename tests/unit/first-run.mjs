/**
 * The first screen offers a server, and this device is a choice on it.
 *
 * A new install used to open on an empty library with nothing in it, so the
 * device library read as *the* way the app works and connecting a service was a
 * panel away — the owner's report: *"first install and open is a bit confusing,
 * should by default suggest you login to your sync account and be like an option
 * you pick to use local mode"*, with the two worries that follow from it (*"I
 * will add feeds in local mode and they wont show up in my sync account"*,
 * *"not wanting to add something to my freshrss only wanting it locally"*).
 *
 * What this suite holds still, from the source rather than from a browser:
 *
 *   - a device with no account lands on the sign-in screen, and the library on
 *     this device is a labelled press on it, not the screen you arrive at;
 *   - the choice is remembered per device, so a local reader is not asked again;
 *   - a library that already holds feeds opens by itself, answer or no answer;
 *   - the add form names the one library a new feed lands in, and says the split
 *     for a device library — a feed is never written to two places;
 *   - the demo still opens its own seeded library, because Pages cannot fetch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const app = read("src/App.svelte");
const login = read("src/views/Login.svelte");
const sidebar = read("src/components/Sidebar.svelte");
const device = read("src/lib/device-library.ts");

// ---------------------------------------------------------------------------
// 1. First run: sign in is what the screen is for
// ---------------------------------------------------------------------------

{
  const boot = app.slice(app.indexOf("const stored = accounts.active;"));
  const noAccount = boot.slice(0, boot.indexOf("initialServerUrl = stored.serverUrl"));

  check(
    "a device with no account is a first run",
    /if \(!DEMO\) \{[\s\S]{0,900}?firstRun = true;/.test(noAccount),
  );
  check(
    "...and it draws the sign-in screen instead of a library",
    /onlocal=\{firstRun \? \(\) => void useThisDevice\(\) : undefined\}/.test(app),
  );
  check(
    "the device library is only opened by a press",
    (app.match(/local = await openLocalProfile\(\)/g) ?? []).length >= 1 &&
      /async function useThisDevice\(\)[\s\S]{0,400}?local = await openLocalProfile\(\);/.test(app),
  );
  check(
    "the press is remembered, so the screen is not asked again",
    /async function useThisDevice\(\)[\s\S]{0,400}?chooseDeviceLibrary\(\);/.test(app) &&
      /deviceLibraryChosen\(\) \|\| feeds\.length > 0/.test(app),
  );
  check(
    "a library that already holds feeds opens by itself",
    /const feeds = await opened\.backend\.subscriptions\(\);[\s\S]{0,160}?local = opened;/.test(app),
  );
  check(
    "the demo keeps the seeded library it was built with",
    /if \(!DEMO\) \{/.test(app) && /seedDemoLibrary\(store/.test(app),
  );
  check(
    "the press clears the first-run state rather than leaving the veil up",
    /chooseDeviceLibrary\(\);[\s\S]{0,80}?firstRun = false;/.test(app),
  );
}

// ---------------------------------------------------------------------------
// 2. The choice on the sign-in screen, worded plainly
// ---------------------------------------------------------------------------

{
  check(
    "the sign-in screen takes an optional device-library way in",
    /onlocal\?: \(\) => void;/.test(login) && /onlocal,/.test(login),
  );
  check(
    "it is drawn as a button of its own, after Connect",
    /class="local" onclick=\{onlocal\}>Use this device only<\/button>/.test(login) &&
      login.indexOf("<button type=\"submit\"") < login.indexOf('class="local"'),
  );
  check(
    "...and it says what the difference is: nothing is sent, nothing arrives",
    /Nothing is sent to a server,/.test(login) && /do not appear here/.test(login),
  );
  check(
    "it is absent unless this is a first run",
    /onlocal=\{firstRun/.test(app) && !/onlocal=\{[^}]*adding/.test(app),
  );
}

// ---------------------------------------------------------------------------
// 3. A feed has exactly one owner, and the form says whose
// ---------------------------------------------------------------------------

{
  check(
    "the add form works out the owner from the profile",
    /const addOwner = \$derived\.by\(\(\) => \{[\s\S]{0,600}?profile\.kind === "local"/.test(sidebar),
  );
  check(
    "a device library says the feed stays here",
    /These feeds stay on this device — they are never sent to a server\./.test(sidebar),
  );
  check(
    "several accounts name the one they land in, and one account says nothing",
    /These feeds are added to \$\{profile\.label\}\./.test(sidebar) &&
      /if \(!reader\.hasAccountGroups\) return null;/.test(sidebar),
  );
  check(
    "the line sits in the form, between the field and the button",
    sidebar.indexOf('id="feed-url"') < sidebar.indexOf('class="add-owner"') &&
      sidebar.indexOf('class="add-owner"') < sidebar.indexOf('class="add-actions"'),
  );
  check(
    "the empty library states it too, for a library on this device",
    /reader\.profile\?\.kind === "local"[\s\S]{0,200}?kept on this device/.test(sidebar),
  );
}

// ---------------------------------------------------------------------------
// 4. The answer is device-scoped, and a missing store is not a crash
// ---------------------------------------------------------------------------

{
  check(
    "one key, one answer",
    /const KEY = "hardlyreader\.device-library\.v1";/.test(device) &&
      /export function deviceLibraryChosen/.test(device) &&
      /export function chooseDeviceLibrary/.test(device),
  );
  check(
    "storage that throws answers 'not chosen' and still opens the library",
    /catch \{\s*return false;\s*\}/.test(device) && /catch \{\s*\/\*/.test(device),
  );
  check("the answer never travels: it is not a synced namespace", !/PREFS_NAMESPACES/.test(device));

  // The real functions over a Map, so the round trip is exercised and not read.
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  try {
    const { chooseDeviceLibrary, deviceLibraryChosen } = await import(
      "../../src/lib/device-library.ts"
    );
    check("nothing chosen reads false", deviceLibraryChosen() === false);
    chooseDeviceLibrary();
    check("the press reads back true", deviceLibraryChosen() === true);
    check("it is stored under the one key", store.get("hardlyreader.device-library.v1") === "1");
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
