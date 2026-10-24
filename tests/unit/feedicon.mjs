/**
 * Unit checks for feed icon resolution.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/feedicon.mjs
 *
 * Three things here are load-bearing:
 *
 *   - the rewrite. FreshRSS hands out icon URLs built from the host its web UI
 *     was loaded on (`localhost:18080` in the native app, an internal port
 *     behind a proxy), which this client cannot reach and which a browser on
 *     https refuses as mixed content. Only the path may survive.
 *   - the seam. `third-party` exists for feeds with no FreshRSS behind them and
 *     must never be reached unless a caller chooses it.
 *   - the fallback. A feed with no icon, or one whose image fails, draws a
 *     letter chip — never a broken-image frame, and never a second request on
 *     every render.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FAVICON_TEMPLATE,
  feedIcon,
  feedIconImage,
  feedIconSource,
  feedInitial,
  feedHue,
  markFeedIconBroken,
  resetFeedIconCache,
} from "../../src/lib/feedicon.ts";

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

const SERVER = "https://freshrss.example.net:8449";
const ICON = "http://localhost:18080/freshrss/f.php?h=abc123";

/* ---------------------------------------------------------------------------
 * The freshrss provider: the path is the server's, the origin is the session's
 * ------------------------------------------------------------------------- */

const local = feedIconSource({ id: "feed/1", title: "Ars", iconUrl: ICON }, { serverUrl: SERVER });
check(
  "a loopback icon is re-homed onto the configured server",
  local !== undefined && local.startsWith(`${SERVER}/freshrss/f.php?h=abc123`),
  String(local),
);
check("...over the server's own scheme, so no mixed content", local?.startsWith("https://") === true, String(local));

// The configured server is the only host this client can reach, and every
// subscription icon is served from it, whatever host FreshRSS thinks it is.
const otherHost = feedIconSource(
  { id: "feed/2", title: "Internal", iconUrl: "https://feeds.internal.example/f.php?h=9" },
  { serverUrl: SERVER },
);
check(
  "an icon naming another public host is re-homed too",
  otherHost?.startsWith(`${SERVER}/f.php?h=9`) === true,
  String(otherHost),
);

const relative = feedIconSource({ id: "feed/3", title: "Rel", iconUrl: "/f.php?h=rel" }, { serverUrl: SERVER });
check(
  "a root-relative icon resolves against the server",
  relative?.startsWith(`${SERVER}/f.php?h=rel`) === true,
  String(relative),
);

const based = feedIconSource(
  { id: "feed/4", title: "Based", iconUrl: "f.php?h=beside" },
  { serverUrl: `${SERVER}/freshrss` },
);
check(
  "a sibling icon resolves inside the server's own path",
  based?.startsWith(`${SERVER}/freshrss/f.php?h=beside`) === true,
  String(based),
);

const localServer = feedIconSource(
  { id: "feed/5", title: "Dev", iconUrl: "http://localhost:18080/f.php?h=1" },
  { serverUrl: "http://localhost:18080" },
);
check(
  "a dev server keeps its own loopback icon",
  localServer?.startsWith("http://localhost:18080/f.php?h=1") === true,
  String(localServer),
);

const inline = `data:image/png;base64,${"A".repeat(100)}`;
check(
  "an inline icon is kept as it is",
  feedIconSource({ title: "Inline", iconUrl: inline }, { serverUrl: SERVER }) === inline,
);
check(
  "a huge inline icon is dropped",
  feedIconSource({ title: "Huge", iconUrl: `data:image/png;base64,${"A".repeat(200_001)}` }, {
    serverUrl: SERVER,
  }) === undefined,
);

/* ---------------------------------------------------------------------------
 * No request when the provider has nothing to point at
 * ------------------------------------------------------------------------- */

check(
  "a feed with no icon yields no URL",
  feedIconSource({ title: "No icon" }, { serverUrl: SERVER }) === undefined,
);
check(
  "a blank icon yields no URL",
  feedIconSource({ title: "Blank", iconUrl: "   " }, { serverUrl: SERVER }) === undefined,
);
check(
  "a non-http icon is refused",
  feedIconSource({ title: "Script", iconUrl: "javascript:alert(1)" }, { serverUrl: SERVER }) === undefined,
);
check(
  "an unparseable icon is refused",
  feedIconSource({ title: "Broken", iconUrl: "http://" }, { serverUrl: SERVER }) === undefined,
);
check(
  "no session yet means no host to trust, so no request",
  feedIconSource({ title: "Ars", iconUrl: ICON }, { serverUrl: "" }) === undefined,
);
check(
  "an unparseable server means no request",
  feedIconSource({ title: "Ars", iconUrl: ICON }, { serverUrl: "not a url" }) === undefined,
);

const chip = feedIcon({ title: "404 Media" });
check("the fallback is the initial", chip.initial === "4", chip.initial);
check("...and there is no image behind it", chip.src === undefined, String(chip.src));
check("...with a stable hue", chip.hue === feedHue("404 Media") && chip.hue >= 0 && chip.hue < 360);
check(
  "feedIcon and the source agree on an icon with nothing to show",
  feedIcon({ title: "Nothing" }, { serverUrl: SERVER }).src === undefined,
);

/* ---------------------------------------------------------------------------
 * The third-party seam: present, and silent unless it is chosen
 * ------------------------------------------------------------------------- */

const feed = {
  id: "feed/9",
  title: "Local Blog",
  htmlUrl: "https://local.example/blog",
  iconUrl: ICON,
};

const freshrss = feedIconSource(feed, { serverUrl: SERVER });
check(
  "by default the icon comes from the configured server",
  freshrss?.startsWith(`${SERVER}/`) === true,
  String(freshrss),
);
check(
  "by default no third-party host appears at all",
  freshrss !== undefined && !freshrss.includes("duckduckgo") && !freshrss.includes("icons."),
  String(freshrss),
);

// Passing a template is not the same as choosing the provider: the seam is the
// provider, so a template alone must still produce nothing.
const templateOnly = feedIconSource(
  { title: "No icon, has a site", htmlUrl: "https://local.example/blog" },
  { serverUrl: SERVER, template: "https://icons.example.test/{host}.png" },
);
check("a template alone enables nothing", templateOnly === undefined, String(templateOnly));

const third = feedIconSource(feed, { serverUrl: SERVER, provider: "third-party" });
check(
  "choosing third-party asks the favicon service for the feed's own site",
  third?.startsWith("https://icons.duckduckgo.com/ip3/local.example.ico") === true,
  String(third),
);
check(
  "...and not the FreshRSS host the subscription named",
  third?.includes("freshrss.example.net") === false && third?.includes("localhost") === false,
  String(third),
);

const custom = feedIconSource(feed, {
  serverUrl: SERVER,
  provider: "third-party",
  template: "https://icons.example.test/{host}.png",
});
check(
  "a caller can point third-party at another service",
  custom?.startsWith("https://icons.example.test/local.example.png") === true,
  String(custom),
);

check(
  "a template with no {host} is not a per-feed request",
  feedIconSource(feed, {
    serverUrl: SERVER,
    provider: "third-party",
    template: "https://icons.example.test/all.png",
  }) === undefined,
);
check(
  "a feed with no site yields no third-party request",
  feedIconSource(
    { title: "No site", iconUrl: ICON },
    { serverUrl: SERVER, provider: "third-party" },
  ) === undefined,
);
check(
  "a site without a scheme yields no third-party request",
  feedIconSource(
    { title: "Schemeless", url: "local.example" },
    { serverUrl: SERVER, provider: "third-party" },
  ) === undefined,
);
check(
  "the third-party icon is the same shape for every feed that uses it",
  feedIconSource(feed, { serverUrl: SERVER, provider: "third-party" })?.includes(FAVICON_TEMPLATE.split("{host}")[0]) ===
    true,
);

/* ---------------------------------------------------------------------------
 * One resolution per feed, one URL per icon
 * ------------------------------------------------------------------------- */

resetFeedIconCache();
const first = feedIcon(feed, { serverUrl: SERVER });
const again = feedIcon({ ...feed }, { serverUrl: SERVER });
check("a feed's mark is resolved once and handed back by identity", first === again);
check(
  "the URL is the same string on every call, so nothing refetches",
  feedIconSource(feed, { serverUrl: SERVER }) === feedIconSource(feed, { serverUrl: SERVER }),
);

check(
  "the URL carries a per-feed token",
  /[?&]v=[a-z0-9]+$/.test(first.src ?? ""),
  String(first.src),
);

const one = feedIconSource({ id: "feed/1", title: "One", iconUrl: "/f.php?h=shared" }, { serverUrl: SERVER });
const two = feedIconSource({ id: "feed/2", title: "Two", iconUrl: "/f.php?h=shared" }, { serverUrl: SERVER });
check(
  "two feeds sharing an icon URL still get different cache keys",
  one !== two && one !== undefined && two !== undefined,
  `${one} / ${two}`,
);
check(
  "the token follows a changed icon, so a stale copy is refetched",
  feedIconSource({ ...feed, iconUrl: "/f.php?h=old" }, { serverUrl: SERVER }) !==
    feedIconSource({ ...feed, iconUrl: "/f.php?h=new" }, { serverUrl: SERVER }),
);
check(
  "an inline icon is not given a token it cannot carry",
  feedIconSource({ id: "feed/8", title: "Inline", iconUrl: inline }, { serverUrl: SERVER }) === inline,
);

/* ---------------------------------------------------------------------------
 * A source that fails is dropped, not framed
 * ------------------------------------------------------------------------- */

const icon = feedIcon(feed, { serverUrl: SERVER });
const working = icon.src ?? "";

check("a loadable icon is drawn", feedIconImage(icon, {}) === working);
const broken = markFeedIconBroken({}, working);
check("a failed icon is remembered against its URL", broken[working] === true);
check("...and is dropped, so the row draws its initial instead", feedIconImage(icon, broken) === undefined);
check("...without re-rendering on a repeated error", markFeedIconBroken(broken, working) === broken);
check(
  "another feed's icon is unaffected by one failure",
  feedIconImage(feedIcon({ id: "feed/3", title: "Fine", iconUrl: "/f.php?h=fine" }, { serverUrl: SERVER }), broken) !==
    undefined,
);
check(
  "a feed that later gets a new icon is tried again",
  feedIconImage(feedIcon({ ...feed, iconUrl: "/f.php?h=new" }, { serverUrl: SERVER }), broken) !== undefined,
);
check(
  "a feed with no image at all has nothing to draw",
  feedIconImage(feedIcon({ title: "Chip only" }, { serverUrl: SERVER }), {}) === undefined,
);

/* ---------------------------------------------------------------------------
 * The real sidebar row
 *
 * The rules above are the decision; these say the component actually obeys
 * them — one resolver per row, a lazy image, and a letter chip in the branch
 * the image falls into. The same row markup is what the one-pane layout draws
 * (`inlinePosts`), so both surfaces get the same mark.
 * ------------------------------------------------------------------------- */

const here = dirname(fileURLToPath(import.meta.url));
const sidebar = readFileSync(join(here, "../../src/components/Sidebar.svelte"), "utf8");

check(
  "the row resolves its mark once, through feedIcon",
  sidebar.includes("{@const icon = iconFor(feed)}") && sidebar.includes("{@const mark = feedIconImage(icon, brokenIcons)}"),
);
check("the row never calls the resolver inline in the image", !sidebar.includes("src={iconFor("));
check(
  "the image is drawn behind the failure gate",
  /\{#if mark !== undefined\}\s*<img\s+class="icon"/.test(sidebar),
);
check(
  "the image is lazy and async",
  /<img\s+class="icon"[\s\S]{0,200}loading="lazy"[\s\S]{0,200}decoding="async"/.test(sidebar),
);
check(
  "a failed image is dropped rather than left as a frame",
  sidebar.includes("onerror={() => (brokenIcons = markFeedIconBroken(brokenIcons, mark))}"),
);
check(
  "the other branch is the initial chip, so there is no broken-image glyph",
  /\{:else\}\s*<span class="icon letter" style="--hue: \{icon\.hue\}"/.test(sidebar),
);
check(
  "one row markup serves both sidebar surfaces",
  sidebar.split('<img\n                class="icon"').length - 1 === 1,
);

const css = /\n {2}\.icon \{([\s\S]*?)\n {2}\}/.exec(sidebar)?.[1] ?? "";
check("the icon is 16px square", /width: 16px/.test(css) && /height: 16px/.test(css), css.trim());
check("...rounded 4px", /border-radius: 4px/.test(css), css.trim());
check(
  "...in a fixed column, so the label does not jump between image and chip",
  /flex: 0 0 16px/.test(css),
  css.trim(),
);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  process.exitCode = 1;
}
