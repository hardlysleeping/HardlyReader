import { clampIndentPx, type SidebarIndentState } from "../api/hardlyread";

/**
 * Which indent to draw: the server's, unless the server cannot be the one.
 *
 * The Sidebar Feed Indent extension owns this number, so when it is enabled and
 * accepts writes, its value wins — that is what makes the slider in the app and
 * the slider on the website one setting instead of two.
 *
 * It is not the server's to own in two cases, and both used to lose the number:
 *
 * 1. **No extension.** There is nowhere on the server to put it, so this device
 *    keeps it (`local`).
 * 2. **An extension that cannot write it** — an older build without
 *    `setIndent()`, a route the adapter does not expose yet. The server still
 *    reports a value, so the naive read would keep handing back the old number
 *    and the app's own would vanish on every reload. `localOnly` is that fact,
 *    and it is remembered.
 *
 * `local === null` means nothing has ever been set on this device, so the
 * server's answer is all there is.
 */
export function resolveIndent(
  server: SidebarIndentState,
  local: number | null,
  localOnly: boolean,
): SidebarIndentState {
  if (local === null) return server;
  if (server.available && !localOnly) return server;
  return { ...server, px: clampIndentPx(local, server.max) };
}
