// Runs every unit suite in its own Node process so one suite's globals, timers
// or thrown error cannot decide another suite's result, and so the exit code is
// the real one rather than the tail of a pipe.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
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
  const summary = output.trim().split("\n").filter(Boolean).pop() ?? "(no output)";
  console.log(`${result.status === 0 ? "ok  " : "FAIL"} ${suite.padEnd(20)} ${summary}`);
  if (result.status !== 0) {
    failed.push(suite);
    console.log(output);
  }
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`);
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
