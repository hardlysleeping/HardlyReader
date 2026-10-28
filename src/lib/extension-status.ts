/**
 * What the Extensions screen is allowed to say.
 *
 * The measurement already exists: `probeCapabilities()` in `src/api/hardlyread.ts` asks the
 * adapter for its state and answers with a report of `supported | unsupported | unknown` per
 * feature plus one of three outcomes. This file turns that answer into rows a person can act on
 * and decides nothing else — no fetching, no version sniffing, no second opinion about what a
 * server supports.
 *
 * Three rules, because this screen is the one a reader consults when something is silently not
 * working:
 *
 * 1. **Unknown is never working.** A probe that got no answer says so; it does not borrow the
 *    previous answer, and it does not guess.
 * 2. **"Not installed" and "switched off" are one sentence.** The wire reports both as a block
 *    whose `available` is false, and an older adapter as an unsupported feature. Splitting them
 *    would be a guess dressed as a diagnosis.
 * 3. **A row is only fixable when installing something fixes it.** A server that cannot host the
 *    adapter at all is not four install jobs.
 */

/** The pieces a reader can install, in the order the screen draws them. */
export type ExtensionId = "adapter" | "hidden" | "pinned" | "preferences";

/**
 * `unavailable` is the server's own answer ("this is not FreshRSS"), `needs-adapter` is "the
 * adapter has to exist before this can be measured", and `missing` is the only one that carries
 * an install link.
 */
export type ExtensionState =
  | "working"
  | "missing"
  | "needs-adapter"
  | "unknown"
  | "unavailable";

export interface ExtensionRow {
  id: ExtensionId;
  state: ExtensionState;
}

/** What the probe said. Mirrors `CapabilityAnswer` without importing it, so this stays pure. */
export interface ExtensionProbe {
  /** Whether the session's API prefix is FreshRSS's, i.e. whether the adapter can exist here. */
  freshRss: boolean;
  outcome: "answer" | "missing" | "unreachable";
  /** The per-feature report from that answer. Missing keys mean "not asked". */
  report: Partial<Record<"hiddenCategories" | "pinnedCategories" | "preferences", string>>;
}

export const EXTENSION_IDS: readonly ExtensionId[] = ["adapter", "hidden", "pinned", "preferences"];

/** One feature's report as a row state. Absent or unrecognised reads as `unknown`, never as working. */
function stateOf(value: string | undefined): ExtensionState {
  if (value === "supported") return "working";
  if (value === "unsupported") return "missing";
  return "unknown";
}

/**
 * The rows for one answer.
 *
 * Order matters: the adapter is the precondition for the other three, so a screen that lists them
 * in this order reads top-down as "is the door there, then is each room".
 */
export function extensionRows(probe: ExtensionProbe): ExtensionRow[] {
  // A server that cannot host the adapter is one fact, said once per row rather than one row and
  // three blanks: the answer is the same for all four, and the words for it live in the panel.
  if (!probe.freshRss) {
    return EXTENSION_IDS.map((id) => ({ id, state: "unavailable" as const }));
  }
  if (probe.outcome === "unreachable") {
    return EXTENSION_IDS.map((id) => ({ id, state: "unknown" as const }));
  }
  if (probe.outcome === "missing") {
    // FreshRSS answered, but the adapter's routes are not there: nothing behind them can be
    // measured yet, so the three extensions are not "missing" — they are waiting on the adapter.
    return EXTENSION_IDS.map((id) => ({
      id,
      state: id === "adapter" ? ("missing" as const) : ("needs-adapter" as const),
    }));
  }
  return [
    { id: "adapter", state: "working" },
    { id: "hidden", state: stateOf(probe.report.hiddenCategories) },
    { id: "pinned", state: stateOf(probe.report.pinnedCategories) },
    { id: "preferences", state: stateOf(probe.report.preferences) },
  ];
}

/** Whether this row's own install link is the fix. Only the one state where that is true. */
export function isFixable(row: ExtensionRow): boolean {
  return row.state === "missing";
}

/** A one-line summary for a collapsed section, so the state is visible without opening it. */
export function summarize(rows: readonly ExtensionRow[]): string {
  if (rows.length === 0) return "";
  if (rows.every((row) => row.state === "working")) return "All working";
  if (rows.every((row) => row.state === "unavailable")) return "Not available here";
  if (rows.some((row) => row.state === "unknown")) return "Could not tell";
  const missing = rows.filter((row) => row.state === "missing").length;
  if (missing === 1) return "1 needs installing";
  if (missing > 1) return `${missing} need installing`;
  if (rows.some((row) => row.state === "needs-adapter")) return "Needs the adapter";
  return "";
}
