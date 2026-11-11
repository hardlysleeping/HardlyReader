/**
 * The migration runner: what opening a library does to a file that already exists.
 *
 * The driver suite proves the SQL; this one proves the *policy* around it, which
 * is the part a launched app would otherwise be the only witness to:
 *
 * - a fresh file is stamped with this build's schema version,
 * - a library already at that version is left completely alone on reopen (this
 *   is the normal case, every launch, so "touches nothing" is the property to
 *   assert rather than assume),
 * - a file written by a newer build is refused with a sentence, not downgraded,
 * - a step runs once and only once, in version order,
 * - and nothing is stamped current unless the work that makes it current ran.
 *
 *   node --experimental-strip-types --import ./register-ts.mjs tests/unit/local-migrations.mjs
 */
import { LocalStorageError } from "../../src/api/local/driver.ts";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrate,
  readVersion,
  writeVersion,
} from "../../src/api/local/migrations.ts";
import { SqliteDatabase, LOCAL_DATABASE_FILE } from "../../src/api/local/sqlite-db.ts";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

function fail(message) {
  throw new Error(message);
}

function equal(actual, expected, what) {
  if (actual !== expected) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function refused(work) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

let sqliteModule = null;
try {
  sqliteModule = await import("node:sqlite");
} catch {
  console.log("\nmigrations (skipped: this Node has no node:sqlite)");
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}

const { DatabaseSync } = sqliteModule;

/**
 * The plugin's slice over Node's SQLite, recording every statement.
 *
 * A step in a suite wants to change data, so unlike the driver's stand-in this
 * one is handed straight to `migrate` and used directly: what is under test here
 * is the runner, not the placeholder spelling.
 */
class Recorder {
  constructor(db) {
    this.db = db;
    this.statements = [];
  }

  get log() {
    return this.statements.map((statement) => statement.query.replace(/\s+/g, " ").trim());
  }

  count(fragment) {
    return this.log.filter((query) => query.includes(fragment)).length;
  }

  async execute(query, values) {
    this.statements.push({ query, values });
    this.db.prepare(query).run(...(values ?? []));
    return [];
  }

  async select(query, values) {
    this.statements.push({ query, values });
    return this.db.prepare(query).all(...(values ?? []));
  }

  async close() {
    this.db.close();
    return true;
  }
}

function fresh() {
  return new Recorder(new DatabaseSync(":memory:"));
}

/* -------------------------------------------------------------------------- */

console.log("\nmigrations: the stamp");

await check("a file that has never been stamped reads as version 0", async () => {
  equal(await readVersion(fresh()), 0, "an unstamped file");
});

await check("opening a library stamps it with this build's version", async () => {
  const db = fresh();
  const report = await migrate(db);
  equal(report.from, 0, "it started unstamped");
  equal(report.to, SCHEMA_VERSION, "it ends at this build's version");
  equal(await readVersion(db), SCHEMA_VERSION, "and the file says so");
  equal(report.ran.length, 0, "no step had to run");
});

await check("a version that is not a whole number is refused rather than interpolated", async () => {
  const db = fresh();
  for (const bad of [1.5, -1, "2; DROP TABLE entries"]) {
    const error = await refused(() => writeVersion(db, bad));
    if (!(error instanceof LocalStorageError)) fail(`"${String(bad)}" was accepted`);
  }
  equal(await readVersion(db), 0, "and nothing was written");
});

console.log("\nmigrations: reopening");

await check("a library already at this version is not altered at all", async () => {
  const db = fresh();
  await migrate(db);
  const start = db.statements.length;
  const report = await migrate(db);
  const after = db.log.slice(start);
  equal(after.filter((query) => query.startsWith("ALTER TABLE")).length, 0, "ALTERs");
  equal(after.filter((query) => query.startsWith("PRAGMA user_version =")).length, 0, "stamps");
  equal(report.from, SCHEMA_VERSION, "still at this version");
  equal(report.added.length, 0, "nothing healed");
});

await check("an unstamped library with an old table is healed and then stamped", async () => {
  const db = fresh();
  db.db.exec(`CREATE TABLE "entries" ("key" TEXT PRIMARY KEY NOT NULL, "feed" TEXT)`);
  db.db.prepare(`INSERT INTO "entries" ("key", "feed") VALUES (?, ?)`).run("old", "https://a.test/rss");

  const report = await migrate(db);
  const healed = report.added.find((entry) => entry.table === "entries");
  if (!healed) fail("entries was not reported as healed");
  if (!healed.columns.includes("stored_at")) fail("stored_at was not added");
  equal((await db.select(`SELECT * FROM "entries"`)).length, 1, "the old row survived");
  equal(await readVersion(db), SCHEMA_VERSION, "and the file is stamped");
});

console.log("\nmigrations: a newer file");

await check("a library from a newer build is refused, and left untouched", async () => {
  const db = fresh();
  await migrate(db);
  await writeVersion(db, SCHEMA_VERSION + 3);
  const start = db.statements.length;

  const error = await refused(() => migrate(db));
  if (!(error instanceof LocalStorageError)) fail("a newer file was opened anyway");
  if (!error.message.includes(String(SCHEMA_VERSION + 3))) fail(`the message names no version: ${error.message}`);
  // The version has to be read to know it is newer; nothing beyond that read is
  // allowed to touch the file.
  const after = db.log.slice(start).filter((query) => !query.startsWith("PRAGMA user_version"));
  equal(after.length, 0, "statements run against it");
  equal(await readVersion(db), SCHEMA_VERSION + 3, "and its version was not lowered");
});

console.log("\nmigrations: steps");

await check("a step runs once, and not again on the next open", async () => {
  const ran = [];
  const steps = [{ version: SCHEMA_VERSION + 1, name: "backfill", up: async () => void ran.push("loud") }];

  const db = fresh();
  await migrate(db, { migrations: steps, target: SCHEMA_VERSION + 1 });
  equal(ran.join(","), "loud", "it ran on the first open");

  await migrate(db, { migrations: steps, target: SCHEMA_VERSION + 1 });
  equal(ran.join(","), "loud", "and not on the second");
});

await check("steps run in version order, whatever order they are listed in", async () => {
  const order = [];
  const steps = [
    { version: SCHEMA_VERSION + 3, name: "third", up: async () => void order.push(3) },
    { version: SCHEMA_VERSION + 1, name: "first", up: async () => void order.push(1) },
    { version: SCHEMA_VERSION + 2, name: "second", up: async () => void order.push(2) },
  ];
  await migrate(fresh(), { migrations: steps, target: SCHEMA_VERSION + 3 });
  equal(order.join(","), "1,2,3", "the order the steps ran in");
});

await check("a step the file has already passed does not run again", async () => {
  const order = [];
  const db = fresh();
  await migrate(db, {
    migrations: [{ version: SCHEMA_VERSION + 1, name: "already", up: async () => void order.push(1) }],
    target: SCHEMA_VERSION + 1,
  });
  equal(order.length, 1, "ran once");

  // The next build has a second step; the first must not be repeated over a
  // library that already has its result.
  await migrate(db, {
    migrations: [
      { version: SCHEMA_VERSION + 1, name: "already", up: async () => void order.push(1) },
      { version: SCHEMA_VERSION + 2, name: "next", up: async () => void order.push(2) },
    ],
    target: SCHEMA_VERSION + 2,
  });
  equal(order.join(","), "1,2", "only the new one ran");
});

await check("a step that a later build has not reached yet does not run early", async () => {
  const ran = [];
  await migrate(fresh(), {
    migrations: [{ version: SCHEMA_VERSION + 2, name: "future", up: async () => void ran.push("x") }],
    target: SCHEMA_VERSION + 1,
  });
  equal(ran.length, 0, "nothing ahead of the target ran");
});

await check("a failing step leaves the file unstamped, so the next open retries", async () => {
  const db = fresh();
  const error = await refused(() =>
    migrate(db, {
      migrations: [
        {
          version: SCHEMA_VERSION + 1,
          name: "breaks",
          up: async () => {
            throw new Error("nope");
          },
        },
      ],
      target: SCHEMA_VERSION + 1,
    }),
  );
  if (!error) fail("the failure was swallowed");
  equal(await readVersion(db), 0, "the file was not stamped current");
});

console.log("\nmigrations: through the driver");

await check("the desktop driver reports what opening it changed", async () => {
  const plugin = new Recorder(new DatabaseSync(":memory:"));
  const db = await SqliteDatabase.open(LOCAL_DATABASE_FILE, async () => plugin);
  if (!db.report) fail("open reported nothing");
  equal(db.report.from, 0, "it created a library");
  equal(db.report.to, SCHEMA_VERSION, "at this version");
  equal(await readVersion(plugin), SCHEMA_VERSION, "and stamped it");
  await db.close();
});

await check("this build ships no step it has not declared a version for", async () => {
  for (const step of MIGRATIONS) {
    if (!Number.isInteger(step.version) || step.version < 1) fail(`${step.name} has no version`);
    if (step.version > SCHEMA_VERSION) fail(`${step.name} is ahead of SCHEMA_VERSION`);
  }
});

console.log(`\n${passed} checks passed`);
