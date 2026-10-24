/**
 * The share switch, as the window sees it.
 *
 * The server itself is Rust (`src-tauri/src/lan.rs`); this is the three things
 * the panel needs: whether it is up, where it is, and a way to turn it on and
 * off. The choice of port is remembered per device, because it belongs to this
 * machine's network rather than to the account.
 *
 * Nothing here exists in a browser: a tab has no server to start, so the panel
 * hides the row instead of offering a switch that cannot do anything.
 */
import { clampPort, DEFAULT_LAN_PORT, LAN_KEY, type LanState } from "../lib/lan";

function isDesktop(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

class LanShare {
  /** The address the reader is being served at, or null when it is not. */
  url = $state<string | null>(null);
  port = $state<number>(DEFAULT_LAN_PORT);
  /** A failed start, in words, for the panel to show instead of a silent nothing. */
  error = $state<string | null>(null);
  busy = $state(false);

  /** Desktop only: a browser tab is already being served by something. */
  get available(): boolean {
    return isDesktop();
  }

  load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(LAN_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw) as { port?: unknown };
      this.port = clampPort(saved.port);
    } catch {
      // A corrupt port is not worth a dialog; the default is one keystroke away.
    }
  }

  /** Asks the shell whether a server is already running — after a reload of the
   *  window, the Rust side may well still be serving. */
  async sync(): Promise<void> {
    if (!this.available) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const url = await invoke<string | null>("lan_status");
      this.url = url ?? null;
    } catch {
      // An older binary without the command: the switch simply stays off.
    }
  }

  async start(): Promise<void> {
    if (!this.available || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const url = await invoke<string>("lan_start", { port: this.port });
      this.url = url;
      this.save();
    } catch (error) {
      this.error = typeof error === "string" ? error : "the server did not start";
      this.url = null;
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.available || this.busy) return;
    this.busy = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("lan_stop");
      this.url = null;
    } catch {
      // Nothing to say: the row already reads "not shared" once the URL is gone.
      this.url = null;
    } finally {
      this.busy = false;
    }
  }

  async setPort(port: number): Promise<void> {
    this.port = clampPort(port);
    this.save();
    // A running server was opened on the old port; moving it is a stop and a
    // start rather than a silent mismatch between the field and the address.
    if (this.url !== null) {
      await this.stop();
      await this.start();
    }
  }

  get state(): LanState {
    return this.url === null ? "off" : /\/\/(127\.|localhost|0\.0\.0\.0|\[::1\])/.test(this.url) ? "local-only" : "on";
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(LAN_KEY, JSON.stringify({ port: this.port }));
    } catch {
      // The choice still applies to this session.
    }
  }
}

export const lan = new LanShare();
lan.load();
