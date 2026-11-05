// The messages half of `supabase/schema.sql`, exercised against a real Postgres.
//
// The point of this suite is not "the SQL parses" — it is the three promises the
// feature makes, each of which a client cannot be trusted with:
//
//   * an account sees the messages for the app it is in, and only those it was
//     sent: a message targeted at one person must not appear in anyone else's
//     list, and the other app's list must not leak into this one;
//   * nothing is visible before it is published, and nothing after it expires;
//   * read state is the reader's own insert — it cannot be forged for a message
//     the reader cannot see, it cannot be rewritten, and it goes away with the
//     account.
//
// Plus the part that makes the app's half small: `anon` can do none of it, and a
// signed-in account cannot write a message at all. Only the service role can,
// which is the key the sending tool holds and no build of either app does.
//
// Docker runs a throwaway `postgres:16` with the same auth stub the billing suite
// uses (`server/billing/tests/supabase-stub.sql`), so the schema is applied
// exactly as a Supabase project would receive it. Without Docker the suite says
// so and passes, like the billing one.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const CONTAINER = `hr-messages-test-${process.pid}`;
const IMAGE = "postgres:16-alpine";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** docker, as a promise. Never rejects; the caller decides what a failure means. */
function docker(args, input = undefined, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr, error });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** `psql` inside the container. SQL on stdin, so nothing is ever interpolated by a shell. */
async function sql(statement) {
  return await docker(
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    statement,
  );
}

/** One statement's scalar answer. Throws, because a check that cannot ask is not a pass. */
async function one(statement) {
  const result = await sql(statement);
  if (!result.ok) throw new Error(`psql failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("");
}

/** The same statement, run as a signed-in account. `auth.uid()` reads this claim. */
async function asUser(user, statement) {
  return await sql(
    `set role authenticated;\nset request.jwt.claims = '{"sub":"${user}"}';\n${statement}`,
  );
}

/** The same statement, run as a signed-in account, returning its scalar answer. */
async function oneAs(user, statement) {
  const result = await asUser(user, statement);
  if (!result.ok) throw new Error(`psql failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("");
}

/* --------------------------------------------------------------------------
 * The container
 * ----------------------------------------------------------------------- */

const available = await docker(["--version"]);
if (!available.ok) {
  console.log("SKIP  docker is not available here, so the SQL is not exercised on this box");
  console.log("\n0/0 checks passed (skipped: no docker)");
  process.exit(0);
}

await docker(["rm", "-f", CONTAINER]);
const started = await docker(["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=pg", IMAGE]);
if (!started.ok) {
  console.log("SKIP  docker could not start the image here");
  console.log(`\n0/0 checks passed (skipped: ${started.stderr.trim().slice(0, 120)})`);
  process.exit(0);
}

let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  // Over TCP: the entrypoint's temporary server listens on the unix socket only.
  const ping = await docker(["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
  if (ping.ok) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check("a Postgres comes up to test against", ready);
if (!ready) {
  await docker(["rm", "-f", CONTAINER]);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(1);
}

try {
  const stub = readFileSync(join(ROOT, "server/billing/tests/supabase-stub.sql"), "utf8");
  const schema = readFileSync(join(ROOT, "supabase/schema.sql"), "utf8");

  check("the Supabase stub applies", (await sql(stub)).ok);
  const first = await sql(schema);
  check("supabase/schema.sql applies to a real Postgres", first.ok, first.stderr.slice(0, 200));
  const second = await sql(schema);
  check("and applying it twice changes nothing", second.ok, second.stderr.slice(0, 200));

  /* ------------------------------------------------------------------------
   * 1. The shape: no door into the tables, one door into the list
   * --------------------------------------------------------------------- */

  check(
    "all three message tables have row-level security on and no policy at all",
    (await one(
      "select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname) from pg_class where relname in ('app_messages','app_message_recipients','app_message_reads');",
    )) === "app_message_reads:true,app_message_recipients:true,app_messages:true" &&
      (await one(
        "select count(*) from pg_policies where tablename in ('app_messages','app_message_recipients','app_message_reads');",
      )) === "0",
  );

  check(
    "a signed-in account has no privilege on the tables themselves",
    (await one(
      `select bool_or(has_table_privilege('authenticated', t, p))::text from unnest(array['app_messages','app_message_recipients','app_message_reads']) t, unnest(array['select','insert','update','delete']) p;`,
    )) === "false",
  );

  check(
    "and neither has anon",
    (await one(
      `select bool_or(has_table_privilege('anon', t, p))::text from unnest(array['app_messages','app_message_recipients','app_message_reads']) t, unnest(array['select','insert','update','delete']) p;`,
    )) === "false",
  );

  check(
    "the list function is executable by a signed-in account, and anon cannot call it",
    (await one(
      "select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_proc p join aclexplode(p.proacl) a on true join pg_roles r on r.oid = a.grantee where p.proname = 'my_app_messages' and r.rolname <> 'postgres';",
    )) === "authenticated",
    await one(
      "select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_proc p join aclexplode(p.proacl) a on true join pg_roles r on r.oid = a.grantee where p.proname = 'my_app_messages' and r.rolname <> 'postgres';",
    ),
  );

  check(
    "and so is the read marker",
    (await one(
      "select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_proc p join aclexplode(p.proacl) a on true join pg_roles r on r.oid = a.grantee where p.proname = 'mark_app_messages_read' and r.rolname <> 'postgres';",
    )) === "authenticated",
  );

  /* ------------------------------------------------------------------------
   * 2. Writing messages is the service key's job
   * --------------------------------------------------------------------- */

  await sql(`insert into auth.users (id, email) values ('${USER}', 'one@example.test'), ('${OTHER}', 'two@example.test');`);

  const wrote = await sql(`
    set role service_role;
    insert into public.app_messages (id, app, title, body, audience, published_at) values
      ('00000000-0000-0000-0000-00000000000a', 'hardlyreader', 'Reader: everyone', 'The reader was down for ten minutes.', 'all', now() - interval '2 hours'),
      ('00000000-0000-0000-0000-00000000000b', 'hardlyreader', 'Reader: just you', 'Your lifetime upgrade is on the account.', 'selected', now() - interval '1 hour'),
      ('00000000-0000-0000-0000-00000000000c', 'hardlytracking', 'Tracking: everyone', 'New source list is live.', 'all', now() - interval '30 minutes'),
      ('00000000-0000-0000-0000-00000000000d', 'hardlyreader', 'Reader: later', 'This one is not published yet.', 'all', now() + interval '1 day'),
      ('00000000-0000-0000-0000-00000000000e', 'hardlyreader', 'Reader: over', 'This one has expired.', 'all', now() - interval '3 days');
    insert into public.app_message_recipients (message_id, user_id)
      values ('00000000-0000-0000-0000-00000000000b', '${USER}');
    update public.app_messages set expires_at = now() - interval '1 day'
      where id = '00000000-0000-0000-0000-00000000000e';
  `);
  check("the service key writes a message and a recipient without any write policy", wrote.ok, wrote.stderr.slice(0, 300));

  check(
    "a signed-in account cannot write one",
    !(
      await asUser(
        USER,
        "insert into public.app_messages (app, title, body) values ('hardlyreader', 'Mine', 'I made this');",
      )
    ).ok,
  );

  check(
    "an empty title is refused by the table, not by the app",
    !(await sql(`insert into public.app_messages (app, title, body) values ('hardlyreader', '   ', 'x');`)).ok,
  );

  check(
    "and so is a third app name",
    !(await sql(`insert into public.app_messages (app, title, body) values ('somethingelse', 'x', 'y');`)).ok,
  );

  /* ------------------------------------------------------------------------
   * 3. Who sees what
   * --------------------------------------------------------------------- */

  const titles = async (user, app) =>
    (
      await oneAs(user, `select coalesce(string_agg(title, ' | ' order by published_at desc), '') from public.my_app_messages('${app}');`)
    ).trim();

  check(
    "the account the message names sees it, with the app-wide ones",
    (await titles(USER, "hardlyreader")) === "Reader: just you | Reader: everyone",
    await titles(USER, "hardlyreader"),
  );

  check(
    "another account sees the app-wide message and not the targeted one",
    (await titles(OTHER, "hardlyreader")) === "Reader: everyone",
    await titles(OTHER, "hardlyreader"),
  );

  check(
    "the other app's message is not in this app's list",
    !(await titles(USER, "hardlyreader")).includes("Tracking"),
  );

  check(
    "a message published in the future is not visible yet",
    !(await titles(USER, "hardlyreader")).includes("later"),
  );

  check(
    "a message past its expiry is not visible",
    !(await titles(USER, "hardlyreader")).includes("over"),
  );

  check(
    "everything in the list arrives unread",
    (await oneAs(
      USER,
      "select coalesce(string_agg(coalesce(read_at::text, 'unread'), ',' order by title), '') from public.my_app_messages('hardlyreader');",
    )) === "unread,unread",
  );

  check(
    "anon cannot call the list at all",
    !(
      await sql("set role anon;\nselect * from public.my_app_messages('hardlyreader');")
    ).ok,
  );

  /* ------------------------------------------------------------------------
   * 4. Read state: an insert, for what the reader can actually see
   * --------------------------------------------------------------------- */

  check(
    "marking a batch read records only the messages this account can see",
    (await oneAs(
      USER,
      `select public.mark_app_messages_read('hardlyreader', array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-00000000000e']::uuid[]);`,
    )) === "2",
  );

  check(
    "the unread count for this account is zero after marking",
    (await oneAs(
      USER,
      "select count(*)::text from public.my_app_messages('hardlyreader') where read_at is null;",
    )) === "0",
  );

  check(
    "marking the same batch again records nothing new",
    (await oneAs(
      USER,
      `select public.mark_app_messages_read('hardlyreader', array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b']::uuid[]);`,
    )) === "0",
  );

  check(
    "a message in the other app cannot be marked read from this one",
    (await oneAs(
      USER,
      `select public.mark_app_messages_read('hardlyreader', array['00000000-0000-0000-0000-00000000000c']::uuid[]);`,
    )) === "0",
  );

  check(
    "and it is still unread in its own app",
    (await oneAs(
      USER,
      "select count(*)::text from public.my_app_messages('hardlytracking') where read_at is null;",
    )) === "1",
  );

  check(
    "nobody else's read rows were written",
    (await one(
      "select count(*)::text from public.app_message_reads where user_id <> (select id from auth.users where email = 'one@example.test');",
    )) === "0",
  );

  check(
    "a signed-in account cannot write a read marker for anyone, including itself",
    !(
      await asUser(
        OTHER,
        `insert into public.app_message_reads (message_id, user_id) values ('00000000-0000-0000-0000-00000000000a', '${OTHER}');`,
      )
    ).ok,
  );

  /* ------------------------------------------------------------------------
   * 5. The account is the key: deleting it deletes its rows
   * --------------------------------------------------------------------- */

  await sql(`delete from auth.users where id = '${USER}';`);
  check(
    "deleting the account takes its read rows with it",
    (await one(`select count(*)::text from public.app_message_reads where user_id = '${USER}';`)) === "0",
  );
  check(
    "and its targeting rows",
    (await one(`select count(*)::text from public.app_message_recipients where user_id = '${USER}';`)) === "0",
  );
} finally {
  await docker(["rm", "-f", CONTAINER]);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
