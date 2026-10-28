/**
 * Stripe's webhook signature, verified without the Stripe SDK.
 *
 * The header is `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>…]`, and the HMAC
 * is SHA-256 over `<t>.<raw body>` keyed with the endpoint's signing secret. The
 * raw bytes matter: re-serialising the JSON before hashing is the classic way to
 * reject every real delivery, which is why the webhook reads the body as bytes
 * and never as a parsed object.
 *
 * Two `v1` signatures can be present while a secret is being rolled, so any one
 * of them matching is a pass. An old timestamp is a failure even when the
 * signature is right — that is the replay window, and 300 seconds is Stripe's
 * own default.
 *
 * @typedef {{ ok: true } | { ok: false, reason: "missing_header" | "malformed_header" | "no_signature" | "stale_timestamp" | "mismatch" }} VerifyResult
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The header Stripe signs with. */
export const SIGNATURE_HEADER = "stripe-signature";

/** How far the signed timestamp may be from now, in seconds. */
export const TOLERANCE_SECONDS = 300;

/**
 * Whether `payload` was signed by `secret` and is recent.
 *
 * `nowSeconds` is injected so the suite can test the replay window without
 * waiting five minutes.
 *
 * @param {Uint8Array} payload
 * @param {string | null | undefined} header
 * @param {string} secret
 * @param {{ nowSeconds?: number, toleranceSeconds?: number }} [options]
 * @returns {VerifyResult}
 */
export function verifySignature(payload, header, secret, options = {}) {
  if (typeof header !== "string" || header.trim() === "") return { ok: false, reason: "missing_header" };
  if (secret === "") return { ok: false, reason: "mismatch" };

  /** @type {number | null} */
  let timestamp = null;
  /** @type {string[]} */
  const signatures = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1" && value !== "") {
      signatures.push(value);
    }
  }
  if (timestamp === null) return { ok: false, reason: "malformed_header" };
  if (signatures.length === 0) return { ok: false, reason: "no_signature" };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "stale_timestamp" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest();
  for (const signature of signatures) {
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length) continue;
    if (timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}

/**
 * The header a sender would produce, for the suite and for a local `curl`.
 *
 * @param {Uint8Array} payload
 * @param {string} secret
 * @param {number} [timestampSeconds]
 * @returns {string}
 */
export function signPayload(payload, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(payload).digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}
