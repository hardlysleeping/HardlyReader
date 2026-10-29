/**
 * The Saved text section, rendered without a browser.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/saved-text-section.mjs
 *
 * Two questions this suite answers, and they are the two the card turns on:
 * **does the reader see the three answers and the ceiling**, and **is the
 * disclosure there in words** — a body is fetched from the publisher's own page,
 * so the request carries this device's address into that publisher's log, and a
 * library on this device has no server standing in front of it.
 *
 * The panel is compiled for Svelte's server target and rendered to a string, with
 * the store set the way the reader would have set it. Effects do not run in a
 * server render, so `bodies.bind()` is not needed: the fields it fills are set
 * directly, which is also the only way to render "12 articles" without a disk.
 *
 * What it cannot prove: that the rows fit a 390×844 phone, or that a thumb hits
 * them. Those are measured in the running app.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile, compileModule, preprocess } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = join(ROOT, `tests/unit/.gen-${process.pid}/saved-text`);

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

let Panel;

try {
  buildRunes("src/lib/images.ts");
  buildRunes("src/lib/image-cache.ts");
  buildRunes("src/state/bodies.svelte.ts");
  buildRunes("src/state/pictures.svelte.ts");
  ({ default: Panel } = await import(await buildComponent("src/components/BodyPanel.svelte")));

  const { bodies, showsSavedText } = await import(
    built.get(join(ROOT, "src/state/bodies.svelte.ts"))
  );
  const { pictures } = await import(built.get(join(ROOT, "src/state/pictures.svelte.ts")));

  const MIB = 1024 * 1024;
  const draw = () => render(Panel).body;
  const text = (body) => body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const count = (haystack, needle) => haystack.split(needle).length - 1;
  /** The one button a group has pressed, by its words. */
  const pressed = (body) => [...body.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((m) => m[1].trim());

  // -------------------------------------------------------------------------
  // The section is for a library on this device, and for nothing else.
  // -------------------------------------------------------------------------
  check("a library on this device draws it", showsSavedText({ kind: "local" }) === true);
  check("a server's library does not", showsSavedText({ kind: "greader" }) === false);
  check("and neither does no profile at all", showsSavedText(null) === false);

  // -------------------------------------------------------------------------
  // The three answers, off by default, and the ceiling with its default.
  // -------------------------------------------------------------------------
  {
    bodies.mode = "off";
    bodies.limit = 24 * MIB;
    bodies.count = 0;
    bodies.bytes = 0;
    bodies.note = null;

    const body = draw();
    const words = text(body);

    check("the three answers are drawn, in order", words.startsWith("Saved text Off On open Ahead"), words.slice(0, 120));
    check("off is what a fresh device shows", pressed(body).includes("Off"), pressed(body).join(","));
    check("and the other two are not pressed", !pressed(body).includes("On open") && !pressed(body).includes("Ahead"));

    check("the space is offered as three sizes", count(body, ">8 MB<") === 1 && count(body, ">24 MB<") === 1 && count(body, ">64 MB<") === 1);
    check("24 MB is the size a fresh device holds", pressed(body).includes("24 MB"), pressed(body).join(","));
    check("nothing kept says so, and what it may hold", words.includes("No saved text — up to 24 MB can be kept"));
    check("the group is labelled for a screen reader", count(body, 'aria-label="What article text this device keeps"') === 1 && count(body, 'aria-label="How much article text this device keeps"') === 1);
  }

  // -------------------------------------------------------------------------
  // The pictures: their own row, their own words, their own ceiling.
  // -------------------------------------------------------------------------
  {
    pictures.mode = "thumbs";
    pictures.limit = 200 * MIB;
    pictures.count = 0;
    pictures.bytes = 0;
    pictures.note = null;

    const body = draw();
    const words = text(body);

    check(
      "the pictures are their own row, with their own three answers",
      words.includes("Saved pictures Off Thumbnails Everything"),
      words.slice(0, 200),
    );
    check("thumbnails is what a fresh device keeps", pressed(body).includes("Thumbnails"), pressed(body).join(","));
    check(
      "the pictures have their own ceiling",
      count(body, ">100 MB<") === 1 && count(body, ">200 MB<") === 1 && count(body, ">500 MB<") === 1,
    );
    check("and their own sentence about what is held", words.includes("No saved pictures — up to 200 MB can be kept"));
    check(
      "the group is labelled for a screen reader",
      count(body, 'aria-label="What pictures this device keeps"') === 1 &&
        count(body, 'aria-label="How many picture bytes this device keeps"') === 1,
    );

    pictures.setMode("all");
    pictures.setLimit(100 * MIB);
    pictures.count = 204;
    pictures.bytes = Math.round(2.4 * MIB);
    const chosen = draw();
    check("a choice made elsewhere is what is drawn", pressed(chosen).includes("Everything") && pressed(chosen).includes("100 MB"), pressed(chosen).join(","));
    check("and what is held is said in pictures and bytes", text(chosen).includes("204 pictures, 2.4 MB of 100 MB"), text(chosen).slice(-200));

    pictures.mode = "thumbs";
    pictures.limit = 200 * MIB;
    pictures.count = 0;
    pictures.bytes = 0;
  }

  // -------------------------------------------------------------------------
  // The disclosure: who sees the request. Not a tooltip, not a link.
  // -------------------------------------------------------------------------
  {
    const words = text(draw());
    check("the panel says where a body comes from", words.includes("fetched from the publisher's own page"), words.slice(0, 300));
    check("...that the address is in that publisher's log", words.includes("this device's address into that publisher's log"));
    check("...and that nothing stands in between here", words.includes("a library on this device has nothing in between"));
    check("ahead says what it costs", words.includes("prepares the posts just after the one you are reading"));
    check("a picture's request is disclosed in words too", words.includes("A saved picture comes from the same server"));
    check("and the sync file is said to carry no articles", words.includes("the sync file carries feeds"));
  }

  // -------------------------------------------------------------------------
  // The store drives the panel: a choice made anywhere else is what is drawn.
  // -------------------------------------------------------------------------
  {
    bodies.setMode("ahead");
    bodies.setLimit(8 * MIB);
    bodies.count = 12;
    bodies.bytes = 1.2 * MIB;

    const body = draw();
    const words = text(body);

    check("the answer that was chosen is the one pressed", pressed(body).includes("Ahead") && !pressed(body).includes("Off"), pressed(body).join(","));
    check("and so is the size", pressed(body).includes("8 MB") && !pressed(body).includes("24 MB"), pressed(body).join(","));
    check("what is held is said in articles and bytes", words.includes("12 articles, 1.2 MB of 8 MB"), words.slice(0, 300));
    check("nothing is drawn twice", count(body, 'aria-label="What article text this device keeps"') === 1);
  }

  // -------------------------------------------------------------------------
  // A pass that cleared something says so, in one line under the rows.
  // -------------------------------------------------------------------------
  {
    bodies.note = "Cleared 3 old articles to stay inside the space — 2.4 MB freed.";
    check("the clear is reported", text(draw()).includes("Cleared 3 old articles"));
    bodies.note = null;
    check("and takes itself away", !text(draw()).includes("Cleared 3 old articles"));
  }
} finally {
  // The tree the suite generated is scratch, like every other harness here.
  const { rmSync } = await import("node:fs");
  rmSync(GEN, { recursive: true, force: true });
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
