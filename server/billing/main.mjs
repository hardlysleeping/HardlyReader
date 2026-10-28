/**
 * The process: one HTTP server, one log line per request, no framework.
 *
 * Node's `http` speaks `IncomingMessage`; everything above speaks `Request` and
 * `Response`, because that is what the suite can build without a socket and what
 * a host that is not Node could accept unchanged. The body is read to a buffer
 * before it is handed over for one reason: the webhook signs the *bytes*, so a
 * streaming adapter that re-encoded them would reject every delivery.
 *
 *     PORT=8787 node server/billing/main.mjs
 *
 * It binds loopback by default; `HOST=0.0.0.0` is for a container or a reverse
 * proxy in front of it, and the doc says so.
 */
import { createServer } from "node:http";

import { createBillingApp, MAX_BODY_BYTES } from "./app.mjs";
import { describeConfig, readConfig } from "./config.mjs";
import { SupabaseDb } from "./db.mjs";
import { SupabaseAuth } from "./auth.mjs";
import { StripeApi } from "./stripe-api.mjs";
import { Offer } from "./plans.mjs";

const log = {
  info: (event, fields = {}) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  warn: (event, fields = {}) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
  error: (event, fields = {}) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};

let config;
try {
  config = readConfig(process.env);
} catch (cause) {
  log.error("config_refused", { error: String(cause.message ?? cause) });
  process.exit(1);
}

const db = new SupabaseDb({ url: config.supabase.url, serviceKey: config.supabase.serviceKey });
const auth = new SupabaseAuth({ url: config.supabase.url, anonKey: config.supabase.anonKey });
const stripe = new StripeApi({ secretKey: config.stripeSecretKey });
const offer = new Offer({ stripe, prices: config.prices });

const handle = createBillingApp({ config, db, stripe, auth, offer, log });

const server = createServer(async (request, response) => {
  const started = Date.now();
  try {
    const body = await readBody(request);
    if (body === null) {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "too_large" }));
      return;
    }
    const url = `http://${request.headers.host ?? `${config.host}:${config.port}`}${request.url ?? "/"}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const webRequest = new Request(url, {
      method: request.method ?? "GET",
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    });
    const webResponse = await handle(webRequest);
    const out = Buffer.from(await webResponse.arrayBuffer());
    const responseHeaders = {};
    webResponse.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    responseHeaders["content-length"] = String(out.byteLength);
    response.writeHead(webResponse.status, responseHeaders);
    response.end(out);
  } catch (cause) {
    log.error("unhandled", { error: String(cause) });
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "internal" }));
  } finally {
    log.info("request", {
      method: request.method,
      path: (request.url ?? "/").split("?")[0],
      ms: Date.now() - started,
      status: response.statusCode,
    });
  }
});

/** The body as bytes, or null when it is over the cap. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", reject);
  });
}

server.listen(config.port, config.host, () => {
  log.info("listening", describeConfig(config));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log.info("stopping", { signal });
    server.close(() => process.exit(0));
  });
}
