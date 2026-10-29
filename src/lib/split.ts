/**
 * Split reading: more than one reader on screen, each with a stream of its own.
 *
 * Modes 1, 2 and 3 are *roles* — feeds, posts, article — with one of each, which
 * is why a fourth column of roles is meaningless. This is the other family: a
 * pane is an *instance* of a reader, it holds its own stream, its own post and
 * its own scroll, and the one that has the focus is the one a press lands in.
 *
 * The arithmetic here is deliberately small: a list of panes, where a split goes
 * in, where focus falls when one closes, how many of them a frame can actually
 * draw, and the shape that survives a restart. The `ReaderState` behind a pane
 * owns everything the reader does; this module never talks to one.
 */

/** The most panes the family draws. Four columns at a readable width is already a wide desk. */
export const SPLIT_MAX = 4;

/** A split needs two panes to be a split; one pane is the ordinary layout with the sidebar hidden. */
export const SPLIT_MIN = 2;

/** The same 6px seam as everywhere else: it is the same device between two panes. */
export const SPLIT_GUTTER = 6;

/**
 * The narrowest a pane is drawn before the family stops adding them.
 *
 * A posts row needs room for a headline and a line of its own; the three-column
 * layout gives its list 260 at its minimum, and a fourth pane cannot ask for
 * more than the third did. Below this the family draws fewer panes and says so
 * rather than scrolling sideways — panes are user state, never a media query.
 */
export const SPLIT_MIN_PANE = 260;

/**
 * One pane, as it is remembered.
 *
 * The live pane holds a `ReaderState`, and everything here is read off that
 * reader when the arrangement is written down — so this shape exists to be
 * stored and validated, not to be kept in step by hand.
 */
export interface SplitPaneRecord {
  /** Stable for the life of the arrangement, and never reused by a later pane. */
  id: string;
  streamId: string;
  streamTitle: string;
  selectedId: string | null;
  listScroll: number;
  articleScroll: number;
}

/** What a restart is handed: the panes, which one had the focus, and whether the family was on. */
export interface SplitSave {
  v: 1;
  active: boolean;
  panes: SplitPaneRecord[];
  focusedId: string | null;
}

/** Storage shape, one account, beside the remembered place. */
export const SPLIT_BASE = "hardlyreader:split";

/** A pane with nothing read into it yet. */
export function newPane(id: string, streamId: string, streamTitle: string): SplitPaneRecord {
  return { id, streamId, streamTitle, selectedId: null, listScroll: 0, articleScroll: 0 };
}

/** Whether one more pane can be added. */
export function canSplit(count: number): boolean {
  return count < SPLIT_MAX;
}

/** Whether a pane can be taken away: the family keeps at least two. */
export function canClose(count: number): boolean {
  return count > SPLIT_MIN;
}

/** Where one pane sits, or -1. */
export function indexOf(panes: readonly SplitPaneRecord[], id: string | null): number {
  if (id === null) return -1;
  return panes.findIndex((pane) => pane.id === id);
}

/**
 * The list with `pane` inserted immediately to the right of the focused one.
 *
 * "Splitting adds a pane to the right of the focused one", so the new pane
 * appears where the press was rather than at the end of the row — the same
 * reason a browser's split opens beside the tab you were on. A focus that names
 * no pane in the list appends instead of failing, and a list already at the
 * maximum is returned unchanged.
 */
export function insertAfter(
  panes: readonly SplitPaneRecord[],
  focusedId: string | null,
  pane: SplitPaneRecord,
): SplitPaneRecord[] {
  if (!canSplit(panes.length)) return [...panes];
  const at = indexOf(panes, focusedId);
  if (at === -1) return [...panes, pane];
  return [...panes.slice(0, at + 1), pane, ...panes.slice(at + 1)];
}

/**
 * The list without one pane, and where the focus goes.
 *
 * The pane to the right inherits the focus, because the row closes up to the
 * left and the eye is already there; the last pane hands it to its left
 * neighbour instead. Closing the only remaining pane is refused, which is what
 * keeps the family from becoming a worse version of mode 2.
 */
export function removePane(
  panes: readonly SplitPaneRecord[],
  id: string,
  focusedId: string | null,
): { panes: SplitPaneRecord[]; focusedId: string | null } {
  if (!canClose(panes.length)) return { panes: [...panes], focusedId };
  const at = indexOf(panes, id);
  if (at === -1) return { panes: [...panes], focusedId };
  const rest = [...panes.slice(0, at), ...panes.slice(at + 1)];
  if (focusedId !== id) {
    return { panes: rest, focusedId: indexOf(rest, focusedId) === -1 ? (rest[0]?.id ?? null) : focusedId };
  }
  const next = rest[Math.min(at, rest.length - 1)];
  return { panes: rest, focusedId: next?.id ?? null };
}

/**
 * How many panes a frame can draw.
 *
 * Equal shares, so the whole list is one repeated track and this is a division
 * rather than a search. Every pane is at least `SPLIT_MIN_PANE` wide and every
 * seam between them costs `SPLIT_GUTTER`; when the frame cannot hold them all,
 * the rightmost are not drawn — they keep their streams and their scrolls and
 * come back when the window is wide enough.
 */
export function visibleCount(count: number, width: number): number {
  if (count <= 0) return 0;
  const room = Math.floor((Math.max(0, width) + SPLIT_GUTTER) / (SPLIT_MIN_PANE + SPLIT_GUTTER));
  return Math.max(1, Math.min(count, room));
}

/** The frame's column tracks for a number of drawn panes. */
export function splitTracks(drawn: number): string {
  const tracks: string[] = [];
  for (let i = 0; i < Math.max(1, drawn); i += 1) {
    if (i > 0) tracks.push(`${SPLIT_GUTTER}px`);
    tracks.push("1fr");
  }
  return tracks.join(" ");
}

/** The width every pane is drawn at, once the seams are paid for. */
export function paneWidth(width: number, drawn: number): number {
  const gaps = Math.max(0, drawn - 1) * SPLIT_GUTTER;
  return Math.max(0, Math.floor((width - gaps) / Math.max(1, drawn)));
}

/** Whether the family is drawing every pane it holds. */
export function squeezed(count: number, width: number): boolean {
  return visibleCount(count, width) < count;
}

/** The name a pane answers to, for a control that has to say which one it means. */
export function paneLabel(panes: readonly SplitPaneRecord[], index: number): string {
  const title = panes[index]?.streamTitle?.trim();
  return title === undefined || title === "" ? `Pane ${index + 1}` : title;
}

/** What to write down. */
export function saveShape(active: boolean, panes: readonly SplitPaneRecord[], focusedId: string | null): SplitSave {
  return { v: 1, active, panes: panes.map((pane) => ({ ...pane })), focusedId };
}

function whole(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A stored arrangement, or nothing.
 *
 * Tolerant in the one direction that matters: an entry that is not a pane is
 * dropped rather than throwing the whole arrangement away, ids are made unique,
 * and a focus that names no pane falls to the first. A stream that has since
 * been deleted is not this function's business — the pane opens and the reader
 * lands somewhere real, exactly as the remembered place does.
 */
export function parseSave(raw: unknown): SplitSave | null {
  if (typeof raw !== "object" || raw === null) return null;
  const shape = raw as Partial<SplitSave>;
  if (shape.v !== 1) return null;
  const list = Array.isArray(shape.panes) ? shape.panes : [];
  const panes: SplitPaneRecord[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const pane = entry as Partial<SplitPaneRecord>;
    const streamId = text(pane.streamId).trim();
    if (streamId === "") continue;
    let id = text(pane.id).trim();
    if (id === "" || panes.some((known) => known.id === id)) id = `pane-${panes.length + 1}`;
    panes.push({
      id,
      streamId,
      streamTitle: text(pane.streamTitle),
      selectedId: typeof pane.selectedId === "string" && pane.selectedId !== "" ? pane.selectedId : null,
      listScroll: whole(pane.listScroll),
      articleScroll: whole(pane.articleScroll),
    });
    if (panes.length === SPLIT_MAX) break;
  }
  if (panes.length === 0) return null;
  const focusedId = indexOf(panes, typeof shape.focusedId === "string" ? shape.focusedId : null) === -1
    ? (panes[0]?.id ?? null)
    : (shape.focusedId as string);
  return { v: 1, active: shape.active === true, panes, focusedId };
}

/** The same, from the string a key store hands back. */
export function readSave(json: string | null | undefined): SplitSave | null {
  if (typeof json !== "string" || json === "") return null;
  try {
    return parseSave(JSON.parse(json));
  } catch {
    return null;
  }
}
