/**
 * Checks for pairing a phone with a device that can show the captcha.
 *
 *   node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
 *     tests/unit/pairing.mjs
 *
 * The module under test is pure, so every ticket here lives its whole life
 * between two numbers: issued at `T`, approved at `T + 10s`, redeemed at
 * `T + 20s`, dead at `T + 301s`. No server, no phone, no clock.
 *
 * What is asserted is what the two screens and the server all act on: the shape
 * of a code (eight digits, two groups, from the system's randomness), the four
 * transitions and the one phase that arrives by waiting, and every refusal --
 * expired, used, revoked, wrong code, another account's code, approved twice,
 * redeemed before anybody approved it. Then the credential the phone keeps, and
 * the one thing a hand-off must never carry: a session token.
 *
 * The last block reads the client's own wiring, because a pure module that
 * nothing calls is not a feature: the sign-in screen has to offer pairing, the
 * settings row has to show the code a phone is holding up.
 */
import { readFileSync } from "node:fs";

import {
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_TOKEN_BYTES,
  DEVICE_TOKEN_PREFIX,
  PAIRING_CODE_LENGTH,
  PAIRING_POLL_MS,
  PAIRING_TTL_MS,
  approvePairing,
  credentialSessionToken,
  credentialState,
  credentialUsable,
  deviceTokenOf,
  formatCode,
  isDeviceToken,
  issueCredential,
  issuePairing,
  newDeviceToken,
  newPairingCode,
  normalizeCode,
  pairingCountdown,
  pairingPayload,
  pairingRemaining,
  pairingState,
  pairingsAwaiting,
  redeemPairing,
  revokeCredential,
  revokePairing,
  touchCredential,
} from "../../src/lib/pairing.ts";
// The wire functions share their names with the transitions in the pure module
// (`redeemPairing` there takes a ticket, here it takes a code), so they are
// imported under names that say which side of the network they are on.
import {
  pairedSession,
  pendingPairings,
  redeemPairing as redeemOutThere,
  requestPairing,
  revokePairing as revokeOutThere,
} from "../../src/api/pairing.ts";

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
  checks += 1;
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}  ${detail === undefined ? "" : `(${JSON.stringify(detail)})`}`);
  }
}

const T = 1_760_000_000_000;
const ALICE = "alice";
const BOB = "bob";

/** The one sequence every test starts from, at the step it needs. */
function ticketAt(step, extra = {}) {
  let pairing = issuePairing({ label: "Phone", now: T, code: "42718093", ...extra });
  if (step === "issued") return pairing;
  pairing = ok(approvePairing(pairing, { account: ALICE, now: T + 10_000 }));
  if (step === "approved") return pairing;
  const redeemed = redeemPairing(pairing, { code: pairing.code, now: T + 20_000 });
  if (!redeemed.ok) throw new Error(`fixture could not redeem: ${redeemed.reason}`);
  if (step === "redeemed") return redeemed.pairing;
  return revokePairing(redeemed.pairing, { now: T + 30_000 });
}

function ok(step) {
  if (!step.ok) throw new Error(`fixture step refused: ${step.reason}`);
  return step.pairing;
}

/* ---------------------------------------------------------------------------
 * The code itself
 * ------------------------------------------------------------------------ */

check("a code is eight characters", newPairingCode().replace(" ", "").length === PAIRING_CODE_LENGTH);
check("…and every one of them is a digit", /^[0-9]{4} [0-9]{4}$/.test(newPairingCode()), newPairingCode());
check(
  "the display form is two groups of four, so it can be read aloud",
  formatCode("42718093") === "4271 8093",
  formatCode("42718093"),
);
check("formatting a code that is already formatted changes nothing", formatCode("4271 8093") === "4271 8093");

const drawn = Array.from({ length: 200 }, () => newPairingCode());
check("200 codes drawn in a row are 200 different codes", new Set(drawn).size === 200, new Set(drawn).size);
check(
  "…and none of them starts with a digit outside the alphabet's reach",
  drawn.every((code) => /^[0-9]{4} [0-9]{4}$/.test(code)),
);
// A uniform draw puts each digit at roughly 20 of 200 codes per position; a
// modulo-biased generator skews the first three low. The bound is loose on
// purpose: this catches a broken generator, not an unlucky one.
const firsts = new Map();
for (const code of drawn) firsts.set(code[0], (firsts.get(code[0]) ?? 0) + 1);
check(
  "every digit appears as a leading digit, so the draw is not biased to the low end",
  firsts.size === 10,
  [...firsts.keys()].sort().join(""),
);

check("a code is accepted with its space", normalizeCode("4271 8093") === "42718093");
check("…with a dash instead", normalizeCode("4271-8093") === "42718093");
check("…and bare", normalizeCode("42718093") === "42718093");
check("seven digits is not a code", normalizeCode("4271809") === null);
check("nine digits is not a code", normalizeCode("427180933") === null);
check("letters are not a code", normalizeCode("4271809a") === null);
check("nothing is not a code", normalizeCode("") === null && normalizeCode(null) === null && normalizeCode(7) === null);

check(
  "the module draws its randomness from crypto, never from Math.random",
  !/Math\.random\s*\(/.test(readFileSync(new URL("../../src/lib/pairing.ts", import.meta.url), "utf8")),
);
check(
  "…and the random source is named where it is used",
  /getRandomValues/.test(readFileSync(new URL("../../src/lib/pairing.ts", import.meta.url), "utf8")),
);
{
  // `crypto` is a getter on the global object, so it is put back by descriptor
  // rather than by assignment: in a module, assigning to a getter throws.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  delete globalThis.crypto;
  let threw = false;
  try {
    newPairingCode();
  } catch {
    threw = true;
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, "crypto", descriptor);
  }
  check("with no crypto available, asking for a code throws rather than improvising", threw);
  check("…and the source is back afterwards", typeof globalThis.crypto?.getRandomValues === "function");
}

/* ---------------------------------------------------------------------------
 * issued
 * ------------------------------------------------------------------------ */

const issued = issuePairing({ label: "Phone", now: T, code: "42718093" });
check("a new ticket is issued", pairingState(issued, T) === "issued");
check("…and belongs to nobody until somebody approves it", issued.account === null && issued.approvedAt === null);
check("…and expires five minutes after it was issued", issued.expiresAt === T + PAIRING_TTL_MS, issued.expiresAt);
check("…and carries the label the device gave", issued.label === "Phone");
check("a ticket with a lifetime of zero is refused", (() => {
  try {
    issuePairing({ label: "Phone", now: T, ttl: 0 });
    return false;
  } catch {
    return true;
  }
})());
check("a ticket whose code cannot be typed is refused", (() => {
  try {
    issuePairing({ label: "Phone", now: T, code: "12" });
    return false;
  } catch {
    return true;
  }
})());

/* ---------------------------------------------------------------------------
 * approved — the human press
 * ------------------------------------------------------------------------ */

const approved = ok(approvePairing(issued, { account: ALICE, now: T + 10_000 }));
check("an issued ticket can be approved", pairingState(approved, T + 10_000) === "approved");
check("approving binds it to the account that pressed", approved.account === ALICE);
check("…and stamps when", approved.approvedAt === T + 10_000);
check(
  "the same account pressing approve twice is not an error",
  (() => {
    const again = approvePairing(approved, { account: ALICE, now: T + 11_000 });
    return again.ok && again.pairing.account === ALICE && again.pairing.approvedAt === T + 10_000;
  })(),
);
check(
  "another account cannot take a ticket that is already bound",
  approvePairing(approved, { account: BOB, now: T + 11_000 }).reason === "wrong_account",
);
check(
  "an expired ticket cannot be approved",
  approvePairing(issued, { account: ALICE, now: T + PAIRING_TTL_MS }).reason === "expired",
);
check(
  "a revoked ticket cannot be approved",
  approvePairing(revokePairing(issued, { now: T + 1 }), { account: ALICE, now: T + 2 }).reason === "revoked",
);
check(
  "a spent ticket cannot be approved",
  approvePairing(ticketAt("redeemed"), { account: ALICE, now: T + 21_000 }).reason === "used",
);

/* ---------------------------------------------------------------------------
 * redeemed — the phone's one claim
 * ------------------------------------------------------------------------ */

const redeemed = redeemPairing(approved, { code: "4271 8093", now: T + 20_000 });
check("an approved ticket redeems", redeemed.ok === true);
check("redeeming marks it spent", redeemed.ok && pairingState(redeemed.pairing, T + 20_000) === "redeemed");
check(
  "…and hands over exactly one credential",
  redeemed.ok && isDeviceToken(redeemed.credential.token) && redeemed.credential.account === ALICE,
);
check(
  "the credential's token is 32 random bytes behind the extension's prefix",
  redeemed.ok &&
    redeemed.credential.token.length === DEVICE_TOKEN_PREFIX.length + DEVICE_TOKEN_BYTES * 2 &&
    /^hrd_[0-9a-f]+$/.test(redeemed.credential.token),
  redeemed.credential?.token,
);
check(
  "the credential is a session this app already knows how to send",
  redeemed.ok && credentialSessionToken(redeemed.credential) === `${ALICE}/${redeemed.credential.token}`,
);
check(
  "…and it is stored with the account it acts as, and the device's own name",
  redeemed.ok && redeemed.credential.label === "Phone" && redeemed.credential.revokedAt === null,
);
check("two credentials never share a token", issueCredential({ account: ALICE, label: "a", now: T }).token !== issueCredential({ account: ALICE, label: "b", now: T }).token);

/* --- every refusal, one at a time --------------------------------------- */

check("a code that is not eight digits is invalid", redeemPairing(approved, { code: "4271", now: T + 20_000 }).reason === "invalid_code");
check("a wrong code is refused", redeemPairing(approved, { code: "99999999", now: T + 20_000 }).reason === "wrong_code");
check("…and nothing is minted for it", redeemPairing(approved, { code: "99999999", now: T + 20_000 }).credential === undefined);
check("no ticket at all is a wrong code", redeemPairing(null, { code: "42718093", now: T }).reason === "wrong_code");
check(
  "a code nobody has approved yet says so, and is not a failure",
  redeemPairing(issued, { code: combined(issued), now: T + 5_000 }).reason === "not_approved",
);
check(
  "a code that ran out is expired",
  redeemPairing(approved, { code: combined(approved), now: T + PAIRING_TTL_MS }).reason === "expired",
);
check(
  "a code already claimed is used, and the second claim mints nothing",
  (() => {
    const again = redeemPairing(redeemed.pairing, { code: combined(approved), now: T + 25_000 });
    return again.reason === "used" && again.credential === undefined;
  })(),
);
check(
  "a withdrawn ticket is revoked",
  (() => {
    const revoked = revokePairing(approved, { now: T + 15_000 });
    return redeemPairing(revoked, { code: combined(approved), now: T + 16_000 }).reason === "revoked";
  })(),
);
check(
  "a device that names its own account is refused another account's code",
  redeemPairing(approved, { code: combined(approved), now: T + 20_000, account: BOB }).reason === "wrong_account",
);
check(
  "…while a signed-out phone, which cannot name one, is told only that the code is wrong",
  redeemPairing(approved, { code: "11111111", now: T + 20_000 }).reason ===
    redeemPairing(approved, { code: "11111111", now: T + 20_000, account: null }).reason,
);
check(
  "so the route cannot be asked which codes exist, or whose they are",
  redeemPairing(approved, { code: "11111111", now: T + 20_000 }).reason ===
    redeemPairing(ticketFor(BOB), { code: "11111111", now: T + 20_000 }).reason,
);
check(
  "the refused claim changed nothing: the ticket is still redeemable by its owner",
  redeemPairing(approved, { code: combined(approved), now: T + 20_000, account: BOB }).ok === false &&
    redeemPairing(approved, { code: combined(approved), now: T + 20_000, account: ALICE }).ok === true,
);

/** Another account's approved ticket, for the two "whose is it" checks. */
function ticketFor(account) {
  const own = issuePairing({ label: "Phone", now: T, code: "55550000" });
  return ok(approvePairing(own, { account, now: T + 1 }));
}

/** The digits of a ticket, as somebody would read them off the screen. */
function combined(pairing) {
  return pairing.code;
}

/* ---------------------------------------------------------------------------
 * revoked
 * ------------------------------------------------------------------------ */

check("an issued ticket can be withdrawn", pairingState(revokePairing(issued, { now: T + 1 }), T + 1) === "revoked");
check("…and stamps when", revokePairing(issued, { now: T + 1 }).revokedAt === T + 1);
check(
  "withdrawing twice is not an error, and does not move the stamp",
  revokePairing(revokePairing(issued, { now: T + 1 }), { now: T + 9_000 }).revokedAt === T + 1,
);
check(
  "a claimed ticket can be withdrawn afterwards too",
  pairingState(revokePairing(ticketAt("redeemed"), { now: T + 30_000 }), T + 30_000) === "revoked",
);
check(
  "revocation outranks expiry, because somebody decided it",
  pairingState(revokePairing(issued, { now: T + 1 }), T + PAIRING_TTL_MS + 1) === "revoked",
);

/* ---------------------------------------------------------------------------
 * What a signed-in device is offered, and for how long
 * ------------------------------------------------------------------------ */

check(
  "only issued tickets are offered for approval",
  pairingsAwaiting([issued, approved, ticketAt("redeemed"), ticketAt("revoked")], T + 30_000).length === 1,
);
check(
  "an expired ticket is not offered",
  pairingsAwaiting([issued], T + PAIRING_TTL_MS).length === 0,
);
check(
  "the newest code is offered first",
  (() => {
    const older = issuePairing({ label: "Tablet", now: T - 60_000, code: "11112222" });
    const newer = issuePairing({ label: "Phone", now: T, code: "33334444" });
    return pairingsAwaiting([older, newer], T).map((entry) => entry.label).join(",") === "Phone,Tablet";
  })(),
);

check("a fresh ticket has its whole lifetime left", pairingRemaining(issued, T) === PAIRING_TTL_MS);
check("…less what has passed", pairingRemaining(issued, T + 60_000) === PAIRING_TTL_MS - 60_000);
check("…and never goes below zero", pairingRemaining(issued, T + PAIRING_TTL_MS * 2) === 0);
check("the countdown reads m:ss", pairingCountdown(issued, T) === "5:00", pairingCountdown(issued, T));
check("…counting down", pairingCountdown(issued, T + 53_000) === "4:07", pairingCountdown(issued, T + 53_000));
check("…rounding up, so it never reads 0:00 while time is left", pairingCountdown(issued, T + 299_500) === "0:01");
check("…and stopping at 0:00", pairingCountdown(issued, T + PAIRING_TTL_MS) === "0:00");
check("phones are told how often to ask", PAIRING_POLL_MS > 0 && PAIRING_POLL_MS <= 5_000, PAIRING_POLL_MS);

/* ---------------------------------------------------------------------------
 * The hand-off payload
 * ------------------------------------------------------------------------ */

const payload = pairingPayload(approved);
check(
  "the payload is the code, the login it will bind to, the label and the deadline",
  JSON.stringify(Object.keys(payload).sort()) === '["code","expiresAt","label","login","v"]',
  Object.keys(payload).sort(),
);
check("the payload carries the login, so the phone can say whose it is joining", payload.login === ALICE);
check("a signed-out code carries no login at all", pairingPayload(issued).login === null);
check(
  "the payload cannot carry a token: there is no field for one",
  !Object.keys(payload).some((key) => /token|secret|password|session|auth/i.test(key)),
  Object.keys(payload),
);
check(
  "…and json-encoding it does not leak the credential that was minted beside it",
  (() => {
    const credential = issueCredential({ account: ALICE, label: "Phone", now: T });
    const handoff = JSON.stringify(pairingPayload(approved));
    return !handoff.includes(credential.token) && !handoff.includes("hrd_");
  })(),
);
check(
  "the module's payload builder names every field it sends, so a new ticket field cannot ride along",
  /export function pairingPayload\(pairing: Pairing\): PairingPayload \{\n  return \{\n    v: 1,/.test(
    readFileSync(new URL("../../src/lib/pairing.ts", import.meta.url), "utf8"),
  ),
);

/* ---------------------------------------------------------------------------
 * The credential the phone keeps
 * ------------------------------------------------------------------------ */

const credential = issueCredential({ account: ALICE, label: "Phone", now: T });
check("a credential is live when it is made", credentialState(credential, T) === "live");
check("…and usable", credentialUsable(credential, T));
check("…for ninety days", credential.expiresAt === T + DEVICE_CREDENTIAL_TTL_MS);
check("using it does not change whether it is alive", credentialUsable(credential, T + DEVICE_CREDENTIAL_TTL_MS - 1));
check(
  "…but ninety days after its last use it is not",
  !credentialUsable(credential, T + DEVICE_CREDENTIAL_TTL_MS),
);
check(
  "using it slides the deadline forward instead of wearing it down",
  touchCredential(credential, T + DEVICE_CREDENTIAL_TTL_MS - 1).expiresAt === T + 2 * DEVICE_CREDENTIAL_TTL_MS - 1,
);
check(
  "…and stamps the use",
  touchCredential(credential, T + 5_000).lastUsedAt === T + 5_000,
);
check(
  "a dead credential is not revived by being used",
  !credentialUsable(touchCredential(credential, T + DEVICE_CREDENTIAL_TTL_MS), T + DEVICE_CREDENTIAL_TTL_MS),
);
check("revoking a credential kills it", credentialState(revokeCredential(credential, T + 10), T + 10) === "revoked");
check("…and is idempotent", revokeCredential(revokeCredential(credential, T + 10), T + 20).revokedAt === T + 10);
check("…and outranks expiry", credentialState(revokeCredential(credential, T + 10), T + DEVICE_CREDENTIAL_TTL_MS * 2) === "revoked");
check(
  "revoking does not change the token, so the server can find the record it must kill",
  revokeCredential(credential, T + 10).token === credential.token,
);

const session = pairedSession(credential, "https://reader.test/");
check("the paired session names the server without a trailing slash", session.serverUrl === "https://reader.test");
check("…the account it acts as", session.email === ALICE);
check("…and the device token in the slot every call site already sends", session.token === `${ALICE}/${credential.token}`);
check("…on FreshRSS's own API prefix", session.apiPath === "/api/greader.php", session.apiPath);
check("the token half can be taken back out, for revocation", deviceTokenOf(session.token) === credential.token);
check("an API password session has no device token to revoke", deviceTokenOf("alice/0123456789abcdef") === null);
check("a token that is not the extension's shape is not accepted", !isDeviceToken("hrd_1234") && !isDeviceToken(42));
check("a fresh device token is the shape the app checks for", isDeviceToken(newDeviceToken()));

/* ---------------------------------------------------------------------------
 * The wire client, against a transport that answers like the server does
 * ------------------------------------------------------------------------ */

const SERVER = "https://reader.example";
const DEVICE_TOKEN = `hrd_${"a".repeat(64)}`;

/** A transport that always answers the same thing, and remembers what it was asked. */
function answers(status, body) {
  const seen = [];
  const transport = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { transport, seen };
}

const missing = answers(404, { error: { code: "route_not_found", message: "Unknown route." } });
check(
  "an extension without the pairing routes offers no pairing, rather than failing",
  (await requestPairing(missing.transport, { serverUrl: SERVER, label: "Phone" })).kind === "unavailable",
);

const storeless = answers(503, { error: { code: "pairing_unavailable", message: "Pairing is not available on this server." } });
check(
  "…and a router newer than its store says the same thing",
  (await requestPairing(storeless.transport, { serverUrl: SERVER, label: "Phone" })).kind === "unavailable",
  storeless.seen.length,
);

const offered = answers(200, { code: "4271 8093", label: "Phone", expiresAt: T + PAIRING_TTL_MS });
const ask = await requestPairing(offered.transport, { serverUrl: SERVER, label: "Phone" });
check("a code comes back as a code, with the deadline the server set", ask.kind === "code" && ask.offer.expiresAt === T + PAIRING_TTL_MS);
check(
  "…from the route under the extension, with the label and nothing else in the body",
  offered.seen[0].url === `${SERVER}/api/misc.php/Hardly%20Read/v1/pair/request` &&
    offered.seen[0].init.body === JSON.stringify({ label: "Phone" }),
  offered.seen[0].url,
);
check(
  "…and no Authorization header, because nobody is signed in yet",
  offered.seen[0].init.headers.Authorization === undefined,
);

const waiting = answers(409, { error: { code: "not_approved", message: "That pairing code has not been approved yet." } });
check(
  "a code nobody has approved is the waiting state, not an error",
  (await redeemOutThere(waiting.transport, { serverUrl: SERVER, code: "4271 8093", label: "Phone" })).kind === "waiting",
);

const spent = answers(409, { error: { code: "used", message: "That pairing code has already been used." } });
const spentAnswer = await redeemOutThere(spent.transport, { serverUrl: SERVER, code: "4271 8093", label: "Phone" });
check("…and a code already spent is a refusal, with the reason the module names", spentAnswer.kind === "refused" && spentAnswer.reason === "used");

const granted = answers(200, { token: DEVICE_TOKEN, account: ALICE, label: "Phone", expiresAt: T + DEVICE_CREDENTIAL_TTL_MS });
const grantedAnswer = await redeemOutThere(granted.transport, { serverUrl: SERVER, code: "4271 8093", label: "Phone" });
check("a redeem hands back a credential", grantedAnswer.kind === "paired" && grantedAnswer.credential.token === DEVICE_TOKEN);
check(
  "…that keeps the account it acts as, so every later call can name the login",
  grantedAnswer.kind === "paired" && grantedAnswer.credential.account === ALICE,
);
check(
  "the phone's session is that credential in the GoogleLogin slot — no password was ever involved",
  grantedAnswer.kind === "paired" &&
    pairedSession(grantedAnswer.credential, `${SERVER}/`).token === `${ALICE}/${DEVICE_TOKEN}` &&
    pairedSession(grantedAnswer.credential, `${SERVER}/`).email === ALICE,
);

const nonsense = answers(200, { token: "s3cr3t", account: ALICE });
check(
  "a token that is not the extension's shape is not stored, whatever the server says",
  (await redeemOutThere(nonsense.transport, { serverUrl: SERVER, code: "4271 8093", label: "Phone" })).kind === "failed",
);

const listed = answers(200, { pairings: [{ code: "4271 8093", label: "Phone", issuedAt: T, expiresAt: T + PAIRING_TTL_MS }] });
const list = await pendingPairings(listed.transport, { serverUrl: SERVER, token: `${ALICE}/${DEVICE_TOKEN}` });
check("the approving screen gets the codes waiting, with their deadlines", list.available && list.pairings.length === 1 && list.pairings[0].expiresAt === T + PAIRING_TTL_MS);
check(
  "…asking as the signed-in device, with the credential it already has",
  listed.seen[0].init.headers.Authorization === `GoogleLogin auth=${ALICE}/${DEVICE_TOKEN}`,
);
check(
  "…and a server with no pairing shows an empty list rather than an error",
  (await pendingPairings(storeless.transport, { serverUrl: SERVER, token: `${ALICE}/${DEVICE_TOKEN}` })).available === false,
);

const withdrawn = answers(200, { revoked: true });
const decline = await revokeOutThere(withdrawn.transport, { serverUrl: SERVER, token: `${ALICE}/${DEVICE_TOKEN}` });
check("a device withdraws its own credential by presenting it", decline.kind === "revoked");
check(
  "…on the same header as every other call, so the server knows which account it is",
  withdrawn.seen[0].init.headers.Authorization === `GoogleLogin auth=${ALICE}/${DEVICE_TOKEN}`,
);
check(
  "…with nothing in the body that could name another device",
  withdrawn.seen[0].init.body === undefined,
);

/* ---------------------------------------------------------------------------
 * The client wiring: the module is called, not merely written
 * ------------------------------------------------------------------------ */

const apiSource = readFileSync(new URL("../../src/api/pairing.ts", import.meta.url), "utf8");
for (const [route, path] of Object.entries({
  request: "/pair/request",
  pending: "/pair/pending",
  approve: "/pair/approve",
  redeem: "/pair/redeem",
  revoke: "/pair/revoke",
})) {
  check(`the client calls ${path}`, apiSource.includes(`"${path}"`), route);
}
check(
  "request and redeem send no credential, because a signing-in phone has none",
  /request: async \(transport, options\)|export async function requestPairing[\s\S]{0,400}method: "POST",\n      body: \{ label: options\.label \}/.test(
    apiSource,
  ),
);
check(
  "…and the redeem body is the code and the label, and nothing else",
  /export async function redeemPairing[\s\S]{0,400}body: \{ code: options\.code, label: options\.label \}/.test(apiSource),
);
check(
  "a server without the pairing routes reads as unavailable, not as a failure",
  /function noPairing[\s\S]{0,160}status === 404/.test(apiSource),
);
check(
  "the server's obligations are written down in the client, where the next reader looks",
  /## SERVER MUST/.test(apiSource) && /rate limit/i.test(apiSource),
);
check(
  "the client refuses to store anything that is not the extension's token shape",
  /isDeviceToken\(token\)/.test(apiSource),
);

const loginSource = readFileSync(new URL("../../src/views/Login.svelte", import.meta.url), "utf8");
check("the sign-in screen offers pairing", /pair/i.test(loginSource) && /Pair this/.test(loginSource));
check(
  "…only on a phone, because that is the device without a way to answer the captcha",
  /detectShape\(\)/.test(loginSource),
);
check("…shows the code it was given", /pairing\.code|offer\.code/.test(loginSource));
check("…shows the waiting state, so the screen is not a dead end", /waiting|Approve|approve/i.test(loginSource));
check("…and counts the code down with the same formatter the settings row uses", /pairingCountdown/.test(loginSource));
check(
  "…and keeps the API-password field as the fallback for a server without pairing",
  /API password/.test(loginSource),
);

const accountsSource = readFileSync(new URL("../../src/components/AccountsBody.svelte", import.meta.url), "utf8");
check("the settings Accounts section offers 'pair a device'", /Pair a device/.test(accountsSource));
check("…shows the pending code and a countdown", /pending/i.test(accountsSource) && /pairingCountdown/.test(accountsSource));
check("…asks the server for the pending list while it is open", /pendingPairings\(/.test(accountsSource));
check("…and lets a paired phone revoke what it was given", /revokePairing\(/.test(accountsSource));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
