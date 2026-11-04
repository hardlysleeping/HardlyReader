// One place builds a server backend.
//
// Not a style preference: the offline journal wraps every server backend, so a
// second `new GReaderBackend` in the tree is a path that misses the queue. This
// suite holds that line and proves the seam builds and wraps for real.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every source file under src, so "no other constructor" is a real claim. */
function sources(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.(ts|svelte)$/.test(entry)) found.push(path);
  }
  return found;
}

// A code occurrence, not a mention: the seam's own comment names the class.
const CONSTRUCTION = /new GReaderBackend\s*\(/;
const files = sources(join(root, "src"));
const constructions = files.flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return text
    .split("\n")
    .map((line, index) => ({ line, index, text }))
    .filter(({ line }) => CONSTRUCTION.test(line) && !line.trim().startsWith("*"))
    .map(({ index }) => ({ file: file.slice(root.length + 1), line: index + 1 }));
});

check(
  "exactly one place constructs a server backend",
  constructions.length === 1,
  JSON.stringify(constructions),
);
check(
  "and that place is the seam in api/profile",
  constructions.length === 1 && constructions[0].file === "src/api/profile.ts",
  constructions[0]?.file,
);

const profile = read("src/api/profile.ts");
check("the seam is exported", /export function serverBackend\(/.test(profile));
check(
  "and wraps what it builds",
  /wrap\?: \(backend: ReaderBackend\) => ReaderBackend/.test(profile) &&
    /options\.wrap === undefined \? built : options\.wrap\(built\)/.test(profile),
);

const reader = read("src/state/reader.svelte.ts");
check(
  "the reader takes its server backend from the seam",
  /import \{[^}]*serverBackend[^}]*\} from "\.\.\/api\/profile"/.test(reader),
);
check("the reader builds no backend of its own", !CONSTRUCTION.test(reader));
check("a session with no profile is still read through the seam", /const built = serverBackend\(session\);/.test(reader));

// --- at runtime
const profileModule = await import(pathToFileURL(join(root, "src/api/profile.ts")).href);
const { serverBackend } = profileModule;
check("the seam is callable", typeof serverBackend === "function");

const session = { serverUrl: "https://example.test", apiPath: "/api/greader.php", email: "a", token: "t" };
const plain = serverBackend(session);
check("a session gets a backend", plain !== null && typeof plain === "object");
check("of the reader's own shape", plain.kind === "greader");
check(
  "and it declares nothing about capabilities on the server's behalf",
  plain.capabilities === undefined,
);
check("a server account has a queue to send later", typeof plain.flush === "function");
check(
  "and the same account gets the same queue twice over",
  serverBackend(session).flush !== undefined && serverBackend(session) !== plain,
);
check(
  "a caller that wants no queueing gets the plain backend",
  serverBackend(session, { queue: false }).flush === undefined,
);

const seen = [];
const wrapped = serverBackend(session, {
  wrap: (backend) => {
    seen.push(backend);
    return backend;
  },
});
check("a wrapper is handed the backend that was built", seen.length === 1 && seen[0] === wrapped);
check("and the caller gets what the wrapper returned", wrapped === seen[0]);

const replacement = { kind: "stub" };
check(
  "a wrapper may return anything that behaves like a backend",
  serverBackend(session, { wrap: () => replacement }) === replacement,
);

check("no options still builds", serverBackend(session, {}).kind === "greader");
check(
  "the seam builds a server backend and nothing else",
  /const plain: ReaderBackend = new GReaderBackend\(transport, session\);/.test(profile),
);
check(
  "and puts the write queue in front of it",
  /new OfflineBackend\(plain, \{/.test(profile) && /journal: options\.journal \?\? journalFor\(/.test(profile),
);
check(
  "one queue per account, so two backends cannot send the same mark twice",
  /const journals = new Map<string, WriteJournal>\(\)/.test(profile) &&
    /journal = new WriteJournal\(new IdbJournalBank\(\), slug\)/.test(profile),
);
check(
  "and the queue can be handed back plain when a caller wants no queueing",
  /options\.queue === false\s*\n\s*\? plain/.test(profile),
);

if (failures > 0) {
  console.log(`\n${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`${checks} checks, 0 failure(s)`);
