/**
 * Per-feature authority: use the service for what it supports, the paid sync only for the gaps.
 *
 * The owner's rule, and the one thing that must not drift: authority is decided feature by feature,
 * never by one "FreshRSS vs cloud" switch. These checks walk every combination that matters, because
 * getting this wrong is invisible until two writers disagree about a hidden category.
 */
import {
  FRESHRSS_EXTENSION_CAPABILITIES,
  GREADER_CAPABILITIES,
  LOCAL_CAPABILITIES,
  features,
  resolveAll,
  resolveAuthority,
  upgradePitch,
  withDefaults,
} from "../../src/lib/capabilities.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS  ${name}${detail === undefined ? "" : `  (${detail})`}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

/* ---------------------------------------------------------------- the ladder */

check(
  "a service that supports a feature keeps it, paid or not",
  resolveAuthority("readState", { capabilities: GREADER_CAPABILITIES, paid: false }) === "backend" &&
    resolveAuthority("readState", { capabilities: GREADER_CAPABILITIES, paid: true }) === "backend",
);
check(
  "a feature the service cannot store goes to the cloud when paid",
  resolveAuthority("hiddenCategories", { capabilities: GREADER_CAPABILITIES, paid: true }) === "cloud",
);
check(
  "and stays on this device when not",
  resolveAuthority("hiddenCategories", { capabilities: GREADER_CAPABILITIES, paid: false }) === "local",
);
check(
  "every extended feature lands in the same place for one backend",
  features()
    .filter((f) => !GREADER_CAPABILITIES[f])
    .every((f) => resolveAuthority(f, { capabilities: GREADER_CAPABILITIES, paid: true }) === "cloud"),
);

/* ------------------------------------------------------- FreshRSS with extensions */

check(
  "FreshRSS with the extensions needs no subscription for any feature",
  features().every(
    (f) => resolveAuthority(f, { capabilities: FRESHRSS_EXTENSION_CAPABILITIES, paid: false }) === "backend",
  ),
);
check(
  "and paying would change nothing, so the pitch says nothing",
  upgradePitch({ capabilities: FRESHRSS_EXTENSION_CAPABILITIES, paid: false, server: true }) === "nothing",
);

/* --------------------------------------------------------------- FreshRSS bare */

check(
  "FreshRSS without the extensions leaves the extras unclaimed by the server",
  resolveAuthority("pinnedCategories", { capabilities: { ...GREADER_CAPABILITIES }, paid: false }) === "local",
  "pinnedCategories",
);

/* -------------------------------------------------------------- local library */

check(
  "a local library owns every feature itself",
  features().every((f) => resolveAuthority(f, { capabilities: LOCAL_CAPABILITIES, paid: false }) === "backend"),
);
check(
  "so the paid tier mirrors rather than replaces its authority",
  upgradePitch({ capabilities: LOCAL_CAPABILITIES, paid: false, server: false }) === "mirror",
);

/* ------------------------------------------------------- an Old Reader-shaped one */

const oldReader = { ...GREADER_CAPABILITIES, categoryOrder: true };
check(
  "a service that supports ordering keeps ordering",
  resolveAuthority("categoryOrder", { capabilities: oldReader, paid: false }) === "backend",
);
check(
  "and still hands the rest to the cloud, feature by feature",
  resolveAuthority("feedOrder", { capabilities: oldReader, paid: true }) === "cloud" &&
    resolveAuthority("pinnedCategories", { capabilities: oldReader, paid: true }) === "cloud",
);
check(
  "its pitch is about extras, not about mirroring",
  upgradePitch({ capabilities: oldReader, paid: false, server: true }) === "extras",
);

/* ------------------------------------------------------------------- defaults */

check(
  "an undeclared backend is treated as a plain GReader service",
  withDefaults(undefined).hiddenCategories === false && withDefaults(undefined).readState === true,
);
check(
  "a partial declaration only raises what it names",
  withDefaults({ feedOrder: true }).feedOrder === true &&
    withDefaults({ feedOrder: true }).hiddenCategories === false,
);
check(
  "resolveAll answers for every feature, once",
  Object.keys(resolveAll({ capabilities: GREADER_CAPABILITIES, paid: true })).length === features().length,
);

/* --------------------------------------------------------- what this must not do */

check(
  "no provider name appears in the model",
  !features().some((f) => /icloud|drive|dropbox|onedrive|stripe|apple|google/i.test(f)),
);
check(
  "the model is pure: no imports of state, store or network",
  (() => {
    const source = String(import.meta.resolve?.("../../src/lib/capabilities.ts") ?? "");
    return !/state\/|api\/|fetch\(/.test(source);
  })(),
);

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
