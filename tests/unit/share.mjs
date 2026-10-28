/**
 * Sharing one post: the sheet when the device has one, the link when it does
 * not.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/share.mjs
 *
 * Two things are being proved here, and neither is about the sheet itself —
 * there is no sheet in Node:
 *
 *   1. the order of the attempt. A cancelled sheet ends it (a clipboard line
 *      after someone pressed Cancel is something they refused), a sheet that
 *      refuses falls back to the copy, and a context with no sheet at all goes
 *      straight to the copy;
 *   2. the copy has a second route. The Tauri window is served from a custom
 *      scheme, which WebKit does not treat as secure, so `navigator.clipboard`
 *      can be missing where the app actually runs. `document.execCommand` is
 *      the route that does not care, and the fake document below proves it
 *      selects the field, runs, and removes the field whatever happens.
 *
 *   3. the app's own sheet. On iOS the same missing secure context takes Web
 *      Share with it, so the packaged app presents `UIActivityViewController`
 *      through the `share_sheet` command instead. The last block stands a stub
 *      of Tauri's IPC in place and proves the page sends that command, with the
 *      title, the link and the lead picture — and only on the iOS app, never on
 *      the desktop window.
 */
import {
  copyHost,
  copyText,
  isDismissal,
  legacyCopy,
  shareArticle,
  shareHost,
  sharePayload,
} from "../../src/lib/share.ts";

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A host that records what it was asked to do. */
function fakeHost({ native = null, share = null, copy = async () => true } = {}) {
  const calls = { native: [], shared: [], copied: [] };
  return {
    calls,
    host: {
      native:
        native === null
          ? null
          : async (data) => {
              calls.native.push(data);
              return native(data);
            },
      share:
        share === null
          ? null
          : async (data) => {
              calls.shared.push(data);
              return share(data);
            },
      copy: async (text) => {
        calls.copied.push(text);
        return copy(text);
      },
    },
  };
}

const named = (name) => Object.assign(new Error(name), { name });

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

const payload = sharePayload({ title: "  A post  ", url: "https://site.test/a" });
check("the title is trimmed", payload.title === "A post");
check("the link is carried whole", payload.url === "https://site.test/a");

// A blank title is a subject line to Mail and a heading to Messages; leaving it
// out lets the receiving app read the page instead.
check("a blank title is left out", !("title" in sharePayload({ title: "   ", url: "https://s.test/x" })));
check("an untitled post still shares its link", sharePayload({ title: "", url: "https://s.test/x" }).url === "https://s.test/x");

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

let run = await shareArticle(
  { title: "Post", url: "https://site.test/a" },
  fakeHost().host,
);
check("no sheet means the link is copied", run === "copied");

const withSheet = fakeHost({ share: async () => {} });
run = await shareArticle({ title: "Post", url: "https://site.test/a" }, withSheet.host);
check("a sheet is used when the context has one", run === "shared");
check(
  "the sheet gets the title and the link",
  withSheet.calls.shared.length === 1 &&
    withSheet.calls.shared[0].title === "Post" &&
    withSheet.calls.shared[0].url === "https://site.test/a",
);
check("nothing is copied when the sheet did it", withSheet.calls.copied.length === 0);

// Cancel is a decision, not a failure: nothing may land on the clipboard after it.
const cancelled = fakeHost({
  share: async () => {
    throw named("AbortError");
  },
});
run = await shareArticle({ title: "Post", url: "https://site.test/a" }, cancelled.host);
check("a dismissed sheet is cancelled, not failed", run === "cancelled");
check("and nothing is copied after it", cancelled.calls.copied.length === 0);

// A refusal is the case the fallback exists for: no activation, a policy, or a
// webview with no share target at all.
const refused = fakeHost({
  share: async () => {
    throw named("NotAllowedError");
  },
});
run = await shareArticle({ title: "Post", url: "https://site.test/a" }, refused.host);
check("a refused sheet falls back to the copy", run === "copied");
check("the URL is what is copied", refused.calls.copied[0] === "https://site.test/a");

const nowhere = fakeHost({ copy: async () => false });
run = await shareArticle({ title: "Post", url: "https://site.test/a" }, nowhere.host);
check("a copy with nowhere to go is a failure", run === "failed");

const empty = fakeHost({
  share: async () => true,
});
run = await shareArticle({ title: "Post", url: "   " }, empty.host);
check("a post with no link is not shared at all", run === "failed");
check("and the host is never asked", empty.calls.shared.length === 0 && empty.calls.copied.length === 0);

check("only AbortError counts as a dismissal", isDismissal(named("AbortError")));
check("a plain error does not", !isDismissal(named("NotAllowedError")));
check("nor does a string", !isDismissal("AbortError"));
check("nor null", !isDismissal(null));

// ---------------------------------------------------------------------------
// The app's own sheet
// ---------------------------------------------------------------------------

const ONE_POST = { title: "Post", url: "https://site.test/a" };
const WITH_PICTURE = { ...ONE_POST, image: "https://site.test/a.jpg" };

// The packaged iOS app is served from `tauri://localhost`, which is not a secure
// context, so Web Share is absent there and the UIKit bridge is the sheet.
const nativeSheet = fakeHost({ native: async () => {} });
run = await shareArticle(WITH_PICTURE, nativeSheet.host);
check("the app's own sheet is used when the build has one", run === "shared");
check("it is handed the headline, the link and the picture", (() => {
  const sent = nativeSheet.calls.native[0];
  return sent && sent.title === "Post" && sent.url === "https://site.test/a" && sent.image === "https://site.test/a.jpg";
})());
check(
  "and neither Web Share nor the copy is touched",
  nativeSheet.calls.shared.length === 0 && nativeSheet.calls.copied.length === 0,
);

// Both at once cannot happen on a device, and if it ever does the native sheet
// wins: it is the one that works without a secure context.
const bothSheets = fakeHost({ native: async () => {}, share: async () => {} });
run = await shareArticle(ONE_POST, bothSheets.host);
check("the native sheet wins when both are offered", bothSheets.calls.native.length === 1 && bothSheets.calls.shared.length === 0);

// A bridge that refuses — no window to present on, a link UIKit would not take
// — leaves the copy, and does not then try Web Share, whose activation the IPC
// round trip has already spent.
const nativeRefused = fakeHost({
  native: async () => {
    throw named("NoWindow");
  },
  share: async () => {},
});
run = await shareArticle(ONE_POST, nativeRefused.host);
check("a refusing bridge falls back to the copy", run === "copied");
check("with the link", nativeRefused.calls.copied[0] === "https://site.test/a");
check("and Web Share is not attempted after it", nativeRefused.calls.shared.length === 0);

const nativeNowhere = fakeHost({
  native: async () => {
    throw named("NoWindow");
  },
  copy: async () => false,
});
check("a refusing bridge with no clipboard is a failure", (await shareArticle(ONE_POST, nativeNowhere.host)) === "failed");

// The payload: a picture is an extra, so an absent one is absent, not empty.
check("a blank picture is left out of the payload", !("image" in sharePayload({ ...ONE_POST, image: "   " })));
check("a picture is carried whole", sharePayload({ ...ONE_POST, image: " https://site.test/i.jpg " }).image === "https://site.test/i.jpg");
check("an untitled post keeps its picture", sharePayload({ title: "", url: "https://s.test/x", image: "https://s.test/i.jpg" }).image === "https://s.test/i.jpg");

// ---------------------------------------------------------------------------
// The bridge, against a stub of Tauri's IPC
// ---------------------------------------------------------------------------
//
// This is the only place the command's name and its argument shape are checked
// from the page's side: `share_sheet` must match `src-tauri/src/share.rs`, and
// a rename on one side only would compile and do nothing.

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const realWindowValue = globalThis.window;
const realInternals = globalThis.__TAURI_INTERNALS__;

/** Pretend to be a webview: a user agent, and Tauri's injected object. */
function become({ ua, tauri }) {
  Object.defineProperty(globalThis, "navigator", {
    // A browser on the phone has Web Share; the app's webview does not, because
    // its own scheme is not a secure context.
    value: { userAgent: ua, maxTouchPoints: 5, share: tauri ? undefined : async () => {} },
    configurable: true,
    writable: true,
  });
  if (tauri) {
    const calls = [];
    const internals = {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return null;
      },
    };
    globalThis.__TAURI_INTERNALS__ = internals;
    globalThis.window = { __TAURI_INTERNALS__: internals, isSecureContext: false };
    return calls;
  }
  delete globalThis.__TAURI_INTERNALS__;
  globalThis.window = { isSecureContext: false };
  return null;
}

try {
  // An iPhone in a browser tab: Web Share, and no bridge to call.
  become({ ua: IOS_UA, tauri: false });
  const browserHost = shareHost();
  check("an iPhone browser tab has no native sheet", browserHost.native === null);
  check("and keeps Web Share", browserHost.share !== null);

  // The packed app on the same phone: the bridge, and the command's shape.
  const sent = become({ ua: IOS_UA, tauri: true });
  const appHost = shareHost();
  check("the iOS app has the native sheet", appHost.native !== null);
  await appHost.native({ title: "Post", url: "https://site.test/a", image: "https://site.test/a.jpg" });
  check("it calls share_sheet", sent[0]?.cmd === "share_sheet");
  check("with the title", sent[0]?.args.title === "Post");
  check("with the link", sent[0]?.args.url === "https://site.test/a");
  check("with the picture", sent[0]?.args.image === "https://site.test/a.jpg");
  await appHost.native({ url: "https://site.test/b" });
  check("a post with no picture sends an explicit null", sent[1]?.args.image === null);
  check("and an empty title, never undefined", sent[1]?.args.title === "");

  // A desktop window: no bridge, even though Tauri is there.
  const desktopSent = become({ ua: "Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0", tauri: true });
  check("the desktop window has no native sheet", shareHost().native === null);
  check("and calls nothing", desktopSent.length === 0);
} finally {
  if (realNavigator === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, "navigator", realNavigator);
  if (realWindowValue === undefined) delete globalThis.window;
  else globalThis.window = realWindowValue;
  if (realInternals === undefined) delete globalThis.__TAURI_INTERNALS__;
  else globalThis.__TAURI_INTERNALS__ = realInternals;
}

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

/** A host for the clipboard, with both routes recorded. */
function copyFake({ secure, write = null, legacy = true } = {}) {
  const calls = { written: [], legacy: [] };
  return {
    calls,
    host: {
      secure,
      write:
        write === null
          ? null
          : async (text) => {
              calls.written.push(text);
              return write(text);
            },
      legacy: (text) => {
        calls.legacy.push(text);
        return legacy;
      },
    },
  };
}

const secure = copyFake({ secure: true, write: async () => {} });
check("a secure page copies through the async API", (await copyText("x", secure.host)) === true);
check("and does not reach for the legacy route", secure.calls.legacy.length === 0);

// The webview case: `navigator.clipboard` may be there and still refuse, and the
// legacy route is what actually works.
const refusedWrite = copyFake({
  secure: true,
  write: async () => {
    throw named("NotAllowedError");
  },
});
check("a refusing async API falls back", (await copyText("x", refusedWrite.host)) === true);
check("through the legacy route", refusedWrite.calls.legacy.length === 1);

// No secure context at all — a Tauri window's custom scheme: the legacy route is
// taken first and synchronously, inside the click's own activation.
const insecure = copyFake({ secure: false, write: async () => {} });
check("an insecure page copies through the legacy route", (await copyText("x", insecure.host)) === true);
check("without touching the async API", insecure.calls.written.length === 0);

const nothing = copyFake({ secure: false, legacy: false });
check("and says so when it cannot", (await copyText("x", nothing.host)) === false);

// ---------------------------------------------------------------------------
// The legacy route, against a document that is only what it needs
// ---------------------------------------------------------------------------

function fakeDocument({ result = true, throws = false } = {}) {
  const made = [];
  const removed = [];
  let selected = 0;
  let ranged = 0;
  const doc = {
    created: made,
    body: {
      appendChild: (node) => made.push(node),
      removeChild: (node) => removed.push(node),
    },
    createElement: (tag) => {
      const element = {
        tag,
        value: "",
        style: {},
        attributes: {},
        setAttribute(name, value) {
          element.attributes[name] = value;
        },
        select() {
          selected += 1;
        },
        setSelectionRange(start, end) {
          ranged += 1;
          element.range = [start, end];
        },
      };
      return element;
    },
    execCommand: (command) => {
      if (throws) throw named("NotSupportedError");
      doc.command = command;
      return result;
    },
    removed,
    counts: () => ({ selected, ranged }),
  };
  return doc;
}

const real = globalThis.document;
try {
  const doc = fakeDocument();
  globalThis.document = doc;
  check("the legacy route reports the copy", legacyCopy("https://site.test/a") === true);
  check("it copies, rather than cutting or pasting", doc.command === "copy");
  check("it writes the whole link into the field", doc.created[0].value === "https://site.test/a");
  check("it selects the field before copying", doc.counts().selected === 1);
  check("and selects the whole range", doc.created[0].range[1] === "https://site.test/a".length);
  check("the field is off-screen, not laid out over the page", doc.created[0].style.position === "fixed");
  check("the field is removed again", doc.removed.length === 1);

  const refusing = fakeDocument({ result: false });
  globalThis.document = refusing;
  check("a refused copy is false, not a throw", legacyCopy("x") === false);
  check("and the field is still removed", refusing.removed.length === 1);

  const broken = fakeDocument({ throws: true });
  globalThis.document = broken;
  check("a browser without the command answers false", legacyCopy("x") === false);
  check("and leaves no field behind", broken.removed.length === 1);
} finally {
  if (real === undefined) delete globalThis.document;
  else globalThis.document = real;
}

// ---------------------------------------------------------------------------
// What this context has
// ---------------------------------------------------------------------------

// Node has a `navigator`, and it has no share sheet: the host must say so rather
// than hand back a function that throws when pressed.
check("a context with no sheet says so", shareHost().share === null);
// ... and no clipboard either, so a copy is honest about failing.
check("a context with no window is not secure", copyHost().secure === false);
check("and a copy there fails rather than throwing", (await copyText("x")) === false);

check("the unit suite itself stays in step", typeof globalThis.document === "undefined");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
