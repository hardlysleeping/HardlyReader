/**
 * What the top of the phone says you are syncing with.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs service-name.mjs
 *
 * The bar used to name the app. The useful question on that screen is *which*
 * reader, so the label comes from the session: an API prefix, read back, never a
 * guessed product name. The prefix is what a session actually stores — see
 * `api/freshrss.ts`, "a prefix that answered, never a product name".
 */
import assert from "node:assert/strict";

import { headerLabel, serviceName } from "../../src/lib/service-name.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  if (typeof ok === "function") {
    try {
      ok();
      ok = true;
    } catch (error) {
      ok = false;
      detail = detail || (error instanceof Error ? error.message.split("\n")[0] : String(error));
    }
  }
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

check("FreshRSS is named by its own entry point", () => {
  assert.equal(serviceName("/api/greader.php", "https://reader.example"), "FreshRSS");
  // Behind a base path, the last segment is still the one that identifies it.
  assert.equal(serviceName("/freshrss/api/greader.php", "https://box.example"), "FreshRSS");
  assert.equal(serviceName("/API/GReader.php", "https://box.example"), "FreshRSS");
});

check("Miniflux is its GReader root, not any reader root", () => {
  assert.equal(serviceName("/v1/reader/api/0", "https://miniflux.example"), "Miniflux");
  assert.equal(serviceName("/miniflux/v1/reader/api/0", "https://box.example"), "Miniflux");
});

check("a prefix nobody claims gets the host, which is at least true", () => {
  assert.equal(serviceName("/reader/api/0", "https://oldreader.example:8080"), "oldreader.example:8080");
  assert.equal(serviceName("", "https://reader.example"), "reader.example");
  assert.equal(serviceName(null, "  "), "Sync");
});

check("a local library keeps the app's name", () => {
  // There is no service to name, and "On this device" is not one.
  assert.equal(headerLabel({ serverUrl: "On this device", apiPath: null, local: true }), "HardlyReader");
  assert.equal(headerLabel({ serverUrl: "", apiPath: null, local: false }), "HardlyReader");
  assert.equal(
    headerLabel({ serverUrl: "https://reader.example", apiPath: "/api/greader.php", local: false }),
    "FreshRSS",
  );
});

check("the word is short enough for the bar", () => {
  // The title has to leave room for three arrangement buttons, Aa, add, settings
  // and sync. A product name is a word; a URL is not.
  for (const name of ["FreshRSS", "Miniflux", "HardlyReader"]) {
    assert.ok(name.length <= 14, name);
  }
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
