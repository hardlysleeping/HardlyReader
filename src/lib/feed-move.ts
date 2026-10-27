/**
 * What a finished category move says.
 *
 * A move is drawn before it is written, so the sidebar shows the new folder the
 * instant the drag ends. The only thing the reader cannot see from the sidebar is
 * whether the account took it — that is what this line answers, which is why it
 * says "synced" and not just "moved".
 *
 * Pure, so the wording can be asserted without a component or a server: null is
 * Uncategorized, because that is the absence of a label rather than a label with
 * that name.
 */
export function moveNotice(title: string, to: string | null): string {
  const name = title.trim() === "" ? "Feed" : title.trim();
  const where = to === null || to.trim() === "" ? "Uncategorized" : to.trim();
  return `Moved ${name} to ${where} — synced`;
}
