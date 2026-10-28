/**
 * One person, one account — against a real Postgres.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/account-postgres.mjs
 *
 * `tests/unit/account.mjs` proves what the app asks for. This suite proves what
 * the database does with the answer, because three of this card's promises are
 * SQL and a JavaScript double would only ever agree with itself:
 *
 * 1. **Two doors, one account, one entitlement.** A second `auth.identities` row
 *    for the same user leaves `entitlements` at exactly one row — linking cannot
 *    create a second subscription, because the entitlement is keyed by the user.
 * 2. **Revoking a device ends a session.** The refresh tokens for that session go
 *    with it, another reader's session id returns `false` instead of being ended,
 *    and the entitlement row is not touched.
 * 3. **Deleting an account takes the identity and the rows that hang off it, and
 *    nothing else.** Refused while a paid subscription is charging; when it runs,
 *    the entitlement, both identities and every session go by cascade, and the
 *    other reader in the database is untouched.
 *
 * The container is created, filled, asserted and removed inside one run. It never
 * touches a Supabase project, and never touches the owner's data. When `docker`
 * is not available the suite says so and passes — a box without Docker is not a
 * failing build.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const CONTAINER = `hr-account-test-${process.pid}`;
const IMAGE = "postgres:16-alpine";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const A_LAPTOP = "aaaaaaaa-0000-0000-0000-000000000001";
const A_PHONE = "aaaaaaaa-0000-0000-0000-000000000002";
const B_LAPTOP = "bbbbbbbb-0000-0000-0000-000000000003";

/** docker, as a promise. Never rejects; the caller decides. */
function docker(args, input = undefined, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr, error });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** `psql` inside the container. SQL on stdin, so nothing is ever interpolated. */
async function sql(statement) {
  return docker(
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    statement,
  );
}

/** One scalar from a statement, run as the superuser. */
async function one(statement) {
  const result = await sql(statement);
  if (!result.ok) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("");
}

/** A statement run as a signed-in reader: RLS and the grants apply. */
async function asReader(userId, sessionId, statement) {
  const claims = JSON.stringify({ sub: userId, session_id: sessionId, role: "authenticated" });
  return sql(
    `set role authenticated;\nselect set_config('request.jwt.claims', '${claims}', false);\n${statement}`,
  );
}

/** A statement run as a signed-in reader that must succeed, answering one value. */
async function asReaderOne(userId, sessionId, statement) {
  const result = await asReader(userId, sessionId, statement);
  if (!result.ok) throw new Error(`psql failed: ${result.stderr}`);
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // `set_config` answers with the value it set, so the statement's own answer is
  // the last line, not the first.
  return lines[lines.length - 1] ?? "";
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
  // Over TCP, not the unix socket: the image's entrypoint starts a *temporary*
  // server on the socket while it initialises (`docker-entrypoint.sh` sets
  // `listen_addresses=''` for it), answers `pg_isready` there, and then restarts
  // for real. A check on the socket passes against that transient server and the
  // first `psql` then lands in the restart — a coin flip that showed up as
  // "connection to server on socket … failed" on a busy box. The real server is
  // the one listening on 127.0.0.1.
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

  const stubResult = await sql(stub);
  check("the Supabase stub applies (roles, auth.users, auth.sessions, auth.jwt)", stubResult.ok, stubResult.stderr.slice(0, 160));

  const first = await sql(schema);
  check("supabase/schema.sql applies to a real Postgres", first.ok, first.stderr.slice(0, 240));
  const second = await sql(schema);
  check("and applying it twice changes nothing", second.ok, second.stderr.slice(0, 240));

  /* ------------------------------------------------------------------------
   * The fixtures: one reader with two doors, and a second reader
   * --------------------------------------------------------------------- */

  await one(`insert into auth.users (id, email) values ('${A}', 'a@fixture.test'), ('${B}', 'b@fixture.test');`);
  await one(
    `insert into auth.sessions (id, user_id) values ('${A_LAPTOP}', '${A}'), ('${A_PHONE}', '${A}'), ('${B_LAPTOP}', '${B}');`,
  );
  await one(
    `insert into auth.refresh_tokens (token, session_id) values ('laptop', '${A_LAPTOP}'), ('phone', '${A_PHONE}'), ('b-laptop', '${B_LAPTOP}');`,
  );
  // The link: two identities, one user. This is what `linkIdentity` writes.
  await one(
    `insert into auth.identities (user_id, provider, provider_id) values
       ('${A}', 'google', 'google-1'), ('${A}', 'apple', 'apple-1'), ('${B}', 'google', 'google-2');`,
  );
  await one(`select public.set_entitlement('${A}', true, 'stripe', null);`);

  check(
    "one person can have two doors",
    (await one(`select count(*) from auth.identities where user_id = '${A}';`)) === "2",
  );
  check(
    "and exactly one entitlement row",
    (await one(`select count(*) from public.entitlements where user_id = '${A}';`)) === "1",
  );

  // The third link is an email address, added later, from a phone.
  await one(`insert into auth.identities (user_id, provider, provider_id) values ('${A}', 'email', 'a@fixture.test');`);
  check(
    "linking a third door still leaves one row — no second subscription",
    (await one(`select count(*) from public.entitlements where user_id = '${A}';`)) === "1" &&
      (await one(`select count(distinct user_id) from auth.identities where provider = 'google';`)) === "2",
  );
  check(
    "and one user, not two",
    (await one(`select count(*) from auth.users where email = 'a@fixture.test';`)) === "1",
  );

  /* ------------------------------------------------------------------------
   * Registering this device, and reading the list
   * --------------------------------------------------------------------- */

  const registered = await asReaderOne(A, A_LAPTOP, `select public.register_device('Linux · WebKit', 'Linux');`);
  check("a device registers itself", registered === A_LAPTOP, registered);
  await asReaderOne(A, A_LAPTOP, `select public.register_device('Linux · WebKit (renamed)', 'Linux');`);
  check(
    "and registering again updates it rather than adding a device",
    (await one(`select count(*) from public.account_devices where user_id = '${A}';`)) === "1",
  );
  check(
    "with the newer label",
    (await one(`select label from public.account_devices where session_id = '${A_LAPTOP}';`)) === "Linux · WebKit (renamed)",
  );
  check(
    "and the reader's own rows are the only ones it can read",
    (await asReaderOne(A, A_LAPTOP, `select count(*) from public.account_devices;`)) === "1",
  );
  check(
    "another reader sees none of them",
    (await asReaderOne(B, B_LAPTOP, `select count(*) from public.account_devices;`)) === "0",
  );

  const crossInsert = await asReader(
    A,
    A_LAPTOP,
    `insert into public.account_devices (session_id, user_id) values ('${B_LAPTOP}', '${B}');`,
  );
  check("a reader cannot register a row for somebody else's session", !crossInsert.ok, crossInsert.stderr.slice(0, 90));

  const directDelete = await asReader(A, A_LAPTOP, `delete from public.account_devices where session_id = '${A_LAPTOP}';`);
  check("and cannot delete a device row directly, only end its session", !directDelete.ok, directDelete.stderr.slice(0, 90));
  check(
    "so the row is still there after that attempt",
    (await one(`select count(*) from public.account_devices where session_id = '${A_LAPTOP}';`)) === "1",
  );

  /* ------------------------------------------------------------------------
   * Revoking: another device's session ends, and nothing else does
   * --------------------------------------------------------------------- */

  const wrongReader = await asReaderOne(B, B_LAPTOP, `select public.revoke_device('${A_LAPTOP}');`);
  check("a reader cannot revoke somebody else's device", wrongReader === "f", wrongReader);
  check(
    "and that session is untouched",
    (await one(`select count(*) from auth.sessions where id = '${A_LAPTOP}';`)) === "1",
  );

  const ended = await asReaderOne(A, A_LAPTOP, `select public.revoke_device('${A_PHONE}');`);
  check("a reader can revoke their own other device", ended === "t", ended);
  check("that session is gone", (await one(`select count(*) from auth.sessions where id = '${A_PHONE}';`)) === "0");
  check(
    "and the refresh token that could have renewed it is gone with it",
    (await one(`select count(*) from auth.refresh_tokens where session_id = '${A_PHONE}';`)) === "0",
  );
  check("this device is still signed in", (await one(`select count(*) from auth.sessions where id = '${A_LAPTOP}';`)) === "1");
  check(
    "the entitlement was not touched by any of it",
    (await one(`select count(*) from public.entitlements where user_id = '${A}';`)) === "1",
  );
  check("and the identities are all still there", (await one(`select count(*) from auth.identities where user_id = '${A}';`)) === "3");

  /* ------------------------------------------------------------------------
   * Deleting the account
   * --------------------------------------------------------------------- */

  const refused = await asReaderOne(A, A_LAPTOP, `select public.delete_my_account();`);
  check("an account still being charged is not deleted", refused === "cancel_first", refused);
  check("and the identity is still there", (await one(`select count(*) from auth.users where id = '${A}';`)) === "1");

  // The reader cancels; the webhook writes false; then they come back.
  await one(`select public.set_entitlement('${A}', false, 'stripe', now() - interval '1 day');`);

  const deleted = await asReaderOne(A, A_LAPTOP, `select public.delete_my_account();`);
  check("a cancelled account is deleted", deleted === "deleted", deleted);
  check("the identity is gone", (await one(`select count(*) from auth.users where id = '${A}';`)) === "0");
  check("and every door it had", (await one(`select count(*) from auth.identities where user_id = '${A}';`)) === "0");
  check("and the entitlement row", (await one(`select count(*) from public.entitlements where user_id = '${A}';`)) === "0");
  check("and its sessions", (await one(`select count(*) from auth.sessions where user_id = '${A}';`)) === "0");
  check("and its device rows", (await one(`select count(*) from public.account_devices where user_id = '${A}';`)) === "0");

  check("the other reader is untouched", (await one(`select count(*) from auth.users where id = '${B}';`)) === "1");
  check("with their session", (await one(`select count(*) from auth.sessions where user_id = '${B}';`)) === "1");
  check("and their door", (await one(`select count(*) from auth.identities where user_id = '${B}';`)) === "1");

  check(
    "no table in the schema holds a file, a folder or a library",
    (await one(
      "select count(*) from information_schema.tables where table_schema = 'public' and table_name ilike any (array['%file%','%folder%','%drive%','%library%','%post%','%feed%']);",
    )) === "0",
  );
} finally {
  await docker(["rm", "-f", CONTAINER]);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
