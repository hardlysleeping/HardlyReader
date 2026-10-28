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
  adapterCarries,
  adapterCeiling,
  capabilitiesFromState,
  explainAuthority,
  features,
  remember,
  resolveAll,
  resolveAuthority,
  upgradePitch,
  wholeReport,
  withDefaults,
} from "../../src/lib/capabilities.ts";
import { GReaderBackend } from "../../src/api/greader-backend.ts";

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
  "FreshRSS with the extensions needs no subscription for any feature it carries",
  features()
    .filter((feature) => feature !== "readingPosition")
    .every(
      (feature) => resolveAuthority(feature, { capabilities: FRESHRSS_EXTENSION_CAPABILITIES, paid: false }) === "backend",
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

/* ------------------------------------------------ a backend that can flip its answer
 *
 * The three states are only distinguishable by what a *failing* server does, so these
 * checks drive the real probe (`GReaderBackend.probeCapabilities`) through a transport
 * whose answer can be flipped between a live adapter, a 404, a restart, a timeout and an
 * offline socket. Nothing here mocks the probe: the code under test is the code that
 * ships, and the fake is the network.
 */

const SESSION = {
  serverUrl: "https://reader.example",
  apiPath: "/api/greader.php",
  email: "someone@example.com",
  token: "SECRET-TOKEN",
};

const EXTENDED = features().filter((feature) => !GREADER_CAPABILITIES[feature]);

/**
 * The extras a v1 adapter answers.
 *
 * `EXTENDED` is what a GReader service lacks; this is what an adapter of that version
 * actually has a route for. The reading position is in the first list and in no version's
 * routes at all, which is exactly the distinction the checks below turn on.
 */
const CARRIED = adapterCeiling(1);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A live adapter's `/v1/state`, with both block extensions reporting themselves. */
function stateBody(overrides = {}) {
  return {
    apiVersion: 1,
    hiddenCategories: {
      available: true,
      mode: "",
      view: "hidden",
      effectiveView: "hidden",
      hiddenIds: [1],
      locked: false,
      hasPasscode: false,
      categories: [{ id: 1, name: "Design", hidden: true }],
    },
    favorites: { available: true, view: "all", ids: [2], categories: [{ id: 2, name: "Design", favorite: true }] },
    sidebarIndent: { available: true, px: 12, max: 60 },
    peopleAvailable: false,
    pins: [],
    ...overrides,
  };
}

/** One transport per state of the world. A mode not listed here is a bug in the suite. */
function flipTransport(mode) {
  return async (url) => {
    switch (mode) {
      case "supports":
        return json(200, stateBody());
      case "disabled":
        // The adapter is installed and enabled; the two block extensions are not.
        return json(
          200,
          stateBody({
            hiddenCategories: { available: false },
            favorites: { available: false },
          }),
        );
      case "old":
        // An adapter from before the version field: it answers, but claims no version.
        return json(200, stateBody({ apiVersion: undefined }));
      case "missing":
        return json(404, { error: { code: "route_not_found", message: "Unknown route." } });
      case "restarting":
        return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      case "offline":
        throw new TypeError("fetch failed");
      case "timeout":
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      case "unauthorized":
        return json(401, { error: { code: "auth", message: "Token rejected" } });
      default:
        throw new Error(`flipTransport: no such mode ${mode}`);
    }
  };
}

/**
 * A backend whose answer can be flipped, as the shape the app holds.
 *
 * It delegates to the real `GReaderBackend`, so `flip("restarting")` is a real 502
 * travelling through the real probe.
 */
class FlipBackend {
  constructor(mode = "supports") {
    this.mode = mode;
    this.kind = "greader";
    this.probes = 0;
  }

  flip(mode) {
    this.mode = mode;
    return this;
  }

  probeCapabilities() {
    this.probes += 1;
    const inner = new GReaderBackend(flipTransport(this.mode), SESSION);
    return inner.probeCapabilities();
  }
}

{
  // The walk every check below uses: probe, fold the answer into what we believe, then
  // resolve each feature with *both* — the belief and the fresh report.
  const state = async (backend, { believed = {}, paid = false } = {}) => {
    const answer = await backend.probeCapabilities();
    const belief = remember(believed, answer.report);
    const authority = {};
    for (const feature of features()) {
      authority[feature] = resolveAuthority(feature, {
        capabilities: belief,
        paid,
        observed: answer.report,
      });
    }
    return { answer, belief, authority };
  };

  /* --------------------------------------------------------------- 1. supported */

  const live = await state(new FlipBackend("supports"));
  check(
    "supported: a live adapter measures every extended feature it carries as supported",
    live.answer.outcome === "answer" && CARRIED.every((f) => live.answer.report[f] === "supported"),
  );
  check(
    "supported: and each one is the backend's, paid or not",
    CARRIED.every((f) => live.authority[f] === "backend"),
  );

  /* ------------------------------------------------------------- 2. unsupported */

  const absent = await state(new FlipBackend("missing"), { paid: false });
  check(
    "unsupported: a 404 on the route is a definite no, not a failure to check",
    absent.answer.outcome === "missing" && EXTENDED.every((f) => absent.answer.report[f] === "unsupported"),
  );
  check(
    "unsupported: so a free reader keeps the feature on this device",
    EXTENDED.every((f) => absent.authority[f] === "local"),
  );
  const absentPaid = await state(new FlipBackend("missing"), { paid: true });
  check(
    "unsupported: and a paid one may hand it to the cloud, because the server truly has nowhere to put it",
    EXTENDED.every((f) => absentPaid.authority[f] === "cloud"),
  );

  const disabled = await state(new FlipBackend("disabled"), { paid: false });
  check(
    "unsupported: an extension installed but disabled is a no for its own feature only",
    disabled.answer.report.hiddenCategories === "unsupported" &&
      disabled.answer.report.pinnedCategories === "unsupported" &&
      disabled.answer.report.preferences === "supported",
  );

  /* ----------------------------------------------------------------- 3. unknown */

  // The trap: this server owns these features and is restarting for ten seconds.
  const restarting = await state(new FlipBackend("restarting"), {
    believed: FRESHRSS_EXTENSION_CAPABILITIES,
    paid: true,
  });
  check(
    "unknown: a 5xx is not an answer about capability",
    restarting.answer.outcome === "unreachable" && EXTENDED.every((f) => restarting.answer.report[f] === "unknown"),
  );
  check(
    "unknown: and the paid reader's server-owned features do NOT jump to the cloud",
    CARRIED.every((f) => restarting.authority[f] === "backend"),
    `hiddenCategories=${restarting.authority.hiddenCategories}`,
  );
  check(
    "unknown: the belief is left exactly as the last good read left it",
    EXTENDED.every((f) => restarting.belief[f] === FRESHRSS_EXTENSION_CAPABILITIES[f]),
  );

  for (const mode of ["offline", "timeout", "unauthorized"]) {
    const dark = await state(new FlipBackend(mode), { believed: FRESHRSS_EXTENSION_CAPABILITIES, paid: true });
    check(
      `unknown: ${mode} is an absence of an answer too, and nothing moves`,
      dark.answer.outcome === "unreachable" && CARRIED.every((f) => dark.authority[f] === "backend"),
    );
  }

  // Nothing remembered yet: unknown must still not invent an authority. The answer has
  // to equal the answer when no check ran at all.
  const cold = await state(new FlipBackend("offline"), { believed: {}, paid: false });
  check(
    "unknown: with nothing remembered it changes nothing either",
    features().every(
      (f) => cold.authority[f] === resolveAuthority(f, { capabilities: {}, paid: false }),
    ),
  );
  const coldPaid = await state(new FlipBackend("offline"), { believed: {}, paid: true });
  check(
    "unknown: including on a paid device, where the cloud would be the tempting answer",
    features().every(
      (f) => coldPaid.authority[f] === resolveAuthority(f, { capabilities: {}, paid: true }),
    ),
  );

  /* ------------------------------------------------- 4. extension version negotiation */

  const old = await state(new FlipBackend("old"), { believed: {}, paid: false });
  check(
    "version: an adapter that reports no version reports fewer capabilities",
    old.answer.outcome === "answer" && EXTENDED.every((f) => old.answer.report[f] === "unsupported"),
  );
  check(
    "version: so the extras stay where they were instead of 404ing at the first write",
    EXTENDED.every((f) => old.authority[f] === "local"),
  );
  check(
    "version: the ceiling only grows with the version, and stops at what a route carries",
    adapterCeiling(0).length === 0 &&
      CARRIED.every((f) => adapterCeiling(1).includes(f)) &&
      !adapterCeiling(1).includes("readingPosition"),
    `v0=${adapterCeiling(0).length} v1=${adapterCeiling(1).length}`,
  );
  check(
    "version: a version that carries the route still needs the extension's own available flag",
    capabilitiesFromState({ apiVersion: 1, hiddenCategories: { available: false }, favorites: { available: true } })
      .hiddenCategories === "unsupported",
  );

  /* --------------------------------------- 5. the fold, the explanation, the pitch */

  check(
    "remember: an answer moves a feature, and unknown is dropped on the floor",
    remember({ hiddenCategories: true }, { hiddenCategories: "unknown", pinnedCategories: "unsupported" })
      .hiddenCategories === true &&
      remember({ hiddenCategories: true }, { pinnedCategories: "unsupported" }).pinnedCategories === false,
  );
  check(
    "a fresh answer can raise a feature the declaration never named",
    resolveAuthority("hiddenCategories", {
      capabilities: {},
      paid: true,
      observed: { hiddenCategories: "supported" },
    }) === "backend",
  );
  const explained = explainAuthority("hiddenCategories", {
    capabilities: FRESHRSS_EXTENSION_CAPABILITIES,
    paid: true,
    observed: restarting.answer.report,
  });
  check(
    "the UI may say 'could not check' while the authority stays where it was",
    explained.couldNotCheck === true && explained.checked === "unknown" && explained.authority === "backend",
  );
  check(
    "and the same answer read as a plain decision still says backend",
    resolveAuthority("hiddenCategories", {
      capabilities: FRESHRSS_EXTENSION_CAPABILITIES,
      paid: true,
      observed: restarting.answer.report,
    }) === "backend",
  );
  check(
    "a server nobody could check is not sold an upgrade for features it may already have",
    upgradePitch({ capabilities: {}, paid: false, server: true, observed: wholeReport("unknown") }) === "nothing",
  );

  /* -------------------------------------- 6. a server that cannot host the adapter */

  let asked = 0;
  const notFreshRss = new GReaderBackend(
    async () => {
      asked += 1;
      return json(200, {});
    },
    { ...SESSION, apiPath: "/v1/reader/api/0" },
  );
  const notAnAdapter = await notFreshRss.probeCapabilities();
  check(
    "a non-FreshRSS server is a definite no, and is not asked at all",
    notAnAdapter.outcome === "missing" &&
      asked === 0 &&
      EXTENDED.every((f) => notAnAdapter.report[f] === "unsupported"),
  );
}



/* ---------------------------------- 7. the place: an extra no adapter has a route for
 *
 * `/v1/positions` is the arrangement — category ids, feed ids — and `/v1/preferences` is
 * three namespaces of settings. Neither carries where the reader was, and there is no
 * third route, so a declaration that claimed the place would be a claim about a route
 * that does not exist. The assertion that keeps it true is the first one here: a
 * declaration may name exactly the extras some adapter version answers.
 */

{
  check(
    "a declaration claims exactly the extras an adapter has a route for",
    EXTENDED.every((feature) => FRESHRSS_EXTENSION_CAPABILITIES[feature] === adapterCarries(feature)),
    `carried=${CARRIED.join(",")}`,
  );
  check(
    "the reading position is the extra no version carries",
    adapterCarries("readingPosition") === false &&
      FRESHRSS_EXTENSION_CAPABILITIES.readingPosition === false &&
      CARRIED.length === EXTENDED.length - 1,
    `extended=${EXTENDED.length} carried=${CARRIED.length}`,
  );
  check(
    "so on a FreshRSS profile the place is this device's, free or paid",
    resolveAuthority("readingPosition", { capabilities: FRESHRSS_EXTENSION_CAPABILITIES, paid: false }) === "local" &&
      resolveAuthority("readingPosition", { capabilities: FRESHRSS_EXTENSION_CAPABILITIES, paid: true }) === "cloud",
  );
  check(
    "and the measurement agrees at every version, v0 and v1 alike",
    capabilitiesFromState({ apiVersion: 0 }).readingPosition === "unsupported" &&
      capabilitiesFromState({
        apiVersion: 1,
        hiddenCategories: { available: true },
        favorites: { available: true },
      }).readingPosition === "unsupported" &&
      capabilitiesFromState({
        apiVersion: 99,
        hiddenCategories: { available: true },
        favorites: { available: true },
      }).readingPosition === "unsupported",
  );
  check(
    "the place is still local for a local library, which is where the document carries it",
    resolveAuthority("readingPosition", { capabilities: LOCAL_CAPABILITIES, paid: false }) === "backend",
  );
  check(
    "and it is not counted as a gap a purchase fills for a server",
    upgradePitch({ capabilities: FRESHRSS_EXTENSION_CAPABILITIES, paid: false, server: true }) === "nothing",
  );
}

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
