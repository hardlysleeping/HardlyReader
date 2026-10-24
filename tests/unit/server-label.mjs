import { serverLabel } from "../../src/lib/server-label.ts";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// What the bar shows: host and port, because that is what tells two servers apart.
check("a plain host and port", serverLabel("http://127.0.0.1:8081") === "127.0.0.1:8081");
check("a tailnet HTTPS address", serverLabel("https://freshrss.tail1234.ts.net:8449") === "freshrss.tail1234.ts.net:8449");
check("no scheme, no slash", serverLabel("10.0.0.10:2099") === "10.0.0.10:2099");
// A path is a detail of where the API lives, not which box it is.
check("a trailing slash goes", serverLabel("https://example.com/") === "example.com");
check("a path goes with it", serverLabel("https://example.com/freshrss/") === "example.com");
check("an API path goes too", serverLabel("https://example.com/freshrss/api/greader.php") === "example.com");
check("a query goes", serverLabel("https://example.com?x=1") === "example.com");
check("surrounding spaces go", serverLabel("  https://example.com  ") === "example.com");
check("uppercase scheme", serverLabel("HTTPS://example.com:443") === "example.com:443");
// Blank is blank: the bar renders nothing rather than an empty chip.
check("nothing in, nothing out", serverLabel("") === "");
check("whitespace in, nothing out", serverLabel("   ") === "");
// Unparseable is still shown: an odd address on screen is a clue.
check("an odd entry survives", serverLabel("example.com//") === "example.com");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
