/**
 * Messages from the app's author: the list, and marking it read.
 *
 * A message is one-way on purpose — there is no reply, no unread badge outside
 * the screen that lists them, and no push. It is how the account hears about an
 * outage, a promotion, or "your lifetime upgrade is on the account" without the
 * app having to ship an update for each one.
 *
 * Three rules shape this file, and each one is a client-side fact rather than a
 * policy:
 *
 * 1. **One app asks for one app's messages.** HardlyReader and HardlyTracking
 *    share an account and a project, and an outage in one is noise in the other.
 *    `INBOX_APP` is the only thing this build ever passes as `p_app`.
 * 2. **The server decides who sees what.** The two calls are `supabase/schema.sql`'s
 *    `my_app_messages` and `mark_app_messages_read`, both `security definer` and
 *    both keyed on `auth.uid()`. A message targeted at someone else is not
 *    filtered out here — it is never in the answer, and a hand-made request for
 *    someone else's list returns the caller's own.
 * 3. **A failure is a sentence, never an empty inbox.** "Nothing to read" and
 *    "could not ask" must not look the same: a signed-out device, an expired
 *    token and a 500 are three different things to say, and an empty list is
 *    only correct for the first.
 */

/** Which app's messages this build shows. The same account is in both apps. */
export const INBOX_APP = "hardlyreader";

/** The network, as this file needs it. Injected so a suite needs no server. */
export type MessageFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where an account's messages come from. `token` is the account's own. */
export interface MessageOptions {
  readonly url: string;
  readonly anonKey: string;
  readonly token: string;
  readonly request?: MessageFetch;
  readonly timeoutMs?: number;
}

/** One message, as the screen draws it. Times are milliseconds, or null. */
export interface InboxMessage {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** When it was published, in milliseconds. */
  readonly publishedAt: number;
  /** When this account first read it, in milliseconds; null while unread. */
  readonly readAt: number | null;
}

/** Either the list, or why there is none. Never both, never an empty stand-in. */
export type InboxAnswer =
  | { readonly ok: true; readonly messages: readonly InboxMessage[] }
  | { readonly ok: false; readonly reason: string };

/** How long one call may take before it counts as not having been answered. */
const MESSAGE_TIMEOUT_MS = 6000;

function base(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Milliseconds from a PostgREST timestamp, or null when it is not one. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A row, or null when it is not a message this build can draw. */
function messageOf(row: unknown): InboxMessage | null {
  if (typeof row !== "object" || row === null) return null;
  const raw = row as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  const publishedAt = timeOf(raw.published_at);
  // A message with nothing to show is not a message; a missing date is not now.
  if (id === "" || title === "" || body === "" || publishedAt === null) return null;
  return { id, title, body, publishedAt, readAt: timeOf(raw.read_at) };
}

/**
 * One POST to a PostgREST function, or null when it did not answer.
 *
 * Never throws: every caller here answers a reader with a sentence, and a stack
 * trace in a settings row is not a sentence.
 */
async function call(options: MessageOptions, path: string, body: unknown): Promise<Response | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? MESSAGE_TIMEOUT_MS);
  try {
    const send: MessageFetch = options.request ?? ((url, init) => fetch(url, init));
    return await send(`${base(options.url)}/rest/v1/${path}`, {
      method: "POST",
      headers: {
        apikey: options.anonKey,
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: stop.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What a refusal means, in one sentence a settings row can show. */
function refusal(status: number): string {
  if (status === 401 || status === 403) return "your sign-in has expired — sign in again to see messages";
  if (status === 404) return "messages are not set up on the server yet";
  return `the server answered ${status}`;
}

/**
 * This account's messages for this app, newest first, with read state.
 *
 * The answer carries unread as `readAt === null`, so the badge and the list are
 * one call and cannot disagree.
 */
export async function listMessages(
  options: MessageOptions,
  app: string = INBOX_APP,
): Promise<InboxAnswer> {
  const response = await call(options, "rpc/my_app_messages", { p_app: app });
  if (response === null) return { ok: false, reason: "the server did not answer" };
  if (!response.ok) return { ok: false, reason: refusal(response.status) };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "the answer was not a list of messages" };
  }
  if (!Array.isArray(body)) return { ok: false, reason: "the answer was not a list of messages" };
  // A row this build cannot draw is dropped rather than drawn empty.
  const messages = body.map(messageOf).filter((message): message is InboxMessage => message !== null);
  return { ok: true, messages };
}

/**
 * Records that this account has read these messages.
 *
 * The server only accepts the ones the caller can actually see, and repeats are
 * ignored, so sending the whole visible list on every opening is both correct
 * and cheap. `false` means the server did not confirm — the screen keeps showing
 * them unread rather than pretending otherwise.
 */
export async function markRead(
  options: MessageOptions,
  ids: readonly string[],
  app: string = INBOX_APP,
): Promise<boolean> {
  if (ids.length === 0) return true;
  const response = await call(options, "rpc/mark_app_messages_read", {
    p_app: app,
    p_messages: ids,
  });
  return response !== null && response.ok;
}
