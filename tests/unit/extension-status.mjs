/**
 * Checks for the Extensions screen's model.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/extension-status.mjs
 *
 * The model is what decides the words a reader acts on, so the cases here are the answer shapes
 * `probeCapabilities()` can return — nothing is stubbed beyond the probe's own answer, and no
 * component is rendered: what the panel draws is the panel's business, what it may *claim* is
 * this file's.
 */
import {
  EXTENSION_IDS,
  extensionRows,
  isFixable,
  summarize,
} from "../../src/lib/extension-status.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    const suffix = detail === undefined ? "" : ` — ${detail}`;
    console.log(`FAIL  ${label}${suffix}`);
  }
}

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.state]));

// --- a FreshRSS that answers everything ------------------------------------------------------
{
  const rows = extensionRows({
    freshRss: true,
    outcome: "answer",
    report: { hiddenCategories: "supported", pinnedCategories: "supported", preferences: "supported" },
  });
  const states = byId(rows);
  check("every row is working when every feature answers", Object.values(states).every((s) => s === "working"), JSON.stringify(states));
  check("the rows are the four the screen draws", rows.map((row) => row.id).join(",") === EXTENSION_IDS.join(","));
  check("nothing is fixable when nothing is missing", rows.every((row) => !isFixable(row)));
  check("the summary says all working", summarize(rows) === "All working", summarize(rows));
}

// --- the adapter answers, but the category extensions do not ---------------------------------
{
  const rows = extensionRows({
    freshRss: true,
    outcome: "answer",
    report: { hiddenCategories: "unsupported", pinnedCategories: "supported", preferences: "unsupported" },
  });
  const states = byId(rows);
  check("the adapter row is still working", states.adapter === "working", states.adapter);
  check("an unsupported feature is missing, not unknown", states.hidden === "missing", states.hidden);
  check("a supported feature beside it is working", states.pinned === "working", states.pinned);
  check("the indent row follows its own feature", states.preferences === "missing", states.preferences);
  check("missing rows carry the install link", rows.filter((row) => isFixable(row)).map((r) => r.id).join(",") === "hidden,preferences");
  check("the summary counts what needs installing", summarize(rows) === "2 need installing", summarize(rows));
}

// --- FreshRSS, adapter routes absent ---------------------------------------------------------
{
  const rows = extensionRows({ freshRss: true, outcome: "missing", report: {} });
  const states = byId(rows);
  check("an absent adapter is missing", states.adapter === "missing", states.adapter);
  check("the three extensions wait on the adapter instead of claiming to be missing", ["hidden", "pinned", "preferences"].every((id) => states[id] === "needs-adapter"), JSON.stringify(states));
  check("only the adapter row offers an install link", rows.filter((row) => isFixable(row)).map((r) => r.id).join(",") === "adapter");
  check("the summary says the adapter is what is needed", summarize(rows) === "1 needs installing", summarize(rows));
}

// --- no answer at all ------------------------------------------------------------------------
{
  const rows = extensionRows({ freshRss: true, outcome: "unreachable", report: {} });
  check("an unreachable server is unknown everywhere, never working", rows.every((row) => row.state === "unknown"), JSON.stringify(byId(rows)));
  check("nothing is offered as an install when the answer never arrived", rows.every((row) => !isFixable(row)));
  check("the summary admits it could not tell", summarize(rows) === "Could not tell", summarize(rows));
}

// --- a server that cannot host the adapter ---------------------------------------------------
{
  const rows = extensionRows({ freshRss: false, outcome: "missing", report: {} });
  check("a non-FreshRSS server is one fact on every row", rows.every((row) => row.state === "unavailable"), JSON.stringify(byId(rows)));
  check("and it is not four install jobs", rows.every((row) => !isFixable(row)));
  check("the summary says it is not available here", summarize(rows) === "Not available here", summarize(rows));
}

// --- what the model must never do ------------------------------------------------------------
{
  const partial = extensionRows({ freshRss: true, outcome: "answer", report: {} });
  check("a report with no feature keys is unknown, not working", partial.slice(1).every((row) => row.state === "unknown"), JSON.stringify(byId(partial)));

  const odd = extensionRows({ freshRss: true, outcome: "answer", report: { hiddenCategories: "yes-please", pinnedCategories: undefined } });
  check("an unrecognised state reads as unknown", byId(odd).hidden === "unknown", byId(odd).hidden);
  check("an absent key reads as unknown", byId(odd).pinned === "unknown", byId(odd).pinned);

  check("an empty row list summarises to nothing rather than to a claim", summarize([]) === "");
}

console.log(`extension-status: ${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
