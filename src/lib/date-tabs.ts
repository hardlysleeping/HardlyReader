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

/** A tab, and how deep it sits: a month at the left, a week inside it. */
export interface DateTab {
  key: string;
  level: 0 | 1;
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
    out.push({ kind: "tab", tab: { key: month.key, level: 0, label: month.label, count: month.count }, closed: monthClosed });
    if (monthClosed) continue;
    for (const week of month.weeks) {
      const weekClosed = closed.has(week.key);
      out.push({ kind: "tab", tab: { key: week.key, level: 1, label: week.label, count: week.count }, closed: weekClosed });
      if (weekClosed) continue;
      for (const item of week.items) out.push({ kind: "post", item });
    }
  }
  return out;
}
