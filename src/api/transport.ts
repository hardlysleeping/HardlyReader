import type { Transport } from "./freshrss";

/**
 * Picks a transport for the current runtime.
 *
 * Inside Tauri, requests must go through the http plugin: the webview is a
 * separate origin, so plain `fetch` would be blocked by CORS. In a browser
 * (`pnpm dev`, tests) `fetch` is the only option.
 */
export const transport: Transport = async (input, init) => {
  if ("__TAURI_INTERNALS__" in globalThis) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return fetch(input, init);
};
