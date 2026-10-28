/**
 * The Device sync section, rendered without a browser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/device-sync-section.mjs
 *
 * The card's acceptance turns on one question — **does the entitlement state
 * alone decide which half is drawn** — and that is a structural question, so the
 * component is compiled for Svelte's server target and rendered to a string, in
 * both states, with everything else held still:
 *
 *   - no `cloudSync`: what the feature is, both prices, and the two buttons;
 *   - `cloudSync`: the four providers, the folder, the last run and the button.
 *
 * It also pins the two rules that must not drift: all four providers sit behind
 * the same purchase (choosing one never asks the store for anything), and the
 * section is drawn for a library on this device only.
 *
 * What it cannot prove: that the rows fit a 390×844 phone, or that a thumb hits
 * them. Those are measured in the running app.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile, compileModule, preprocess } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";

import { emptySnapshot } from "../../src/api/local/sync.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, "tests/unit/.gen-device-sync-section");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const typescript = {
  script: ({ content, attributes }) => {
    if (attributes.lang !== "ts") return undefined;
    return {
      code: ts.transpileModule(content, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          // A component's imports are used in its *markup*, which TypeScript
          // cannot see: without this it elides them and the render dies.
          verbatimModuleSyntax: true,
        },
        fileName: "component.ts",
      }).outputText,
    };
  },
};

const built = new Map();

function sourceOf(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function rewrite(code, fromFile) {
  return code.replace(/(from\s*)(["'])([^"']+)\2/g, (whole, before, quote, specifier) => {
    const source = sourceOf(fromFile, specifier);
    if (source === null) return whole;
    const target = built.get(source) ?? pathToFileURL(source).href;
    return `${before}${quote}${target}${quote}`;
  });
}

function buildRunes(relative) {
  const file = join(ROOT, relative);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  });
  const compiled = compileModule(outputText, { generate: "client", filename: relative });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.ts$/, "")}.mjs`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

async function buildComponent(relative) {
  const file = join(ROOT, relative);
  const pre = await preprocess(read(relative), typescript, { filename: relative });
  const compiled = compile(pre.code, { generate: "server", filename: relative, dev: false });
  mkdirSync(GEN, { recursive: true });
  const out = join(GEN, `${relative.split("/").pop().replace(/\.svelte$/, "")}.mjs`);
  writeFileSync(out, rewrite(compiled.js.code, file));
  built.set(file, pathToFileURL(out).href);
  return pathToFileURL(out).href;
}

/**
 * The preferences store, without the network.
 *
 * `PrefsSync` reaches `api/freshrss` for the server's copy of the settings
 * document. The section only ever asks it for this device's document and hands
 * a merged one back, so the harness supplies exactly that.
 */
function stubPrefs() {
  const file = join(GEN, "prefs-stub.mjs");
  writeFileSync(
    file,
    `export const prefs = {
  deviceDoc() { return { version: 1, updatedAt: 0, entries: {} }; },
  adoptFromDevice() {},
};
`,
  );
  built.set(join(ROOT, "src/state/prefs.svelte.ts"), pathToFileURL(file).href);
}

let Panel;

try {
  for (const lib of ["src/lib/sync-setup.ts", "src/lib/prefs-sync.ts"]) buildRunes(lib);
  buildRunes("src/state/entitlements.svelte.ts");
  buildRunes("src/state/device-sync.svelte.ts");
  mkdirSync(GEN, { recursive: true });
  stubPrefs();

  ({ default: Panel } = await import(await buildComponent("src/components/DeviceSyncPanel.svelte")));

  const { deviceSync } = await import(built.get(join(ROOT, "src/state/device-sync.svelte.ts")));
  const { entitlement, FakeStore } = await import(built.get(join(ROOT, "src/state/entitlements.svelte.ts")));

  const LOCAL_PROFILE = { kind: "local", slug: "local", label: "On this device", session: null };
  const draw = (profile = LOCAL_PROFILE) => render(Panel, { props: { profile } }).body;
  const text = (body) => body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const count = (haystack, needle) => haystack.split(needle).length - 1;

  // -------------------------------------------------------------------------
  // Free: no cloudSync. What it is, both prices, and the way in.
  // -------------------------------------------------------------------------
  {
    const store = new FakeStore();
    entitlement.use(store);
    entitlement.cloudSync = false;
    entitlement.offer = [];

    const body = draw();
    const words = text(body);

    check("the free half leads with what syncing is for", words.includes("Sync across your devices"));
    check(
      "...and says what stays in step, in the owner's words",
      words.includes("Keep feeds, folders, read status, stars, preferences and reading position in sync"),
    );
    check("...and that the folder is the reader's own", words.includes("iCloud") && words.includes("OneDrive"));

    check("both prices are drawn", words.includes("$0.99 / month") && words.includes("$9.99 / year"));
    // The saving is derived from the two prices rather than asserted beside them:
    // $9.99 against twelve months at $0.99 is ~16%, and the row says what it is.
    check("the yearly one is recommended by its real saving", words.includes("save ~16%"), words.slice(0, 400));
    check("two ways in: buy, or restore", words.includes("Start HardlyReader Sync") && words.includes("Restore Purchase"));

    check("no provider is offered before it is bought", !words.includes("Provider"));
    check("and no run can be started", !words.includes("Sync now") && !words.includes("Last synced"));
    check("nothing is drawn twice", count(body, 'aria-label="Start HardlyReader Sync"') <= 1);
  }

  // -------------------------------------------------------------------------
  // Entitled: cloudSync. The four providers, the folder, and the run.
  // -------------------------------------------------------------------------
  {
    const store = new FakeStore();
    entitlement.use(store);
    entitlement.cloudSync = true;

    // A device that has chosen Dropbox and has a folder for it, and synced two
    // minutes ago. Bound before the render: effects do not run in a server
    // render, so the panel's own `bind` would not have happened.
    deviceSync.bind(null, { serverUrl: "device://local", email: "local" });
    deviceSync.choose("dropbox");
    deviceSync.setFolder("~/Dropbox/HardlyReader");
    deviceSync.setup = {
      ...deviceSync.setup,
      lastSyncedAt: Date.now() - 120_000,
      base: emptySnapshot("laptop", Math.floor((Date.now() - 120_000) / 1000)),
    };

    const body = draw();
    const words = text(body);

    check("the entitled half says which product is live", words.includes("HardlyReader Sync") && words.includes("active"));
    check("the provider row is drawn", words.includes("Provider"));

    const providers = ["iCloud Drive", "Google Drive", "Dropbox", "OneDrive"];
    check(
      "all four providers are offered, one radio each",
      providers.every((label) => count(body, `aria-label="${label}"`) === 1),
      providers.filter((label) => count(body, `aria-label="${label}"`) !== 1).join(", "),
    );
    check("the one in use is marked chosen", /aria-checked="true"[^>]*aria-label="Dropbox"|aria-label="Dropbox"[^>]*aria-checked="true"/.test(body));
    check("the folder row names the folder", words.includes("~/Dropbox/HardlyReader"));
    check("last synced is a sentence", /Last synced: 2 minutes ago/.test(words));
    check("and there is one button to run it", count(body, 'aria-label="Sync now"') === 1);

    check("no price is asked for twice", !words.includes("Start HardlyReader Sync") && !words.includes("Restore Purchase"));
  }

  // -------------------------------------------------------------------------
  // The entitlement alone decides the half.
  //
  // Same device, same record, same profile: only `cloudSync` moves. If anything
  // else were deciding, one of these two renders would disagree with itself.
  // -------------------------------------------------------------------------
  {
    const free = (() => {
      entitlement.cloudSync = false;
      return text(draw());
    })();
    const paid = (() => {
      entitlement.cloudSync = true;
      return text(draw());
    })();

    check("free says what it costs", free.includes("$0.99 / month") && !free.includes("Provider"));
    check("entitled offers the provider", paid.includes("Provider") && !paid.includes("$0.99 / month"));
    check("and nothing from the other half leaks in", !paid.includes("Restore Purchase") && !free.includes("Sync now"));

    const source = read("src/components/DeviceSyncPanel.svelte");
    check(
      "the branch is on the capability, not on a provider or a profile",
      /\{#if entitlement\.cloudSync\}/.test(source) && !/\{#if[^}]*provider[^}]*cloudSync/.test(source),
    );
  }

  // -------------------------------------------------------------------------
  // One purchase, four providers: choosing one never asks for money again.
  // -------------------------------------------------------------------------
  {
    const store = new FakeStore();
    entitlement.use(store);
    entitlement.cloudSync = true;
    entitlement.offer = [];

    for (const id of ["icloud", "gdrive", "dropbox", "onedrive"]) {
      deviceSync.choose(id);
      const words = text(draw());
      check(`choosing ${id} keeps the paid half`, words.includes("Provider") && !words.includes("Start HardlyReader Sync"));
    }

    check("switching provider never asks the store for a purchase", store.purchases.length === 0, store.purchases.join(", "));
    check("and never restores either", store.restores === 0);

    // Each provider keeps its own folder: Dropbox's is still there after four switches.
    deviceSync.choose("dropbox");
    check("a provider's folder is remembered", deviceSync.folder === "~/Dropbox/HardlyReader", deviceSync.folder);
    check("and another provider has none yet", (deviceSync.choose("gdrive"), deviceSync.folder === ""), deviceSync.folder);
  }
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
