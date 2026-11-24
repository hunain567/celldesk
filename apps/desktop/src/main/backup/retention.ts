import type { RetentionPolicy } from '@nexodesk/shared';

export interface RetainedFile {
  id: number;
  kind: string;
  createdAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function weekKey(date: Date): string {
  // Weeks start on Monday, in local time.
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return dayKey(monday);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

/** Keeps the newest file in each of the newest `count` periods. */
function newestPerPeriod(files: RetainedFile[], keyOf: (date: Date) => string, count: number): Set<number> {
  const kept = new Set<number>();
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.size >= count) break;
    const key = keyOf(file.createdAt);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.add(file.id);
  }
  return kept;
}

/**
 * Chooses which verified backups on one destination may be deleted.
 *
 * - The newest verified backup is never deleted.
 * - Manual backups are never deleted automatically.
 * - Safety backups (before restore or update) are kept for `keepSafetyDays`.
 * - Scheduled backups keep the newest per day, per week and per month for the
 *   configured number of periods.
 */
export function selectForDeletion(files: RetainedFile[], policy: RetentionPolicy, now: Date): number[] {
  if (files.length === 0) return [];
  const sorted = [...files].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<number>([sorted[0]!.id]);

  const scheduled = sorted.filter((file) => file.kind === 'scheduled');
  for (const id of newestPerPeriod(scheduled, dayKey, policy.keepDaily)) keep.add(id);
  for (const id of newestPerPeriod(scheduled, weekKey, policy.keepWeekly)) keep.add(id);
  for (const id of newestPerPeriod(scheduled, monthKey, policy.keepMonthly)) keep.add(id);

  const deletions: number[] = [];
  for (const file of sorted) {
    if (keep.has(file.id) || file.kind === 'manual') continue;
    if (file.kind === 'scheduled') {
      deletions.push(file.id);
    } else if (now.getTime() - file.createdAt.getTime() > policy.keepSafetyDays * DAY_MS) {
      deletions.push(file.id);
    }
  }
  return deletions;
}
