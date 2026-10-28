/**
 * The row-writing function against a real Postgres.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-postgres.mjs
 *
 * `apply_stripe_event` is where this feature can actually lose money, and it is
 * SQL: the unique index that spends an event id, the `for update` that serialises
 * two deliveries at once, the watermark that stops a late event resurrecting a
 * cancelled row. A JavaScript double of that would only ever agree with whatever
 * the test asserted, so this suite applies `supabase/schema.sql` to a throwaway
 * Postgres and calls the function for real, through `psql`.
 *
 * It never touches the owner's data and never touches a Supabase project: the
 * container is created, filled, asserted and removed inside one run. When
 * `docker` is not available the suite says so and passes — a box without Docker
 * is not a failing build.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PsqlDb } from "../../server/billing/db.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const CONTAINER = `hr-billing-test-${process.pid}`;
const IMAGE = "postgres:16-alpine";
const NOW = Date.UTC(2026, 9, 27);
const DAY = 86_400_000;
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const CUSTOMER = "cus_test_1";

/** docker, as a promise. Never rejects with a signal; the caller decides. */
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
  const result = await docker(
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    statement,
  );
  return result;
}

/** One scalar from a statement. */
async function one(statement) {
  const result = await sql(statement);
  if (!result.ok) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("");
}

/** The entitlement row, as the columns that matter. */
async function row() {
  const out = await one(
    "select coalesce(cloud_sync::text, 'null') || '|' || coalesce(source, 'null') || '|' || coalesce(to_char(expires_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS'), 'null') from public.entitlements where user_id = '" +
      USER +
      "';",
  );
  if (out === "") return null;
  const [cloudSync, source, expiresAt] = out.split("|");
  return { cloudSync, source, expiresAt };
}

/** The timestamptz the row holds, in the shape `row()` formats it. */
const iso = (ms) =>
  new Date(ms)
    .toISOString()
    .replace(".000Z", "")
    .replace("Z", "");

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
  const ping = await docker(["exec", CONTAINER, "pg_isready", "-U", "postgres"]);
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
  check("the Supabase stub applies (roles, auth.users, auth.uid)", stubResult.ok, stubResult.stderr.slice(0, 120));

  const first = await sql(schema);
  check("supabase/schema.sql applies to a real Postgres", first.ok, first.stderr.slice(0, 200));
  const second = await sql(schema);
  check("and applying it twice changes nothing — it is safe to re-run on a live project", second.ok, second.stderr.slice(0, 200));

  check(
    "both new tables have row-level security on and no policy at all",
    (await one("select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname) from pg_class where relname in ('entitlements','stripe_customers','stripe_events');")) ===
      "entitlements:true,stripe_customers:true,stripe_events:true" &&
      (await one("select count(*) from pg_policies where tablename in ('stripe_customers','stripe_events');")) === "0",
  );

  const pgGrantees = (
    await one(
      "select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_proc p join aclexplode(p.proacl) a on true join pg_roles r on r.oid = a.grantee where p.proname = 'apply_stripe_event';",
    )
  ).split(",");

  check(
    "the event writer is executable by the service role and by nobody else",
    (() => {
      // Nothing asserted here about the owner: `postgres` owns the function and
      // holds EXECUTE on it implicitly, which is how every Postgres function works.
      const grantees = pgGrantees;
      return grantees.includes("service_role") && !grantees.includes("anon") && !grantees.includes("authenticated");
    })(),
    pgGrantees.join(","),
  );

  await one(`insert into auth.users (id) values ('${USER}'), ('${OTHER_USER}');`);
  const db = new PsqlDb({ container: CONTAINER, user: "postgres", database: "postgres" });

  /* ------------------------------------------------------------------------
   * 1. Nothing is linked yet, so nothing may be granted
   * --------------------------------------------------------------------- */

  check(
    "an event for a customer nobody is linked to is refused, and no row appears",
    (await db.applyEvent({
      eventId: "evt_unlinked",
      type: "customer.subscription.created",
      created: 1000,
      customerId: "cus_stranger",
      cloudSync: true,
      expiresAtMs: NOW + DAY,
    })) === "unknown_customer",
  );
  check("with no entitlement row written", (await row()) === null);
  check(
    "and the refusal is recorded, so the event id is spent exactly once",
    (await one("select outcome from public.stripe_events where id = 'evt_unlinked';")) === "unknown_customer",
  );

  /* ------------------------------------------------------------------------
   * 2. A purchase
   * --------------------------------------------------------------------- */

  await db.linkCustomer(USER, CUSTOMER);
  check("checkout creation links a customer to a reader", (await db.customerOf(USER)) === CUSTOMER);

  check(
    "a signed, in-order subscription event writes the row",
    (await db.applyEvent({
      eventId: "evt_1",
      type: "customer.subscription.created",
      created: 1000,
      customerId: CUSTOMER,
      cloudSync: true,
      expiresAtMs: NOW + 3 * DAY,
    })) === "applied",
  );
  const granted = await row();
  check(
    "cloud_sync is true, the source is stripe, and the expiry is the period end",
    granted?.cloudSync === "true" && granted?.source === "stripe" && granted?.expiresAt === iso(NOW + 3 * DAY),
    JSON.stringify(granted),
  );

  /* ------------------------------------------------------------------------
   * 3. A replay changes nothing, even when it disagrees
   * --------------------------------------------------------------------- */

  check(
    "the same event id delivered again is a duplicate",
    (await db.applyEvent({
      eventId: "evt_1",
      type: "customer.subscription.created",
      created: 1000,
      customerId: CUSTOMER,
      cloudSync: false,
      expiresAtMs: null,
    })) === "duplicate",
  );
  const afterReplay = await row();
  check(
    "and the row is exactly what the first delivery wrote — a replay cannot revoke either",
    afterReplay?.cloudSync === "true" && afterReplay?.expiresAt === iso(NOW + 3 * DAY),
  );

  /* ------------------------------------------------------------------------
   * 4. A cancellation, and the late event that must not undo it
   * --------------------------------------------------------------------- */

  check(
    "a cancellation at the period end writes false",
    (await db.applyEvent({
      eventId: "evt_2",
      type: "customer.subscription.deleted",
      created: 2000,
      customerId: CUSTOMER,
      cloudSync: false,
      expiresAtMs: NOW - DAY,
    })) === "applied",
  );
  check("the row is false, with the period end kept", (await row())?.cloudSync === "false");

  check(
    "an older event arriving late (a new id, an earlier created) loses",
    (await db.applyEvent({
      eventId: "evt_3",
      type: "customer.subscription.updated",
      created: 1500,
      customerId: CUSTOMER,
      cloudSync: true,
      expiresAtMs: NOW + 30 * DAY,
    })) === "stale",
  );
  check("so the cancelled row is not resurrected", (await row())?.cloudSync === "false");
  check(
    "and the stale delivery is recorded as such",
    (await one("select outcome || '|' || coalesce(user_id::text, 'null') from public.stripe_events where id = 'evt_3';")) ===
      `stale|${USER}`,
  );

  /* ------------------------------------------------------------------------
   * 5. Resubscribing works: newer is newer
   * --------------------------------------------------------------------- */

  check(
    "a reader who buys again after cancelling is granted again",
    (await db.applyEvent({
      eventId: "evt_4",
      type: "customer.subscription.created",
      created: 3000,
      customerId: CUSTOMER,
      cloudSync: true,
      expiresAtMs: NOW + 40 * DAY,
    })) === "applied" && (await row())?.cloudSync === "true",
  );

  /* ------------------------------------------------------------------------
   * 6. An attempt that died midway is finished by the retry
   * --------------------------------------------------------------------- */

  await one(
    "insert into public.stripe_events (id, type, created, customer_id) values ('evt_5', 'customer.subscription.updated', 4000, '" +
      CUSTOMER +
      "');",
  );
  check(
    "an event claimed but never applied is applied when it is delivered again",
    (await db.applyEvent({
      eventId: "evt_5",
      type: "customer.subscription.updated",
      created: 4000,
      customerId: CUSTOMER,
      cloudSync: true,
      expiresAtMs: NOW + 50 * DAY,
    })) === "applied",
  );
  check("and the row carries the new expiry", (await row())?.expiresAt === iso(NOW + 50 * DAY));

  /* ------------------------------------------------------------------------
   * 7. A row a different shop wrote is not this webhook's to revoke
   * --------------------------------------------------------------------- */

  await one(`update public.entitlements set source = 'apple', cloud_sync = true where user_id = '${USER}';`);
  check(
    "a Stripe cancellation cannot revoke an Apple purchase",
    (await db.applyEvent({
      eventId: "evt_6",
      type: "customer.subscription.deleted",
      created: 5000,
      customerId: CUSTOMER,
      cloudSync: false,
      expiresAtMs: null,
    })) === "kept_other_source",
  );
  check("the Apple row is untouched", (await row())?.source === "apple" && (await row())?.cloudSync === "true");

  /* ------------------------------------------------------------------------
   * 8. The customer link is one row per reader, and one reader per customer
   * --------------------------------------------------------------------- */

  let duplicateLink = false;
  try {
    await one(`insert into public.stripe_customers (user_id, customer_id) values ('${OTHER_USER}', '${CUSTOMER}');`);
  } catch {
    duplicateLink = true;
  }
  check("two readers cannot share one Stripe customer", duplicateLink);

  await db.linkCustomer(USER, "cus_second_purchase");
  check("linking again replaces the customer for that reader, one row", (await db.customerOf(USER)) === "cus_second_purchase");
  check("and there is still exactly one row for them", (await one(`select count(*) from public.stripe_customers where user_id = '${USER}';`)) === "1");

  /* ------------------------------------------------------------------------
   * 9. A client cannot write the row, and cannot read someone else's
   * --------------------------------------------------------------------- */

  const asClient = await sql(
    `set role authenticated;
     set request.jwt.claims = '{"sub":"${USER}"}';
     insert into public.entitlements (user_id, cloud_sync, source) values ('${USER}', true, 'stripe');`,
  );
  check(
    "an authenticated client's insert into entitlements is refused by RLS",
    asClient.ok === false && /row-level security|permission denied/i.test(asClient.stderr),
    asClient.stderr.split("\n")[0]?.slice(0, 90),
  );

  const readOwn = await sql(
    `set role authenticated;
     set request.jwt.claims = '{"sub":"${USER}"}';
     select count(*) from public.entitlements;`,
  );
  check("while the same client can read its own row", readOwn.ok && readOwn.stdout.trim() === "1", readOwn.stdout.trim());

  const readOther = await sql(
    `set role authenticated;
     set request.jwt.claims = '{"sub":"${OTHER_USER}"}';
     select count(*) from public.entitlements;`,
  );
  check("and sees nothing at all with somebody else's id", readOther.ok && readOther.stdout.trim() === "0", readOther.stdout.trim());

  const writeEvents = await sql(
    `set role authenticated;
     select count(*) from public.stripe_events;`,
  );
  check(
    "the event log is not readable by a client either",
    writeEvents.ok === false && /permission denied/i.test(writeEvents.stderr),
  );

  const callWriter = await sql(
    `set role authenticated;
     set request.jwt.claims = '{"sub":"${USER}"}';
     select public.apply_stripe_event('evt_7', 'x', 1, '${CUSTOMER}', true, null);`,
  );
  check(
    "and the event writer cannot be called from the client's session",
    callWriter.ok === false,
    callWriter.stderr.split("\n")[0]?.slice(0, 90),
  );

  /* ------------------------------------------------------------------------
   * 10. Two deliveries of the same event at the same moment
   * --------------------------------------------------------------------- */

  // Back to a Stripe-owned row: step 7 left an Apple purchase in place, and the
  // point of this check is the event id, not the other-shop guard.
  await one(`update public.entitlements set source = 'stripe' where user_id = '${USER}';`);

  const racing = await Promise.all([
    db.applyEvent({
      eventId: "evt_race",
      type: "customer.subscription.updated",
      created: 6000,
      customerId: "cus_second_purchase",
      cloudSync: true,
      expiresAtMs: NOW + 60 * DAY,
    }),
    db.applyEvent({
      eventId: "evt_race",
      type: "customer.subscription.updated",
      created: 6000,
      customerId: "cus_second_purchase",
      cloudSync: false,
      expiresAtMs: null,
    }),
  ]);
  check(
    "two simultaneous deliveries of one event id: one applies, the other is a duplicate",
    racing.filter((outcome) => outcome === "applied").length === 1 &&
      racing.filter((outcome) => outcome === "duplicate").length === 1,
    racing.join(","),
  );
} finally {
  await docker(["rm", "-f", CONTAINER]);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
