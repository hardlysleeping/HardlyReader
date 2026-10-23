/**
 * Unit checks for feed icon resolution.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/feedicon.mjs
 *
 * The rewrite rule is the point: FreshRSS hands out icon URLs built from the
 * host its web UI was loaded on, which is frequently not the host this client
 * can reach. Getting this wrong shows every feed as a broken image.
 */
import { feedHue, feedIconSrc, feedInitial } from "../../src/lib/feedicon.ts";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === "" ? "" : `  (${detail})`}`);
  }
}

const TAILNET = "https://cenvalweb.example.ts.net:8449";

check("missing icon is undefined", feedIconSrc(undefined, TAILNET) === undefined);
check("empty icon is undefined", feedIconSrc("   ", TAILNET) === undefined);

check(
  "external icon is left alone",
  feedIconSrc("https://cdn.example.com/i.png", TAILNET) === "https://cdn.example.com/i.png",
);

check(
  "loopback icon borrows the reachable origin",
  feedIconSrc("http://localhost:18080/freshrss/f.php?h=1&p=1", TAILNET) ===
    `${TAILNET}/freshrss/f.php?h=1&p=1`,
);

check(
  "127.0.0.1 icon borrows the reachable origin",
  feedIconSrc("http://127.0.0.1/f.php?h=2", TAILNET) === `${TAILNET}/f.php?h=2`,
);

check(
  "a loopback server keeps its own loopback icon",
  feedIconSrc("http://localhost:18080/f.php?h=1", "http://localhost:18080/freshrss") ===
    "http://localhost:18080/f.php?h=1",
);

check(
  "root-relative icon resolves against the server",
  feedIconSrc("/freshrss/f.php?h=3", TAILNET) === `${TAILNET}/freshrss/f.php?h=3`,
);

check(
  "non-http icon is rejected",
  feedIconSrc("javascript:alert(1)", TAILNET) === undefined,
);

check(
  "unparseable icon is rejected",
  feedIconSrc("http://", TAILNET) === undefined,
);

const smallData = `data:image/png;base64,${"A".repeat(100)}`;
check("small inline icon is kept", feedIconSrc(smallData, TAILNET) === smallData);
check(
  "huge inline icon is dropped",
  feedIconSrc(`data:image/png;base64,${"A".repeat(200_001)}`, TAILNET) === undefined,
);

check("initial is the first letter", feedInitial("The Verge") === "T");
check("initial skips punctuation", feedInitial("  «kottke»") === "K");
check("initial handles digits", feedInitial("404 Media") === "4");
check("initial falls back for empty titles", feedInitial("   ") === "?");

check("hue is stable", feedHue("The Verge") === feedHue("The Verge"));
check("hue is in range", feedHue("Anything at all") >= 0 && feedHue("Anything at all") < 360);
check("different titles differ", feedHue("Rust Blog") !== feedHue("The Verge"));

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  process.exitCode = 1;
}
