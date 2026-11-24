import type { BackupSchedule } from '@nexodesk/shared';

/** A failed scheduled backup is retried after this long, not every minute. */
export const SCHEDULED_RETRY_MS = 30 * 60 * 1000;

function atTime(base: Date, time: string): Date {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const date = new Date(base);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** The most recent scheduled moment at or before `now`, in local time. */
export function previousSlot(schedule: BackupSchedule, now: Date): Date | null {
  switch (schedule.frequency) {
    case 'off':
      return null;
    case 'daily': {
      const slot = atTime(now, schedule.time);
      if (slot > now) slot.setDate(slot.getDate() - 1);
      return slot;
    }
    case 'weekly': {
      const slot = atTime(now, schedule.time);
      slot.setDate(slot.getDate() - ((slot.getDay() - schedule.weekday + 7) % 7));
      if (slot > now) slot.setDate(slot.getDate() - 7);
      return slot;
    }
    case 'monthly': {
      const slot = atTime(now, schedule.time);
      slot.setDate(schedule.dayOfMonth);
      if (slot > now) slot.setMonth(slot.getMonth() - 1, schedule.dayOfMonth);
      return slot;
    }
  }
}

/** The next scheduled moment strictly after `now`. */
export function nextSlot(schedule: BackupSchedule, now: Date): Date | null {
  const previous = previousSlot(schedule, now);
  if (!previous) return null;
  const next = new Date(previous);
  if (schedule.frequency === 'daily') next.setDate(next.getDate() + 1);
  if (schedule.frequency === 'weekly') next.setDate(next.getDate() + 7);
  if (schedule.frequency === 'monthly') next.setMonth(next.getMonth() + 1, schedule.dayOfMonth);
  return next;
}

/**
 * Whether a scheduled backup should run now. A slot missed while the PC was
 * off is caught up at the next check. Slots from before backups were set up
 * are ignored, and a failed attempt is retried only after SCHEDULED_RETRY_MS.
 */
export function isScheduledBackupDue(options: {
  schedule: BackupSchedule;
  now: Date;
  configuredAt: Date;
  lastScheduledSuccessAt: Date | null;
  lastScheduledAttemptAt: Date | null;
}): boolean {
  const slot = previousSlot(options.schedule, options.now);
  if (!slot || slot < options.configuredAt) return false;
  if (options.lastScheduledSuccessAt && options.lastScheduledSuccessAt >= slot) return false;
  if (
    options.lastScheduledAttemptAt &&
    options.now.getTime() - options.lastScheduledAttemptAt.getTime() < SCHEDULED_RETRY_MS
  ) {
    return false;
  }
  return true;
}
