/**
 * Unit checks for the icon set and the guesser behind it.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/icons.mjs
 *
 * Two contracts are worth this file. The first is that the committed generated
 * module and `scripts/icon-set.txt` agree — a name added to the list and never
 * regenerated is an icon that silently draws nothing. The second is the
 * acceptance list the owner's rule produced, including the two cases that look
 * alike and must not resolve alike: `Comics Weekly` is comics, `Sarah J. Maas` is
 * a person.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { guessIcon, looksLikePerson } from "../../src/lib/category-icon.ts";
import { FALLBACK_ICON, iconKeywords, iconMarkup, iconNames, hasIcon, iconsFromValue } from "../../src/lib/icons/index.ts";

import { emptyPrefs, parsePreferences, preferencesBody, withEntry } from "../../src/lib/prefs-sync.ts";
import { ICON_KEYWORDS } from "../../src/lib/icons/generated.ts";

let checks = 0;
let failures = 0;

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const listed = readFileSync(join(root, "scripts/icon-set.txt"), "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter((line) => line.length > 0);

// ---------------------------------------------------------------- the set

{
  check("the set is not empty", iconNames().length > 100, String(iconNames().length));
  check("every listed name is in the set", listed.every((name) => hasIcon(name)), listed.filter((n) => !hasIcon(n)).join(","));
  check("...and the set holds nothing the list does not", iconNames().length === listed.length, `${iconNames().length} vs ${listed.length}`);
  check("the order is the list's", iconNames()[0] === listed[0] && iconNames().at(-1) === listed.at(-1));
  check("the fallback is real", hasIcon(FALLBACK_ICON));

  // Geometry only: the outer svg and every presentation attribute are the
  // component's business, so one weight and one size can be enforced in one
  // place. A `stroke` here would silently win over the component's.
  const all = iconNames().map((name) => iconMarkup(name));
  check("every glyph has geometry", all.every((markup) => typeof markup === "string" && markup.includes("<")));
  check("no glyph carries an <svg>", all.every((markup) => !markup.includes("<svg")));
  check("no glyph carries a stroke", all.every((markup) => !/stroke|fill=|stroke-width|class=/.test(markup)));
  check("no glyph carries a viewBox", all.every((markup) => !markup.includes("viewBox")));
  check("no script, ever", all.every((markup) => !/script/i.test(markup)));

  // The budget in the plan: the whole set as path data, loaded as its own chunk.
  const bytes = all.reduce((sum, markup) => sum + Buffer.byteLength(markup), 0);
  check("the set stays inside 60 KB", bytes < 60 * 1024, `${(bytes / 1024).toFixed(1)} KB`);

  check("an unknown name is null, not the fallback", iconMarkup("not-a-glyph") === null);
  check("...and hasIcon agrees", !hasIcon("not-a-glyph"));
  check("every glyph has keywords", iconNames().every((name) => (iconKeywords(name) ?? []).length > 0));
  check("keywords are lowercase", Object.values(ICON_KEYWORDS).every((words) => words.every((word) => word === word.toLowerCase())));
}

// ------------------------------------------------------------- the guesser

{
  const cases = [
    // The owner's acceptance list, verbatim.
    ["Tech News", "cpu"],
    ["Comics", "book-open"],
    ["Comics Weekly", "book-open"],
    ["Alex Ross", "user"],
    ["Sarah J. Maas", "user"],
    ["The Verge", null],
    ["Reuters", null],
    ["Uncategorized", null],
    // The shapes around them, so the rule is a rule and not four examples.
    ["BBC NEWS", "newspaper"],
    ["Music", "music"],
    ["Film", "film"],
    ["Space", "rocket"],
    ["Crypto", "bitcoin"],
    ["Photography", "camera"],
    ["Local Politics", "landmark"],
    ["AI", "bot"],
    ["Manga", "book-open"],
    ["Pets", "paw-print"],
    ["Linux", "terminal"],
    ["Computer Security", "shield"],
  ];
  for (const [label, want] of cases) {
    const got = guessIcon(label);
    check(`guessIcon(${JSON.stringify(label)}) → ${want}`, got === want, String(got));
  }

  check("the same label always gets the same glyph", guessIcon("Science") === guessIcon("Science"));
  check("a keyword beats the person shape", guessIcon("Comics Weekly") !== "user");
  check("a two-word person is a person", looksLikePerson("Alex Ross"));
  check("three words with an initial are a person", looksLikePerson("Sarah J. Maas"));
  check("one word is never a person", !looksLikePerson("Reuters"));
  check("all caps is a publication", !looksLikePerson("BBC NEWS"));
  check("a stopword blocks it", !looksLikePerson("The Verge"));
  check("a digit blocks it", !looksLikePerson("Studio 54"));
  check("an empty label has no icon", guessIcon("") === null);
  check("punctuation alone has no icon", guessIcon("— !") === null);
  check("emoji alone has no icon", guessIcon("🎧") === null);
  check("a hyphenated name still reads as a person", guessIcon("Jean-Luc Picard") === "user");
}

// ------------------------------------------------------------ the tie-break

{
  // Adding glyphs must not reshuffle the answers: the first match in the
  // curated order wins a tie, so the set is the record of what was chosen.
  const first = iconNames().map((name) => [name, guessIcon(name)]);
  const second = iconNames().map((name) => [name, guessIcon(name)]);
  check("the set's own names are stable", JSON.stringify(first) === JSON.stringify(second));
  check("a glyph named after itself draws itself", first.every(([name, got]) => got !== null));
}

// -------------------------------------------------------------- the wire

{
  // `{icons: {auto, map: {label: name}}}` is object → object → string, depth 3
  // from the record's value. This proves the choice survives the parser rather
  // than trusting that the shape "looks shallow enough".
  const doc = withEntry(emptyPrefs(), "icons", {
    updatedAt: 1_790_000_000_000,
    value: { auto: false, map: { "Tech News": "cpu", "Alex Ross": "user" } },
  });
  const kept = parsePreferences(preferencesBody(doc)).entries.icons?.value;
  check("the icons namespace survives the parser", kept !== undefined, JSON.stringify(kept));
  check("...with its choices", kept?.map?.["Tech News"] === "cpu" && kept?.map?.["Alex Ross"] === "user");
  check("...and its switch", kept?.auto === false);

  // The rule, read back: an explicit choice wins, a guessed one only when auto.
  const read = iconsFromValue({ auto: false, map: { "Tech News": "cpu" } });
  check("auto off still keeps an explicit choice", read?.map["Tech News"] === "cpu");
  check("...and refuses to invent one", iconsFromValue({ auto: false, map: {} })?.auto === false);
  check("a map-less value is not adopted", iconsFromValue({ auto: true }) === null);
  check("a name the set cannot draw is dropped", Object.keys(iconsFromValue({ map: { A: "not-a-glyph" } })?.map ?? {}).length === 0);
  check("auto is on unless it says otherwise", iconsFromValue({ map: {} })?.auto === true);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
