/**
 * Putting the reader on the house network.
 *
 * The desktop app is the same web app the browser runs, so "share it with my
 * phone" is a server over the assets already inside the binary (see
 * `src-tauri/src/lan.rs`) and one address to open. Nothing about a reader is
 * stored on this machine on the phone's behalf: the phone has its own session,
 * its own server address and its own cached posts, exactly as a tab would.
 *
 * The numbers and the words live here, so the panel can stay a panel and the
 * rules can be tested.
 */

/** Where the phone's copy keeps its own port choice. */
export const LAN_KEY = "hardlyreader.lan.v1";

/** The port the server opens with, and the one shown before it is ever started. */
export const DEFAULT_LAN_PORT = 8450;

/** Ports below 1024 need root on Linux and are not worth explaining. */
export const LAN_PORT_MIN = 1024;
export const LAN_PORT_MAX = 65535;

/** A port that can be typed into the field without the app refusing it. */
export function clampPort(value: unknown): number {
  const text = typeof value === "number" ? "" : String(value ?? "").trim();
  // An empty field is not port zero: it is a field nobody has filled in yet.
  if (typeof value !== "number" && text === "") return DEFAULT_LAN_PORT;
  const n = typeof value === "number" ? value : Number(text);
  if (!Number.isFinite(n)) return DEFAULT_LAN_PORT;
  const whole = Math.round(n);
  if (whole < LAN_PORT_MIN) return LAN_PORT_MIN;
  if (whole > LAN_PORT_MAX) return LAN_PORT_MAX;
  return whole;
}

/** `http://192.168.1.24:8450/`, the address as somebody would read it to you. */
export function lanUrl(host: string, port: number): string {
  return `http://${host}:${clampPort(port)}/`;
}

/**
 * What the phone row says.
 *
 * Three states, because two would lie: not shared, shared and reachable, shared
 * and not reachable (no network, so the address is a loopback one nobody else
 * can open).
 */
export type LanState = "off" | "on" | "local-only";

export function lanStateFor(url: string | null): LanState {
  if (url === null) return "off";
  return /\/\/(127\.|localhost|0\.0\.0\.0|\[::1\])/.test(url) ? "local-only" : "on";
}

export const LAN_LABELS: Record<LanState, string> = {
  off: "Not shared",
  on: "Shared on this network",
  "local-only": "Shared on this machine only",
};

/** The sentence under the address, which is where the caveats belong. */
export function lanNote(state: LanState): string {
  switch (state) {
    case "on":
      return "Open this on a phone on the same network and add it to the home screen.";
    case "local-only":
      return "No network address right now — this machine can open it, a phone cannot.";
    default:
      return "The reader runs on this machine. Share it to use it on a phone.";
  }
}
