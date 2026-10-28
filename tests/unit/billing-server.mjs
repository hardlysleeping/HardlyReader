/**
 * The billing service as a process: `node server/billing/main.mjs`, over a socket.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/billing-server.mjs
 *
 * Every other suite calls the handler directly, which skips the adapter that in
 * production is the only thing there: `http.IncomingMessage` → `Request`, the
 * body read as bytes (the webhook signs bytes, and a re-encoded body fails every
 * time), the response written back. This suite starts the real process, points
 * its two upstreams — Stripe and Supabase — at a stub on localhost, and drives it
 * with `fetch`, so the wiring that no double covers is covered here.
 *
 * The stub is the two APIs' shapes, not their behaviour: what the *service* does
 * with a signature, a plan and an event is asserted; what Stripe does is not.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { signPayload } from "../../server/billing/signature.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;

let checks = 0;
let failures = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const SECRET = "whsec_process_test";
const TOKEN = "jwt_process_test";
const USER = "33333333-3333-3333-3333-333333333333";
// Real time, because the service refuses a signature older than 300 seconds and
// this suite talks to it over a socket: a fixed timestamp would be a replay.
const AT = Math.floor(Date.now() / 1000);
const PERIOD_END = AT + 86_400 * 30;

/* --------------------------------------------------------------------------
 * The two upstreams, on one stub: /v1/… is Stripe, /rest/v1/… and /auth/v1/… are
 * Supabase. Same split the real world has, one socket.
 * ----------------------------------------------------------------------- */

const seen = { customers: [], sessions: [], rpc: [], links: [] };

const stub = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://stub");
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    // --- Supabase Auth: who is this token?
    if (url.pathname === "/auth/v1/user") {
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (bearer !== TOKEN) return send(401, { message: "bad jwt" });
      return send(200, { id: USER, email: "reader@example.test" });
    }

    // --- PostgREST: the customer link
    if (url.pathname === "/rest/v1/stripe_customers" && request.method === "GET") {
      return send(200, seen.links.map((link) => ({ customer_id: link.customer_id })));
    }
    if (url.pathname === "/rest/v1/stripe_customers" && request.method === "POST") {
      seen.links.push(...JSON.parse(body));
      response.writeHead(201, { "content-type": "application/json" });
      return response.end("");
    }

    // --- PostgREST: the one RPC that writes the row
    if (url.pathname === "/rest/v1/rpc/apply_stripe_event") {
      seen.rpc.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify("applied"));
    }

    // --- Stripe
    if (url.pathname === "/v1/customers" && request.method === "POST") {
      seen.customers.push(Object.fromEntries(new URLSearchParams(body)));
      return send(200, { id: `cus_stub_${seen.customers.length}` });
    }
    if (url.pathname === "/v1/checkout/sessions" && request.method === "POST") {
      seen.sessions.push(Object.fromEntries(new URLSearchParams(body)));
      return send(200, { id: "cs_stub_1", url: "https://checkout.stripe.com/c/pay/cs_stub_1" });
    }
    if (url.pathname.startsWith("/v1/prices/")) {
      const yearly = url.pathname.endsWith("year");
      return send(200, {
        id: url.pathname.split("/").pop(),
        unit_amount: yearly ? 999 : 99,
        currency: "usd",
        recurring: { interval: yearly ? "year" : "month" },
      });
    }
    if (url.pathname.startsWith("/v1/subscriptions/")) {
      return send(200, {
        id: url.pathname.split("/").pop(),
        status: "active",
        customer: "cus_stub_1",
        items: { data: [{ price: { id: "price_year" }, current_period_end: PERIOD_END }] },
      });
    }

    return send(404, { error: "no stub for this path", path: url.pathname });
  });
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;
const stubBase = `http://127.0.0.1:${stubPort}`;

/* --------------------------------------------------------------------------
 * The process
 * ----------------------------------------------------------------------- */

// A port for the service itself, found by asking the OS for one and letting go.
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [join(ROOT, "server/billing/main.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    STRIPE_SECRET_KEY: "sk_test_process",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_MONTHLY: "price_month",
    STRIPE_PRICE_YEARLY: "price_year",
    STRIPE_API_BASE: stubBase,
    SUPABASE_URL: stubBase,
    SUPABASE_SERVICE_KEY: "service_role_key_for_the_test",
    SUPABASE_ANON_KEY: "anon_key_for_the_test",
    APP_URL: "https://app.test",
    APP_ORIGINS: "https://app.test",
    PORT: String(port),
    HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

/** Waits for the process to answer, or gives up. */
async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function post(path, { body = "", headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/** A Stripe delivery, signed with the secret the process was given. */
function delivery(event, { secret = SECRET } = {}) {
  const raw = Buffer.from(JSON.stringify(event));
  return {
    body: raw.toString(),
    headers: { "content-type": "application/json", "stripe-signature": signPayload(raw, secret, Math.floor(Date.now() / 1000)) },
  };
}

const alive = await waitForHealth();
check("the process starts, listens and answers /health", alive);

if (alive) {
  const health = await fetch(`${base}/health`);
  check("and it is a JSON answer", (health.headers.get("content-type") ?? "").includes("application/json"));

  {
    const response = await fetch(`${base}/plans`);
    const plans = await response.json();
    check(
      "what it sells comes back priced by Stripe",
      response.status === 200 && plans.plans[0].price === "$9.99" && plans.plans[1].price === "$0.99",
      JSON.stringify(plans.plans),
    );
  }

  {
    const result = await post("/checkout", {
      body: JSON.stringify({ plan: "yearly" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    check("a signed-in reader gets a Checkout URL", result.status === 200 && result.body.url === "https://checkout.stripe.com/c/pay/cs_stub_1");
    check("the customer was created against the stub", seen.customers[0]?.["metadata[supabase_user_id]"] === USER);
    check("the link was written before the session", seen.links[0]?.user_id === USER && seen.links[0]?.customer_id === "cus_stub_1");
    check("the session is a subscription on the yearly price", seen.sessions[0]?.["line_items[0][price]"] === "price_year" && seen.sessions[0]?.mode === "subscription");
  }

  {
    const result = await post("/checkout", {
      body: JSON.stringify({ plan: "monthly" }),
      headers: { "content-type": "application/json", authorization: "Bearer not_a_token" },
    });
    check("a token the auth server refuses is a 401, over a real socket", result.status === 401);
  }

  {
    const result = await post("/stripe/webhook", { body: '{"id":"evt_1"}' });
    check("an unsigned webhook delivery is refused over a real socket", result.status === 400);
  }

  {
    const event = {
      id: "evt_process",
      type: "customer.subscription.created",
      created: AT,
      data: {
        object: {
          id: "sub_1",
          status: "active",
          customer: "cus_stub_1",
          items: { data: [{ price: { id: "price_year" }, current_period_end: PERIOD_END }] },
        },
      },
    };
    const result = await post("/stripe/webhook", delivery(event));
    check("a signed delivery is applied", result.status === 200 && result.body.outcome === "applied");
    const call = seen.rpc[0] ?? {};
    check(
      "the RPC it called carries the customer, the grant and the period end",
      call.p_customer === "cus_stub_1" && call.p_cloud_sync === true && call.p_expires_at === new Date(PERIOD_END * 1000).toISOString(),
      JSON.stringify(call),
    );
    check("and the event id, so the database can spend it once", call.p_event_id === "evt_process");

    const again = await post("/stripe/webhook", delivery(event));
    check("the same delivery again is still answered 200", again.status === 200);
    check("and it reached the database a second time, which is what remembers", seen.rpc.length === 2);
  }

  check(
    "the process logged its requests as JSON, and no key appears in them",
    /"event":"listening"/.test(output) && !output.includes(SECRET) && !output.includes("sk_test_process") && !output.includes("service_role_key_for_the_test"),
    output.split("\n")[0]?.slice(0, 80),
  );
}

/* --------------------------------------------------------------------------
 * A misconfigured process refuses to start rather than 400-ing every payment
 * ----------------------------------------------------------------------- */

{
  const broken = spawn(process.execPath, [join(ROOT, "server/billing/main.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  broken.stdout.on("data", (chunk) => (said += chunk.toString()));
  broken.stderr.on("data", (chunk) => (said += chunk.toString()));
  const exitCode = await new Promise((resolve) => broken.on("exit", (code) => resolve(code)));
  check("with no settings at all it exits non-zero instead of half-working", exitCode !== 0, `exit ${exitCode}`);
  check("and says which names are missing", /missing required setting/.test(said) && /STRIPE_SECRET_KEY/.test(said));
}

child.kill("SIGTERM");
const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve("still running"), 3000);
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    resolve(signal === null ? `exit ${code}` : signal);
  });
});
check("SIGTERM stops it cleanly", exited === "exit 0", exited);

await new Promise((resolve) => stub.close(resolve));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
