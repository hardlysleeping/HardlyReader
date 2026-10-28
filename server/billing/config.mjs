/**
 * The service's settings, read once, refused loudly.
 *
 * This process holds the `service_role` key, which bypasses row-level security,
 * and the Stripe secret key. Neither is ever echoed: the startup line says which
 * names are *set*, never what they are, because a log line is the easiest place
 * to leak a key that nobody thinks of as code.
 *
 * A missing setting is a refusal to start rather than a service that runs and
 * refuses every event — a webhook that is up but unconfigured looks healthy on a
 * dashboard while quietly 400-ing every payment.
 */
import { pricesFromEnv } from "./plans.mjs";

/** Everything the service needs, by name. */
export const REQUIRED = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY",
  "STRIPE_PRICE_YEARLY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_ANON_KEY",
  "APP_URL",
];

/** Reads the environment into the shape the app wants, or throws with the names. */
export function readConfig(env) {
  const missing = REQUIRED.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(`missing required setting(s): ${missing.join(", ")}`);
  }

  const appUrl = env.APP_URL.replace(/\/$/, "");
  if (!/^https?:\/\//.test(appUrl)) {
    throw new Error("APP_URL must be an http(s) origin, e.g. https://app.example");
  }

  // The PWA's origin is where a browser tab will call from. An empty list means
  // "no browser may call this", which is the right default for a desktop build.
  const origins = (env.APP_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter((origin) => origin !== "");

  const port = Number.parseInt(env.PORT ?? "8787", 10);
  if (!Number.isFinite(port) || port <= 0) throw new Error("PORT must be a number");

  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    appUrl,
    origins,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET.trim(),
    stripeSecretKey: env.STRIPE_SECRET_KEY.trim(),
    // Only so a suite can point the client at a local stub; unset in production,
    // where `StripeApi` uses the real API.
    stripeApiBase: (env.STRIPE_API_BASE ?? "").trim() || undefined,
    prices: pricesFromEnv(env),
    supabase: {
      url: env.SUPABASE_URL.trim(),
      serviceKey: env.SUPABASE_SERVICE_KEY.trim(),
      anonKey: env.SUPABASE_ANON_KEY.trim(),
    },
  };
}

/** One line for the log: the shape of the configuration, never its secrets. */
export function describeConfig(config) {
  return {
    listen: `${config.host}:${config.port}`,
    appUrl: config.appUrl,
    origins: config.origins,
    prices: {
      monthly: config.prices.monthly === null ? "unset" : "set",
      yearly: config.prices.yearly === null ? "unset" : "set",
    },
    supabase: config.supabase.url,
  };
}
