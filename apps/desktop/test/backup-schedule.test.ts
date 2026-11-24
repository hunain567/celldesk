import { DEFAULT_RETENTION, type BackupSchedule } from '@nexodesk/shared';
import { describe, expect, it } from 'vitest';
import { selectForDeletion } from '../src/main/backup/retention';
import { isScheduledBackupDue, nextSlot, previousSlot, SCHEDULED_RETRY_MS } from '../src/main/backup/schedule';

// vitest.config.ts fixes TZ to Asia/Karachi so local-time rules are deterministic.
const local = (iso: string) => new Date(`${iso}+05:00`);
const schedule = (partial: Partial<BackupSchedule>): BackupSchedule => ({
  frequency: 'daily',
  time: '21:00',
  weekday: 0,
  dayOfMonth: 1,
  ...partial,
});

describe('backup schedule', () => {
  it('finds the previous and next daily slot', () => {
    expect(previousSlot(schedule({}), local('2026-11-24T20:59:00'))).toEqual(local('2026-11-23T21:00:00'));
    expect(previousSlot(schedule({}), local('2026-11-24T21:00:00'))).toEqual(local('2026-11-24T21:00:00'));
    expect(nextSlot(schedule({}), local('2026-11-24T22:00:00'))).toEqual(local('2026-11-25T21:00:00'));
  });

  it('finds weekly and monthly slots', () => {
    // 24 Nov 2026 is a Tuesday; Sunday 22 Nov is the previous weekly slot.
    expect(previousSlot(schedule({ frequency: 'weekly', weekday: 0 }), local('2026-11-24T10:00:00'))).toEqual(
      local('2026-11-22T21:00:00'),
    );
    expect(previousSlot(schedule({ frequency: 'monthly', dayOfMonth: 28 }), local('2026-11-24T10:00:00'))).toEqual(
      local('2026-10-28T21:00:00'),
    );
    expect(nextSlot(schedule({ frequency: 'monthly', dayOfMonth: 28 }), local('2026-11-24T10:00:00'))).toEqual(
      local('2026-11-28T21:00:00'),
    );
  });

  it('runs a missed backup when the PC is switched on later', () => {
    expect(
      isScheduledBackupDue({
        schedule: schedule({}),
        now: local('2026-11-25T09:30:00'),
        configuredAt: local('2026-11-20T10:00:00'),
        lastScheduledSuccessAt: local('2026-11-23T21:00:05'),
        lastScheduledAttemptAt: local('2026-11-23T21:00:05'),
      }),
    ).toBe(true);
  });

  it('does not repeat a slot that already succeeded, or run when off', () => {
    const base = {
      now: local('2026-11-24T21:30:00'),
      configuredAt: local('2026-11-20T10:00:00'),
      lastScheduledSuccessAt: local('2026-11-24T21:00:04'),
      lastScheduledAttemptAt: local('2026-11-24T21:00:04'),
    };
    expect(isScheduledBackupDue({ ...base, schedule: schedule({}) })).toBe(false);
    expect(isScheduledBackupDue({ ...base, schedule: schedule({ frequency: 'off' }), lastScheduledSuccessAt: null })).toBe(false);
  });

  it('ignores slots from before backups were set up', () => {
    expect(
      isScheduledBackupDue({
        schedule: schedule({}),
        now: local('2026-11-24T22:00:00'),
        configuredAt: local('2026-11-24T21:30:00'),
        lastScheduledSuccessAt: null,
        lastScheduledAttemptAt: null,
      }),
    ).toBe(false);
  });

  it('waits before retrying a failed scheduled backup', () => {
    const now = local('2026-11-24T21:10:00');
    const base = {
      schedule: schedule({}),
      now,
      configuredAt: local('2026-11-01T10:00:00'),
      lastScheduledSuccessAt: local('2026-11-23T21:00:00'),
    };
    expect(isScheduledBackupDue({ ...base, lastScheduledAttemptAt: local('2026-11-24T21:00:00') })).toBe(false);
    expect(
      isScheduledBackupDue({ ...base, lastScheduledAttemptAt: new Date(now.getTime() - SCHEDULED_RETRY_MS - 1) }),
    ).toBe(true);
  });
});

describe('retention', () => {
  const now = local('2026-11-24T22:00:00');
  const daysAgo = (days: number, kind = 'scheduled', id = days) => ({
    id,
    kind,
    createdAt: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
  });

  it('keeps 14 daily backups and thins older ones to weekly and monthly', () => {
    const files = Array.from({ length: 400 }, (_, day) => daysAgo(day));
    const deleted = new Set(selectForDeletion(files, DEFAULT_RETENTION, now));
    for (let day = 0; day < 14; day += 1) expect(deleted.has(day)).toBe(false);
    const kept = files.filter((file) => !deleted.has(file.id));
    // 14 daily + up to 8 weekly + up to 12 monthly, with overlaps.
    expect(kept.length).toBeGreaterThanOrEqual(14);
    expect(kept.length).toBeLessThanOrEqual(34);
    expect(deleted.has(399)).toBe(true);
  });

  it('never deletes manual backups or the newest backup', () => {
    const files = [daysAgo(900, 'manual', 1), daysAgo(500, 'pre-restore', 2)];
    expect(selectForDeletion(files, DEFAULT_RETENTION, now)).toEqual([]);
  });

  it('removes safety backups after their keep period', () => {
    const files = [daysAgo(1, 'scheduled', 1), daysAgo(30, 'pre-restore', 2), daysAgo(120, 'pre-update', 3)];
    expect(selectForDeletion(files, DEFAULT_RETENTION, now)).toEqual([3]);
  });
});
