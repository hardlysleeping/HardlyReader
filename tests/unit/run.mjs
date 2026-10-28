// Runs every unit suite in its own Node process so one suite's globals, timers
// or thrown error cannot decide another suite's result, and so the exit code is
// the real one rather than the tail of a pipe.
import { readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

// Each suite compiles its Svelte/TS modules into `tests/unit/.gen-<pid>`, its own directory, because
// several runs happen at once here: the main tree, plus kanban workers in worktrees or in this same
// checkout. A shared `.gen` let one run overwrite another's generated module mid-import, which showed
// up as suites failing in a batch but passing alone. The directory is the run's own; nothing else can
// write to it.
//
// Leftovers are pruned only when their process is gone and they are over an hour old, so a failed
// run can still be inspected afterwards.
function pruneGenerated() {
  const now = Date.now();
  for (const name of readdirSync(here)) {
    if (!name.startsWith(".gen-")) continue;
    const dir = join(here, name);
    const pid = Number(name.slice(5));
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0); // probe only: session still running, keep its directory
        continue;
      } catch {}
    }
    if (now - statSync(dir).mtimeMs < 3_600_000) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}
pruneGenerated();

const helpers = new Set(["register-ts.mjs", "ts-resolve.mjs", "run.mjs"]);
const suites = readdirSync(here)
  .filter((name) => name.endsWith(".mjs") && !helpers.has(name))
  .sort();

let failed = [];
for (const suite of suites) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./register-ts.mjs", suite],
    { cwd: here, encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // The last line is sometimes a Node deprecation warning, not the result, so
  // prefer a line that actually reports checks.
  const lines = output.trim().split("\n").filter(Boolean);
  const summary =
    [...lines].reverse().find((line) => /checks|suites|passed|failure/i.test(line)) ??
    lines[lines.length - 1] ??
    "(no output)";
  console.log(`${result.status === 0 ? "ok  " : "FAIL"} ${suite.padEnd(20)} ${summary}`);
  if (result.status !== 0) {
    failed.push(suite);
    console.log(output);
  }
}

// Clean up after a green run; keep the directories when something failed, because that is when
// someone wants to read what was generated. The probe keeps a concurrent run's live directories.
if (!failed.length) {
  for (const name of readdirSync(here)) {
    if (!name.startsWith(".gen-")) continue;
    const pid = Number(name.slice(5));
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        continue;
      } catch {}
    }
    rmSync(join(here, name), { recursive: true, force: true });
  }
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`);
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
