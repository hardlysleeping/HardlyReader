/**
 * E2E scenario against a real FreshRSS container, driven by
 * tests/integration/run.sh.
 *
 * Black box on purpose: it speaks the wire protocol with fetch() and does not
 * import src/api/hardlyread.ts, so a bug in the client module cannot hide a
 * broken server contract (the unit suites already cover the client). No
 * dependencies, so it runs on whatever Node the CI image happens to carry.
 *
 *   HARDLYREAD_E2E_BASE_URL   default http://127.0.0.1:18081
 *   HARDLYREAD_STORE_DUMP     optional shell command printing the extension's
 *                             own store as JSON; when set, the final state is
 *                             compared against it
 *
 * Exit code 0 only when every check passed.
 */

import { execFileSync } from "node:child_process";

const BASE = process.env.HARDLYREAD_E2E_BASE_URL ?? "http://127.0.0.1:18081";
const USER = "itest";
const API_PASSWORD = "hardlyread-test-password";
const API = `${BASE}/api/misc.php/Hardly%20Read/v1`;
const STORE_DUMP = process.env.HARDLYREAD_STORE_DUMP ?? "";

/** Fixture ids seeded by provision.php `config`. */
const CATEGORIES = [
  [101, "E2E Alpha"],
  [102, "E2E Beta"],
  [103, "E2E Gamma"],
];

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
  }
  const suffix = detail === "" ? "" : `  (${detail})`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`);
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function api(path, { method = "GET", token = null, body = undefined } = {}) {
  const headers = {};
  if (token !== null) {
    headers.Authorization = `GoogleLogin auth=${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

async function login() {
  const response = await fetch(`${BASE}/api/greader.php/accounts/ClientLogin`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Email: USER, Passwd: API_PASSWORD }).toString(),
  });
  const body = await response.text();
  if (response.status !== 200) {
    throw new Error(`ClientLogin answered ${response.status}: ${body.slice(0, 200)}`);
  }
  const match = /^Auth=(.*)$/m.exec(body);
  if (match === null || match[1].trim() === "") {
    throw new Error("ClientLogin response carried no Auth token");
  }
  return match[1].trim();
}

/** Runs the store dump command, if the harness supplied one. */
function storeDump() {
  if (STORE_DUMP === "") {
    return null;
  }
  const output = execFileSync("bash", ["-lc", STORE_DUMP], { encoding: "utf8" });
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`store dump printed no JSON: ${output.slice(0, 400)}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

const state = (response) => response.json?.hiddenCategories ?? {};

async function main() {
  console.log(`E2E target: ${API}`);

  const token = await login();
  check("ClientLogin issues an API token", /^itest\/[0-9a-f]{40}$/.test(token), token.slice(0, 12) + "…");

  // --- authentication before routing -------------------------------------
  const anonymous = await api("/state");
  check("GET /v1/state without a credential is 401", anonymous.status === 401, String(anonymous.status));
  check("…with the unauthorized code", anonymous.json?.error?.code === "unauthorized", String(anonymous.json?.error?.code));
  check(
    "…and the GReader hint header",
    anonymous.headers.get("google-bad-token") === "true",
    String(anonymous.headers.get("google-bad-token")),
  );

  const forged = await api("/state", { token: `itest/${"0".repeat(40)}` });
  check("GET /v1/state with a forged token is 401", forged.status === 401, String(forged.status));

  // --- initial state ------------------------------------------------------
  const initial = await api("/state", { token });
  check("GET /v1/state authenticated is 200", initial.status === 200, String(initial.status));
  check("apiVersion is 1", initial.json?.apiVersion === 1, String(initial.json?.apiVersion));

  const hidden = state(initial);
  check("Hidden Categories is installed and available", hidden.available === true, String(hidden.available));
  check("the extension is unlocked", hidden.locked === false, String(hidden.locked));
  check("the extension is in light mode", hidden.mode === "light", String(hidden.mode));
  check("the view starts at hidden", hidden.view === "hidden", String(hidden.view));
  check("nothing is hidden at the start", same(hidden.hiddenIds, []), JSON.stringify(hidden.hiddenIds));

  for (const [id, name] of CATEGORIES) {
    const row = (hidden.categories ?? []).find((entry) => entry.id === id);
    check(`fixture category ${id} is listed as ${name}`, row?.name === name, JSON.stringify(row ?? null));
    check(`fixture category ${id} starts visible`, row?.hidden === false, JSON.stringify(row ?? null));
  }

  const favorites = initial.json?.favorites ?? null;
  check("Pinned Categories is installed and available", favorites?.available === true, JSON.stringify(favorites));
  check("nothing is pinned at the start", same(favorites?.ids ?? null, []), JSON.stringify(favorites?.ids ?? null));
  check("the favourites view starts at all", favorites?.view === "all", String(favorites?.view));
  check(
    "Sidebar Feed Indent is absent, and reported unavailable",
    initial.json?.sidebarIndent?.available === false,
    JSON.stringify(initial.json?.sidebarIndent ?? null),
  );

  // --- routing and validation --------------------------------------------
  const wrongMethod = await api("/hidden-categories/101", { token });
  check("GET on a category route is 405", wrongMethod.status === 405, String(wrongMethod.status));
  check("…with Allow: PUT", wrongMethod.headers.get("allow") === "PUT", String(wrongMethod.headers.get("allow")));

  const unknown = await api("/nope", { token });
  check("an unknown route is 404", unknown.status === 404 && unknown.json?.error?.code === "route_not_found", String(unknown.status));

  const nonBoolean = await api("/hidden-categories/101", { method: "PUT", token, body: { hidden: "yes" } });
  check(
    "a non-boolean hidden value is 400",
    nonBoolean.status === 400 && nonBoolean.json?.error?.code === "invalid_hidden_value",
    String(nonBoolean.status),
  );

  const zeroId = await api("/hidden-categories/0", { method: "PUT", token, body: { hidden: true } });
  check("category 0 is 400", zeroId.status === 400 && zeroId.json?.error?.code === "invalid_category", String(zeroId.status));

  const nonNumeric = await api("/hidden-categories/abc", { method: "PUT", token, body: { hidden: true } });
  check(
    "a non-numeric category id is 400",
    nonNumeric.status === 400 && nonNumeric.json?.error?.code === "invalid_category",
    String(nonNumeric.status),
  );

  const absent = await api("/hidden-categories/999", { method: "PUT", token, body: { hidden: true } });
  check(
    "an absent category is 404",
    absent.status === 404 && absent.json?.error?.code === "category_not_found",
    String(absent.status),
  );

  // --- the round trip -----------------------------------------------------
  const hide = await api("/hidden-categories/101", { method: "PUT", token, body: { hidden: true } });
  check("hiding category 101 is 200", hide.status === 200, String(hide.status));
  check("…and reports changed", hide.json?.changed === true, String(hide.json?.changed));
  check("…with 101 in the authoritative state", same(state(hide).hiddenIds, [101]), JSON.stringify(state(hide).hiddenIds));
  check(
    "…and 101 flagged hidden in the category list",
    state(hide).categories?.find((entry) => entry.id === 101)?.hidden === true,
    JSON.stringify(state(hide).categories?.find((entry) => entry.id === 101) ?? null),
  );

  const repeat = await api("/hidden-categories/101", { method: "PUT", token, body: { hidden: true } });
  check("hiding it again is 200", repeat.status === 200, String(repeat.status));
  check("…and reports no change", repeat.json?.changed === false, String(repeat.json?.changed));
  check("…with 101 still the only hidden category", same(state(repeat).hiddenIds, [101]), JSON.stringify(state(repeat).hiddenIds));

  const afterHide = await api("/state", { token });
  check("a fresh GET still reports 101 hidden", same(state(afterHide).hiddenIds, [101]), JSON.stringify(state(afterHide).hiddenIds));

  const only = await api("/hidden-categories/view", { method: "PUT", token, body: { view: "only" } });
  check("switching to the only-hidden view is 200", only.status === 200, String(only.status));
  check("…and the effective view is only", state(only).effectiveView === "only", String(state(only).effectiveView));

  const revealed = await api("/hidden-categories/view", { method: "PUT", token, body: { view: "revealed" } });
  check("switching to the revealed view is 200", revealed.status === 200, String(revealed.status));
  check("…and the effective view is revealed", state(revealed).effectiveView === "revealed", String(state(revealed).effectiveView));

  const back = await api("/hidden-categories/view", { method: "PUT", token, body: { view: "hidden" } });
  check("switching back to hidden is 200", back.status === 200, String(back.status));
  check("…and the effective view is hidden", state(back).effectiveView === "hidden", String(state(back).effectiveView));
  check("…and 101 is still hidden", same(state(back).hiddenIds, [101]), JSON.stringify(state(back).hiddenIds));

  const badView = await api("/hidden-categories/view", { method: "PUT", token, body: { view: "bogus" } });
  check("an unknown view is 400", badView.status === 400 && badView.json?.error?.code === "invalid_view", String(badView.status));

  // --- pinning, against a real Pinned Categories --------------------------
  const noPin = await api("/favorites/999", { method: "PUT", token, body: { favorite: true } });
  check(
    "pinning an absent category is 404",
    noPin.status === 404 && noPin.json?.error?.code === "category_not_found",
    `${noPin.status} ${String(noPin.json?.error?.code)}`,
  );

  const pin = await api("/favorites/101", { method: "PUT", token, body: { favorite: true } });
  check("pinning category 101 is 200", pin.status === 200, String(pin.status));
  check("…and reports changed", pin.json?.changed === true, String(pin.json?.changed));

  const pinAgain = await api("/favorites/101", { method: "PUT", token, body: { favorite: true } });
  check("pinning it again is 200", pinAgain.status === 200, String(pinAgain.status));
  check("…and reports no change", pinAgain.json?.changed === false, String(pinAgain.json?.changed));

  const afterPin = (await api("/state", { token })).json?.favorites;
  check("a fresh GET reports 101 pinned", same(afterPin?.ids, [101]), JSON.stringify(afterPin?.ids ?? null));
  check(
    "…and 101 flagged in the category list",
    afterPin?.categories?.find((entry) => entry.id === 101)?.favorite === true,
    JSON.stringify(afterPin?.categories?.find((entry) => entry.id === 101) ?? null),
  );

  const onlyPinned = await api("/favorites/view", { method: "PUT", token, body: { view: "only" } });
  check("switching to the pinned-only view is 200", onlyPinned.status === 200, String(onlyPinned.status));
  check(
    "…and a fresh GET reports it",
    (await api("/state", { token })).json?.favorites?.view === "only",
    String((await api("/state", { token })).json?.favorites?.view),
  );

  const badFavoritesView = await api("/favorites/view", { method: "PUT", token, body: { view: "bogus" } });
  check(
    "an unknown favourites view is 400",
    badFavoritesView.status === 400 && badFavoritesView.json?.error?.code === "invalid_view",
    `${badFavoritesView.status} ${String(badFavoritesView.json?.error?.code)}`,
  );

  // Pinning and hiding are different facts about one category: setting one must
  // not disturb the other. 101 is hidden by the section above when this runs.
  const both = await api("/state", { token });
  check(
    "a category can be pinned and hidden at the same time",
    (both.json?.favorites?.ids ?? []).includes(101) && state(both).hiddenIds.includes(101),
    JSON.stringify({ favorites: both.json?.favorites?.ids ?? null, hidden: state(both).hiddenIds }),
  );

  const unpin = await api("/favorites/101", { method: "PUT", token, body: { favorite: false } });
  check("unpinning 101 is 200", unpin.status === 200, String(unpin.status));
  check(
    "…and nothing is pinned",
    same((await api("/state", { token })).json?.favorites?.ids, []),
    JSON.stringify((await api("/state", { token })).json?.favorites?.ids ?? null),
  );

  const backToAll = await api("/favorites/view", { method: "PUT", token, body: { view: "all" } });
  check("switching the favourites view back is 200", backToAll.status === 200, String(backToAll.status));

  // --- unhide -------------------------------------------------------------
  const unhide = await api("/hidden-categories/101", { method: "PUT", token, body: { hidden: false } });
  check("unhiding 101 is 200", unhide.status === 200, String(unhide.status));
  check("…and reports changed", unhide.json?.changed === true, String(unhide.json?.changed));
  check("…with nothing hidden", same(state(unhide).hiddenIds, []), JSON.stringify(state(unhide).hiddenIds));

  const final = await api("/state", { token });
  check("the final state is empty and unlocked", same(state(final).hiddenIds, []) && state(final).locked === false, JSON.stringify(state(final).hiddenIds));

  // --- the extension's own store ----------------------------------------
  const dump = storeDump();
  if (dump === null) {
    console.log("SKIP  store cross-check (HARDLYREAD_STORE_DUMP is not set)");
  } else {
    console.log(`store: ${dump.store} hidden=${JSON.stringify(dump.hiddenIds)} view=${dump.view}`);
    check("the extension's own store holds no hidden category", same(dump.hiddenIds, []), JSON.stringify(dump.hiddenIds));
    check("the extension's own store is back at view hidden", dump.view === "hidden", String(dump.view));
    check("no passcode is set, so the harness stays unlocked", dump.passcodeSet === false, String(dump.passcodeSet));
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  return failures === 0;
}

main()
  .then((ok) => {
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(`E2E aborted: ${error?.stack ?? error}`);
    process.exit(1);
  });
