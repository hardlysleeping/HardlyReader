/**
 * The list view's tabs: months, and the weeks inside them.
 *
 * A feed list read straight down is one wall of headlines; the same list with its
 * dates folded is a shelf — a month you can put away, the week inside it. Two
 * folds and no third: a day is a handful of posts, and a tab per day turned the
 * shelf into a ladder of one-line headings. The grouping is a pure function over
 * the items in the order the reader has them, so the tabs follow the list's own
 * order rather than imposing one, and a closed tab simply stops emitting what is
 * under it.
 */

export interface DateItem {
  timestampUsec?: string;
  published?: number;
}

/**
 * What a tab is a fold of.
 *
 * Named rather than read off `level`, because the depth moves: a month sits at the
 * pane's edge in one account's list and one step in when an account heads it, and a
 * class derived from the number would call a month an account the moment there is
 * only one of them.
 */
export type TabFold = "account" | "month" | "week";

/** A tab, and how deep it sits: an account at the left, a month inside it, a week inside that. */
export interface DateTab {
  key: string;
  level: 0 | 1 | 2;
  fold: TabFold;
  label: string;
  /** Posts under this tab, counting the ones under its closed children. */
  count: number;
}

export type Tabbed<T> = { kind: "tab"; tab: DateTab; closed: boolean } | { kind: "post"; item: T };

/** The post's time in milliseconds, or 0 when it has none. */
export function millisOf(item: DateItem): number {
  if (item.timestampUsec) {
    const millis = Number(item.timestampUsec) / 1000;
    if (Number.isFinite(millis)) return millis;
  }
  if (item.published) return item.published * 1000;
  return 0;
}

function dayOf(millis: number): Date {
  const date = new Date(millis);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The Monday of the week a day is in: a week is a week, not a rolling seven. */
function weekOf(day: Date): Date {
  const weekday = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - weekday);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** The key of the week a day is in. Any day of it will do; it finds the Monday. */
export function weekKey(day: Date): string {
  const monday = weekOf(day);
  return `w:${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

export function monthKey(day: Date): string {
  return `m:${day.getFullYear()}-${pad(day.getMonth() + 1)}`;
}

function monthLabel(day: Date): string {
  return day.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function weekLabel(monday: Date): string {
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const short = (date: Date) => date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${short(monday)} – ${short(sunday)}`;
}

interface WeekBucket<T> {
  key: string;
  label: string;
  count: number;
  items: T[];
}

interface MonthBucket<T> {
  key: string;
  label: string;
  count: number;
  weeks: WeekBucket<T>[];
}

/**
 * The items with a tab before each date, and nothing under a tab that is closed.
 *
 * The tree is built from runs in the order given: a post whose month differs from
 * the one before it starts a new month, and so on down. That keeps the list's own
 * order — newest first, as the reader sorted it — instead of re-sorting by date
 * and quietly disagreeing with the rest of the pane.
 */
export function tabbed<T extends DateItem>(items: readonly T[], closed: ReadonlySet<string>): Tabbed<T>[] {
  const months: MonthBucket<T>[] = [];
  let month: MonthBucket<T> | null = null;
  let week: WeekBucket<T> | null = null;

  for (const item of items) {
    const monday = weekOf(dayOf(millisOf(item)));

    if (month === null || month.key !== monthKey(monday)) {
      month = { key: monthKey(monday), label: monthLabel(monday), count: 0, weeks: [] };
      months.push(month);
      week = null;
    }
    if (week === null || week.key !== weekKey(monday)) {
      week = { key: weekKey(monday), label: weekLabel(monday), count: 0, items: [] };
      month.weeks.push(week);
    }
    week.count += 1;
    month.count += 1;
    week.items.push(item);
  }

  const out: Tabbed<T>[] = [];
  for (const month of months) {
    const monthClosed = closed.has(month.key);
    out.push({
      kind: "tab",
      tab: { key: month.key, level: 0, fold: "month", label: month.label, count: month.count },
      closed: monthClosed,
    });
    if (monthClosed) continue;
    for (const week of month.weeks) {
      const weekClosed = closed.has(week.key);
      out.push({
        kind: "tab",
        tab: { key: week.key, level: 1, fold: "week", label: week.label, count: week.count },
        closed: weekClosed,
      });
      if (weekClosed) continue;
      for (const item of week.items) out.push({ kind: "post", item });
    }
  }
  return out;
}

/**
 * The same list with an account heading over each account's own dates.
 *
 * A reading list drawn from more than one account is several reading lists, and a
 * date folded straight across them says nothing about whose post is whose — a row
 * marked read has to go back to the account it came from, and the month a post was
 * published in does not say that. So the accounts are the outer fold, in the order
 * Pane 1 draws them, and the months and weeks live inside as they always have, one
 * level deeper.
 *
 * Keys are prefixed with the account's, because a week is the same week in both
 * accounts and closing "this week" in one must not fold the other.
 *
 * With one account this is not called at all: a list that is one account's has no
 * heading to draw.
 */
export function tabbedAccounts<T extends DateItem>(
  groups: readonly { key: string; label: string; items: readonly T[] }[],
  closed: ReadonlySet<string>,
): Tabbed<T>[] {
  const out: Tabbed<T>[] = [];
  for (const group of groups) {
    const folded = closed.has(group.key);
    out.push({
      kind: "tab",
      tab: { key: group.key, level: 0, fold: "account", label: group.label, count: group.items.length },
      closed: folded,
    });
    if (folded) continue;
    // Only this account's keys are handed down, with the prefix taken off: a week is
    // the same week in both accounts, and a bare `slice` on another account's key
    // happened to match this one's and folded both.
    const inner = new Set(
      [...closed]
        .filter((key) => key.startsWith(`${group.key}|`))
        .map((key) => key.slice(group.key.length + 1)),
    );
    for (const entry of tabbed(group.items, inner)) {
      if (entry.kind === "post") {
        out.push(entry);
        continue;
      }
      out.push({
        kind: "tab",
        tab: {
          ...entry.tab,
          key: `${group.key}|${entry.tab.key}`,
          level: (entry.tab.level + 1) as 1 | 2,
        },
        closed: entry.closed,
      });
    }
  }
  return out;
}
