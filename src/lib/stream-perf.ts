/**
 * How long a stream switch actually takes.
 *
 * "Feels fast" is not a measurement. Every switch is split into the three
 * things it can spend time on — the request (`fetch`), reading and parsing the
 * body (`parse`), and drawing the rows (`paint`) — and each sample is both a
 * `performance.mark`/`measure` pair (so the browser's own profiler shows it on
 * the same timeline as the frames) and a number in a small rolling bucket.
 *
 * The buckets keep the last few dozen samples per source and phase and report
 * p50/p95, which is the part worth reading: a single slow switch is noise, but
 * a p95 of 800ms is a bug.
 *
 * The clock is `performance.now()` because that is what marks are on. Nothing
 * here depends on a browser beyond that: given no `performance`, spans fall back
 * to `Date.now()` and simply record no marks.
 */

export type StreamPhase = "fetch" | "parse" | "paint";
/** `prefetch` is a hover or an unfolded category: real work, not a switch. */
export type StreamSource = "cache" | "network" | "prefetch";

export interface PhaseStats {
  /** Samples the figures are over. */
  n: number;
  p50: number;
  p95: number;
}

const MARK = "hardlyreader.stream";

function clock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function mark(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.mark(name);
}

function measure(name: string, start: string, end: string): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  try {
    performance.measure(name, start, end);
  } catch {
    // A webview without mark-name measures still gets the numbers below; the
    // devtools entry is the nice-to-have, not the point.
  }
}

/** A measure for a duration timed outside this module, ending now. */
function measureAt(name: string, start: number, end: number): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  try {
    performance.measure(name, { start, end });
  } catch {
    /* the sample is recorded either way */
  }
}

/** Nearest-rank percentile of a sample, 0 when there is nothing to rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)];
}

export function summarize(values: readonly number[]): PhaseStats {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

export class StreamPerf {
  private samples = new Map<string, number[]>();
  private seq = 0;
  private readonly buffer: number;

  constructor(buffer = 60) {
    this.buffer = buffer;
  }

  /**
   * Mark the start of a phase; call what comes back when it ends.
   *
   * The span owns both marks, so a caller cannot leave an end mark dangling
   * under the wrong name, and the pair is what the profiler draws.
   */
  span(phase: StreamPhase, source: StreamSource): () => void {
    const started = clock();
    const name = `${MARK}.${source}.${phase}.${(this.seq += 1)}`;
    mark(`${name}.start`);
    return () => {
      const ms = clock() - started;
      mark(`${name}.end`);
      measure(`${MARK}.${source}.${phase}`, `${name}.start`, `${name}.end`);
      this.record(phase, source, ms);
    };
  }

  /**
   * Record a duration measured elsewhere (the request layer owns the request
   * and the body read, so it reports both rather than being re-timed here).
   *
   * The browser still gets a measure entry, so those two phases sit on the same
   * timeline as the frames they belong to.
   */
  record(phase: StreamPhase, source: StreamSource, ms: number): void {
    const end = clock();
    measureAt(`${MARK}.${source}.${phase}`, end - ms, end);
    const key = `${source}:${phase}`;
    const bucket = this.samples.get(key);
    if (bucket === undefined) {
      this.samples.set(key, [ms]);
      return;
    }
    bucket.push(ms);
    if (bucket.length > this.buffer) bucket.splice(0, bucket.length - this.buffer);
  }

  stats(phase: StreamPhase, source: StreamSource): PhaseStats {
    return summarize(this.samples.get(`${source}:${phase}`) ?? []);
  }

  /** True before anything has been measured. */
  get empty(): boolean {
    return this.samples.size === 0;
  }

  /**
   * One line for the console: every phase that has samples, with its p50/p95.
   *
   * Cached and cold switches are reported separately, because they are
   * different promises: tens of milliseconds for one, hundreds for the other.
   */
  line(): string {
    const parts: string[] = [];
    for (const source of ["cache", "network", "prefetch"] as const) {
      for (const phase of ["fetch", "parse", "paint"] as const) {
        const stats = this.stats(phase, source);
        if (stats.n === 0) continue;
        parts.push(`${source} ${phase} p50 ${Math.round(stats.p50)}ms p95 ${Math.round(stats.p95)}ms (n=${stats.n})`);
      }
    }
    return parts.join(" · ");
  }
}
