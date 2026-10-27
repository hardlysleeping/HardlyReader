/**
 * Pairing a phone with a device that can answer a captcha.
 *
 * The login captcha is a human check, and this module does not get around it.
 * It moves it: the human answers it once, on the device that can render the
 * page, and that device then vouches for the phone. The phone receives a code,
 * not a captcha, and in exchange it is given one credential — its own, short
 * lived at the moment of hand-over, revocable afterwards.
 *
 * ## The shape of the hand-off
 *
 * A pairing ticket is a short code plus the times it was issued, approved,
 * redeemed and revoked. It is the whole state machine, and it is deliberately
 * dumb data: nothing here holds a password, a session token or an API response.
 *
 *     issued ──approve──▶ approved ──redeem──▶ redeemed
 *        │                   │                   │
 *        └────revoke─────┬───┴────revoke─────────┘
 *                        ▼
 *                     revoked          (and, at any point: expired)
 *
 * Who does which step, and why it is that way:
 *
 * - **issued** — the phone asks for a code. It is signed out, so this is the one
 *   request that cannot carry a credential: the code *is* the credential, and
 *   it is worth nothing until a signed-in human approves it.
 * - **approved** — a person, on a device already signed in, reads the code off
 *   the phone and confirms it. That press is the human check. It is also where
 *   the code becomes bound to one account: before this, the ticket belongs to
 *   nobody and can be approved into any account on the server.
 * - **redeemed** — the phone hands the code over once and receives a device
 *   token. A second redeem is refused: a code is a one-time hand-over, not a
 *   password.
 * - **revoked** — either side can end it. The phone can drop what it was given,
 *   and a device that is lost does not have to wait out the clock.
 *
 * ## What a code is worth, and why the alphabet is digits
 *
 * Eight digits, grouped `1234 5678`. The code is read off one screen and typed
 * into another, usually on a phone, often one-handed: ten symbols that are all
 * distinguishable is worth more there than the extra entropy of letters, which
 * buys two dozen bits and costs a mistyped code every few attempts. What the
 * shorter alphabet costs is made up for by the clock, not by the code: a ticket
 * lives five minutes, is single use, and the server is expected to rate-limit
 * guesses by client (see `SERVER MUST` in `src/api/pairing.ts`). Twenty-six bits
 * is not a lot of entropy; five minutes and a locked door is what makes it
 * enough.
 *
 * ## What is never in here
 *
 * A session token. The ticket carries a code, a label and timestamps; the
 * credential the phone gets back is minted by the server at redeem time and is
 * never part of the hand-off. `pairingPayload()` is the one place a payload is
 * built, and it exists so that a future QR carries the same four fields and
 * cannot quietly grow a token.
 *
 * Pure: no fetch, no storage, no clock of its own. Every function takes `now`,
 * so a suite can walk a ticket through its whole life in microseconds.
 */

/** Digits a phone keypad has one key for, and nobody confuses. */
export const PAIRING_ALPHABET = "0123456789";

/** How many characters a code has. Eight, because the server allots 8 digits. */
export const PAIRING_CODE_LENGTH = 8;

/**
 * How long a code is worth anything.
 *
 * Long enough to walk a phone to a desktop and read eight digits, short enough
 * that a code seen over a shoulder is worthless by the time it is typed
 * somewhere else.
 */
export const PAIRING_TTL_MS = 5 * 60_000;

/** How often a waiting phone should ask whether it has been approved. */
export const PAIRING_POLL_MS = 2_000;

/** Every device token the extension mints starts with this. */
export const DEVICE_TOKEN_PREFIX = "hrd_";

/** Bytes of randomness in a device token. 256 bits: not a guessable secret. */
export const DEVICE_TOKEN_BYTES = 32;

/**
 * How long a paired device stays signed in, refreshed every time it is used.
 *
 * Ninety days, sliding: a phone in a drawer comes back signed out, a phone in a
 * pocket never notices.
 */
export const DEVICE_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The phases a ticket can be in, plus the one it reaches by waiting. */
export type PairingPhase = "issued" | "approved" | "redeemed" | "revoked";
export type PairingState = PairingPhase | "expired";

/**
 * A pairing ticket, as the server stores it and as both screens draw it.
 *
 * Timestamps rather than a status field: a status that disagreed with the
 * timestamps would be a second truth, and the one thing a state machine must
 * not have is two of them. `stateOf()` derives the phase from these.
 */
export interface Pairing {
  /** Display form, `1234 5678`. The stored value is this, spaces and all. */
  code: string;
  /** What the asking device called itself. Shown on the approving screen. */
  label: string;
  /** The login that approved it, or null while nobody has. */
  account: string | null;
  issuedAt: number;
  expiresAt: number;
  approvedAt: number | null;
  redeemedAt: number | null;
  revokedAt: number | null;
}

/**
 * What a paired device keeps, and what it can revoke.
 *
 * The token is the server's, handed over once. `account` is the login it acts
 * as; `label` is what it called itself when it asked. Nothing here is a
 * FreshRSS password and nothing here can be used to sign in anywhere else.
 */
export interface DeviceCredential {
  token: string;
  account: string;
  label: string;
  pairedAt: number;
  lastUsedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/** Why a step did not happen. Every one of these is a screen or a status code. */
export type PairingRefusal =
  /** The characters are not a code: wrong length, or not digits. */
  | "invalid_code"
  /** No ticket is waiting under that code — or it belongs to somebody else. */
  | "wrong_code"
  /** The five minutes ran out. Nothing can revive it. */
  | "expired"
  /** Somebody already claimed it. A code is spent once. */
  | "used"
  /** It was withdrawn, here or on the other device. */
  | "revoked"
  /** The code is real, and bound to a different login than the one asking. */
  | "wrong_account"
  /** Nobody has approved it yet: keep waiting, do not fail. */
  | "not_approved"
  /** Already approved by somebody: approving again would re-bind it. */
  | "already_approved";

/** What a transition came to. The ticket is always returned, changed or not. */
export type PairingStep =
  | { ok: true; pairing: Pairing }
  | { ok: false; reason: PairingRefusal; pairing: Pairing };

/** A redeem either hands over a credential or says why it will not. */
export type PairingRedeem =
  | { ok: true; pairing: Pairing; credential: DeviceCredential }
  | { ok: false; reason: PairingRefusal; pairing: Pairing | null };

/** The one payload a hand-off may carry. Never a token; see the header. */
export interface PairingPayload {
  v: 1;
  code: string;
  /** The login this code will bind to, once it has been approved. */
  login: string | null;
  label: string;
  expiresAt: number;
}

/* ---------------------------------------------------------------------------
 * Bits of code
 * ------------------------------------------------------------------------ */

/**
 * `12345678` → `1234 5678`.
 *
 * One grouping, here, so every screen and every log line spells a code the same
 * way — and so the digits a person reads are the digits that were compared.
 */
export function formatCode(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const head = digits.slice(0, PAIRING_CODE_LENGTH / 2);
  const tail = digits.slice(PAIRING_CODE_LENGTH / 2, PAIRING_CODE_LENGTH);
  return tail === "" ? head : `${head} ${tail}`;
}

/**
 * Whatever was typed or pasted, as the eight digits it meant — or null.
 *
 * Spaces and dashes go, because a phone keyboard will offer both and a person
 * will type one of them. Everything that is not a digit is a refusal, including
 * the letters of a code from another scheme: a code this app did not mint is
 * not a code it can normalise into one.
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[\s-]/g, "");
  if (digits.length !== PAIRING_CODE_LENGTH) return null;
  if (!/^[0-9]+$/.test(digits)) return null;
  return digits;
}

/**
 * The random source, or a refusal.
 *
 * No fallback. A code drawn from `Math.random` is guessable from another tab,
 * and a pairing flow that silently degrades to one would be worse than a
 * pairing flow that does not start — so the absence of `crypto` is an error,
 * not a reason to improvise.
 */
function randomBytes(count: number): Uint8Array {
  const source = globalThis.crypto;
  if (typeof source?.getRandomValues !== "function") {
    throw new Error("A pairing code needs a cryptographic random source.");
  }
  return source.getRandomValues(new Uint8Array(count));
}

/**
 * A new code, from the system's own randomness.
 *
 * Rejection sampling rather than `byte % 10`: 256 is not a multiple of ten, so
 * the modulo would make 0–5 half as likely again as 6–9, and the point of a
 * random code is that nobody can say which digits are likelier.
 */
export function newPairingCode(): string {
  const alphabet = PAIRING_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH * 2)) {
      if (byte >= limit) continue;
      code += alphabet[byte % alphabet.length];
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return formatCode(code);
}

/**
 * The token a server hands a paired device.
 *
 * The extension mints this (`bin2hex(random_bytes(32))` behind a `hrd_` prefix)
 * and stores only its hash; this function exists so the client's tests can mint
 * the same shape, and so the prefix has one definition in the app.
 */
export function newDeviceToken(): string {
  const bytes = randomBytes(DEVICE_TOKEN_BYTES);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${DEVICE_TOKEN_PREFIX}${hex}`;
}

/** True when a session token is one the extension issued, not an API password. */
export function isDeviceToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    new RegExp(`^${DEVICE_TOKEN_PREFIX}[0-9a-f]{${DEVICE_TOKEN_BYTES * 2}}$`).test(token)
  );
}

/** The token half of a `login/token` session string, when it holds one. */
export function deviceTokenOf(sessionToken: string): string | null {
  const slash = sessionToken.indexOf("/");
  if (slash < 0) return null;
  const token = sessionToken.slice(slash + 1);
  return isDeviceToken(token) ? token : null;
}

/**
 * The session string a paired device stores.
 *
 * Same `login/secret` shape as a GReader credential, on purpose: every call site
 * in the app already puts this in `Authorization: GoogleLogin auth=…`, so a
 * paired device slots into the existing client without a second code path. The
 * server side of that is spelled out in `src/api/pairing.ts`.
 */
export function credentialSessionToken(credential: DeviceCredential): string {
  return `${credential.account}/${credential.token}`;
}

/* ---------------------------------------------------------------------------
 * The state machine
 * ------------------------------------------------------------------------ */

/**
 * Which phase a ticket is in, now.
 *
 * Revoked wins over everything, because revocation is a decision somebody made
 * and expiry is only the clock running out; a phone asking again after its code
 * was withdrawn should be told it was withdrawn, not that it was slow. Expiry
 * comes before approval and redemption because a ticket that has run out cannot
 * be moved by anything.
 */
export function pairingState(pairing: Pairing, now: number): PairingState {
  if (pairing.revokedAt !== null) return "revoked";
  if (pairing.redeemedAt !== null) return "redeemed";
  if (now >= pairing.expiresAt) return "expired";
  if (pairing.approvedAt !== null) return "approved";
  return "issued";
}

/** Milliseconds left on a ticket, never below zero. */
export function pairingRemaining(pairing: { expiresAt: number }, now: number): number {
  return Math.max(0, pairing.expiresAt - now);
}

/**
 * `4:07` for four minutes and seven seconds left.
 *
 * The approving row and the waiting phone both count down with this, so the two
 * screens cannot disagree about how much time is left. Nothing over an hour is
 * expected — a ticket that long would be a bug — so minutes are not capped at 9.
 */
export function pairingCountdown(pairing: { expiresAt: number }, now: number): string {
  const total = Math.ceil(pairingRemaining(pairing, now) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * A new ticket. Unsigned, unbound, and worth nothing until approved.
 *
 * `code` is an argument only so a test — or a server that has just minted one
 * itself — can supply the digits; left out, they come from the system's
 * randomness. An invalid one is a programming error and throws, because a
 * ticket with a code that cannot be typed is a ticket nobody can use.
 */
export function issuePairing(options: {
  label: string;
  now: number;
  ttl?: number;
  code?: string;
}): Pairing {
  const code = options.code === undefined ? newPairingCode() : formatCode(options.code);
  if (normalizeCode(code) === null) {
    throw new RangeError(`Not a pairing code: ${String(options.code)}`);
  }
  const ttl = options.ttl ?? PAIRING_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(`A ticket needs a positive lifetime, got ${String(ttl)}`);
  }
  return {
    code,
    label: options.label,
    account: null,
    issuedAt: options.now,
    expiresAt: options.now + ttl,
    approvedAt: null,
    redeemedAt: null,
    revokedAt: null,
  };
}

/**
 * The human's press, on a device that is already signed in.
 *
 * This is the step the whole feature exists for, and it is nothing but a
 * timestamp: no captcha is solved here either — the device was signed in
 * already, which is what it means to have passed one. What the press adds is
 * the binding: from here the ticket is this account's, and another account
 * approving it is a refusal rather than a rebind.
 */
export function approvePairing(
  pairing: Pairing,
  options: { account: string; now: number },
): PairingStep {
  const state = pairingState(pairing, options.now);
  if (state === "revoked") return { ok: false, reason: "revoked", pairing };
  if (state === "expired") return { ok: false, reason: "expired", pairing };
  if (state === "redeemed") return { ok: false, reason: "used", pairing };
  if (pairing.approvedAt !== null) {
    // Same account pressing twice is not an error worth a screen; another
    // account must not be able to take a ticket that is already bound.
    return pairing.account === options.account
      ? { ok: true, pairing }
      : { ok: false, reason: "wrong_account", pairing };
  }
  return {
    ok: true,
    pairing: { ...pairing, account: options.account, approvedAt: options.now },
  };
}

/**
 * The phone's claim on an approved code.
 *
 * Order of the checks is the order of the answers a phone needs: is this even a
 * code (400), is it one of ours (wrong code), is it somebody else's account
 * (only when the caller names one), is it dead, has it been used, has it run
 * out, has a human approved it yet. `not_approved` is last and is not a
 * failure — it is the answer that means "keep asking".
 *
 * A code that belongs to another account answers `wrong_code` unless the caller
 * named its own account. That is deliberate: the two must be indistinguishable
 * to a caller that does not already know which account it is, or the route
 * becomes a way to ask whether a code exists. A device that is already signed
 * in knows its account, passes it, and gets the honest `wrong_account`.
 */
export function redeemPairing(
  pairing: Pairing | null,
  options: {
    code: unknown;
    now: number;
    /** The account the asking device already belongs to, when it has one. */
    account?: string | null;
    /** A token to hand over; only tests and the server pass one. */
    token?: string;
  },
): PairingRedeem {
  const presented = normalizeCode(options.code);
  if (presented === null) return { ok: false, reason: "invalid_code", pairing };
  if (pairing === null) return { ok: false, reason: "wrong_code", pairing: null };

  const stored = normalizeCode(pairing.code);
  if (stored === null || stored !== presented) {
    return { ok: false, reason: "wrong_code", pairing };
  }

  const account = options.account ?? null;
  if (account !== null && pairing.account !== null && pairing.account !== account) {
    return { ok: false, reason: "wrong_account", pairing };
  }

  const state = pairingState(pairing, options.now);
  if (state === "revoked") return { ok: false, reason: "revoked", pairing };
  if (state === "redeemed") return { ok: false, reason: "used", pairing };
  if (state === "expired") return { ok: false, reason: "expired", pairing };
  if (state === "issued" || pairing.account === null) {
    return { ok: false, reason: "not_approved", pairing };
  }

  return {
    ok: true,
    pairing: { ...pairing, redeemedAt: options.now },
    credential: issueCredential({
      account: pairing.account,
      label: pairing.label,
      now: options.now,
      token: options.token,
    }),
  };
}

/**
 * Ends a ticket.
 *
 * Idempotent, and never refused: withdrawing consent is always allowed, and
 * pressing it twice is not an error. It works from every phase, including
 * `redeemed` — a ticket that has been claimed and then withdrawn is how the
 * approving side says "not this device after all".
 */
export function revokePairing(pairing: Pairing, options: { now: number }): Pairing {
  if (pairing.revokedAt !== null) return pairing;
  return { ...pairing, revokedAt: options.now };
}

/**
 * The tickets a signed-in device should be offering to approve, newest first,
 * with anything dead left out.
 *
 * Expired and revoked tickets are not "pending" in any sense a person cares
 * about; drawing them would be a list of codes that cannot work.
 */
export function pairingsAwaiting(pairings: readonly Pairing[], now: number): Pairing[] {
  return pairings
    .filter((pairing) => pairingState(pairing, now) === "issued")
    .sort((a, b) => b.issuedAt - a.issuedAt);
}

/**
 * The hand-off payload: what a QR would carry, and all it may carry.
 *
 * Written out key by key rather than spread from the ticket, so a field added to
 * `Pairing` later — a token, say — cannot reach a camera by accident. The login
 * is here because the phone shows which account it is joining; it is a name on
 * screen, not a secret.
 */
export function pairingPayload(pairing: Pairing): PairingPayload {
  return {
    v: 1,
    code: pairing.code,
    login: pairing.account,
    label: pairing.label,
    expiresAt: pairing.expiresAt,
  };
}

/* ---------------------------------------------------------------------------
 * The credential a phone keeps
 * ------------------------------------------------------------------------ */

/**
 * A credential record, as both sides hold it.
 *
 * The server stores the token's hash and never the token; this shape is what
 * the phone keeps and what a Devices list would draw. `expiresAt` slides
 * forward on use, which is why it is stored rather than derived.
 */
export function issueCredential(options: {
  account: string;
  label: string;
  now: number;
  token?: string;
  ttl?: number;
}): DeviceCredential {
  return {
    token: options.token ?? newDeviceToken(),
    account: options.account,
    label: options.label,
    pairedAt: options.now,
    lastUsedAt: options.now,
    expiresAt: options.now + (options.ttl ?? DEVICE_CREDENTIAL_TTL_MS),
    revokedAt: null,
  };
}

/** Live, run out, or withdrawn. Revoked wins, as it does for a ticket. */
export function credentialState(
  credential: DeviceCredential,
  now: number,
): "live" | "expired" | "revoked" {
  if (credential.revokedAt !== null) return "revoked";
  return now >= credential.expiresAt ? "expired" : "live";
}

/** True when the credential still signs this device in. */
export function credentialUsable(credential: DeviceCredential, now: number): boolean {
  return credentialState(credential, now) === "live";
}

/**
 * The same credential, used: the clock starts again.
 *
 * Sliding expiry, so a phone in daily use is never asked to pair twice, and one
 * left in a drawer stops working ninety days after its last use.
 */
export function touchCredential(credential: DeviceCredential, now: number): DeviceCredential {
  if (!credentialUsable(credential, now)) return credential;
  return { ...credential, lastUsedAt: now, expiresAt: now + DEVICE_CREDENTIAL_TTL_MS };
}

/** Withdraws a credential. Idempotent, like `revokePairing`. */
export function revokeCredential(credential: DeviceCredential, now: number): DeviceCredential {
  if (credential.revokedAt !== null) return credential;
  return { ...credential, revokedAt: now };
}
