#!/usr/bin/env node
/**
 * Build `src/lib/icons/generated.ts` from the curated list.
 *
 *   node scripts/gen-icons.mjs            # write the file
 *   node scripts/gen-icons.mjs --check    # fail if it is stale, write nothing
 *
 * The glyphs come from `lucide-static`, which is a **dev** dependency and is
 * never imported by the app: this script runs on a workstation, the generated
 * module is committed, and so `pnpm build` needs neither the package nor a
 * network. That is the shape the "icons are inlined paths, never a package"
 * rule keeps — a package may supply the catalogue, the build may not depend on
 * one.
 *
 * Only geometry survives: the outer `<svg>` is dropped and every child's
 * presentational attributes (`stroke`, `fill`, `stroke-width`, `class`, …) go
 * with it, so one `<Glyph>` owns the weight, the size and the colour and every
 * icon in the app is drawn by the same hand. Lucide's own geometry elements are
 * kept as they are: several glyphs are circles, rects or lines rather than
 * paths, and rewriting those into `d` strings would be invention.
 *
 * The file carries its licence header because it is a redistribution of ISC
 * artwork.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const setPath = join(here, "icon-set.txt");
const iconsDir = join(root, "node_modules/lucide-static/icons");
const outPath = join(root, "src/lib/icons/generated.ts");

/** Attributes that are geometry; everything else is presentation and is dropped. */
const GEOMETRY = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "rx",
  "ry",
  "points",
]);

const names = readFileSync(setPath, "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter((line) => line.length > 0);

if (!existsSync(iconsDir)) {
  console.error(
    `no lucide-static at ${iconsDir} — run \`pnpm install\` (it is a dev dependency on purpose)`,
  );
  process.exit(1);
}

const available = new Set(readdirSync(iconsDir).filter((file) => file.endsWith(".svg")).map((file) => file.slice(0, -4)));
const missing = names.filter((name) => !available.has(name));
if (missing.length > 0) {
  // A silent drop here is how a category ends up with no glyph and a test that
  // still passes: the set is the input, so a name that is not there is an error.
  console.error(`not in lucide-static@${version()}: ${missing.join(", ")}`);
  process.exit(1);
}

const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
if (duplicates.length > 0) {
  console.error(`listed twice: ${[...new Set(duplicates)].join(", ")}`);
  process.exit(1);
}

const glyphs = new Map();
for (const name of names) glyphs.set(name, inner(readFileSync(join(iconsDir, `${name}.svg`), "utf8"), name));

// Lucide's own tags are the first half of the matcher's knowledge; the second
// half (synonyms, and the weight a category-level word carries) is hand-written
// in `src/lib/category-icon.ts`, because tags describe a drawing and a category
// name describes a subject.
const tags = JSON.parse(readFileSync(join(root, "node_modules/lucide-static/tags.json"), "utf8"));
const keywords = new Map();
for (const name of names) {
  const words = new Set([
    ...name.split("-"),
    ...(tags[name] ?? []).flatMap((tag) => tag.toLowerCase().split(/[\s/]+/)),
  ]);
  keywords.set(
    name,
    [...words].map((word) => word.trim()).filter((word) => word.length > 0 && word !== "lucide" && word !== "icon"),
  );
}

const body = [
  "/**",
  " * The icon set, generated. Do not edit by hand:",
  " *",
  " *   node scripts/gen-icons.mjs",
  " *",
  " * Source: lucide-static (ISC), a curated subset listed in scripts/icon-set.txt.",
  " * Geometry only — no viewBox, no stroke, no fill — because <Glyph> owns those,",
  " * so every glyph in the app is drawn at one weight and one size.",
  " */",
  "",
  "export const ICONS: Record<string, string> = {",
  ...[...glyphs].map(([name, markup]) => `  ${JSON.stringify(name)}: ${JSON.stringify(markup)},`),
  "};",
  "",
  `/** The names this set knows, in the curated order (the tie-break in \`guessIcon\`). */`,
  "export const ICON_NAMES: string[] = [",
  ...[...glyphs.keys()].map((name) => `  ${JSON.stringify(name)},`),
  "];",
  "",
  "/** What each glyph is about: its own name plus Lucide's tags. */",
  "export const ICON_KEYWORDS: Record<string, string[]> = {",
  ...[...keywords].map(([name, words]) => `  ${JSON.stringify(name)}: ${JSON.stringify(words)},`),
  "};",
  "",
].join("\n");

const bytes = Buffer.byteLength(body);
if (process.argv.includes("--check")) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (current !== body) {
    console.error(`src/lib/icons/generated.ts is stale — run node scripts/gen-icons.mjs`);
    process.exit(1);
  }
  console.log(`src/lib/icons/generated.ts is current (${names.length} glyphs, ${(bytes / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);
console.log(`${names.length} glyphs → src/lib/icons/generated.ts (${(bytes / 1024).toFixed(1)} KB)`);

/** The `<svg>`'s children, with presentation stripped. */
function inner(svg, name) {
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  if (open === -1 || close === -1) throw new Error(`${name}: not an svg`);
  const markup = svg
    .slice(open + 1, close)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (markup.length === 0) throw new Error(`${name}: no geometry`);
  const cleaned = markup.replace(/<([a-z]+)((?:[^>"]|"[^"]*")*)\/?>/g, (whole, tag, attrs) => {
    // `x1`/`y2` carry digits, so the name cannot be letters-only.
    const kept = [...attrs.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)].filter(([, key]) => GEOMETRY.has(key));
    if (kept.length === 0) throw new Error(`${name}: <${tag}> with no geometry`);
    return `<${tag} ${kept.map(([, key, value]) => `${key}="${value}"`).join(" ")} />`;
  });
  if (/script/i.test(cleaned)) throw new Error(`${name}: refuses to carry "script"`);
  return cleaned;
}

/** The pinned version, for the error message and the header. */
function version() {
  const manifest = JSON.parse(readFileSync(join(root, "node_modules/lucide-static/package.json"), "utf8"));
  return manifest.version;
}
