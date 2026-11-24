import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Crash-safe replacement of the live database during a restore.
 *
 * A journal file is written before anything moves. If the PC loses power at
 * any point, the next start reads the journal and either finishes the restore
 * (the restored database opens and passes its checks) or puts the original
 * database back. The original is never deleted by this process.
 */

const JournalSchema = z.object({
  state: z.enum(['prepared', 'swapped']),
  livePath: z.string(),
  stagingPath: z.string(),
  preRestorePath: z.string(),
  backupFile: z.string(),
  backupCreatedAt: z.string(),
  safetyCopyPath: z.string(),
  startedAt: z.string(),
});
export type RestoreJournal = z.infer<typeof JournalSchema>;

export type RecoveryOutcome =
  | { kind: 'none' }
  | { kind: 'completed'; journal: RestoreJournal }
  | { kind: 'rolled-back'; journal: RestoreJournal; reason: string };

export function journalPath(restoreDirectory: string): string {
  return join(restoreDirectory, 'restore-journal.json');
}

export function writeJournal(path: string, journal: RestoreJournal): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(journal, null, 2), 'utf8');
  renameSync(temp, path);
}

export function readJournal(path: string): RestoreJournal | null {
  if (!existsSync(path)) return null;
  return JournalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const SIDE_FILES = ['-wal', '-shm', '-journal'];

/** Moves a database together with any SQLite side files that belong to it. */
function moveDatabase(from: string, to: string): void {
  renameSync(from, to);
  for (const suffix of SIDE_FILES) {
    if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
  }
}

/**
 * Swaps the staged database into place. The live database must be closed.
 * Leaves the journal in the "swapped" state; the next start confirms it.
 */
export function swapDatabase(journalFile: string): void {
  const journal = readJournal(journalFile);
  if (!journal || journal.state !== 'prepared') throw new Error('No prepared restore was found.');
  if (!existsSync(journal.stagingPath)) throw new Error('The prepared database is missing.');

  if (existsSync(journal.livePath)) moveDatabase(journal.livePath, journal.preRestorePath);
  try {
    moveDatabase(journal.stagingPath, journal.livePath);
  } catch (error) {
    // Put the original back before reporting the failure.
    if (!existsSync(journal.livePath) && existsSync(journal.preRestorePath)) {
      moveDatabase(journal.preRestorePath, journal.livePath);
    }
    rmSync(journalFile, { force: true });
    throw error;
  }
  writeJournal(journalFile, { ...journal, state: 'swapped' });
}

/**
 * Runs at every start before the database is opened.
 * `isHealthy` opens a database file with the local key and checks its integrity.
 */
export function recoverInterruptedRestore(
  journalFile: string,
  isHealthy: (databasePath: string) => boolean,
  now: () => Date = () => new Date(),
): RecoveryOutcome {
  let journal: RestoreJournal | null;
  try {
    journal = readJournal(journalFile);
  } catch {
    rmSync(journalFile, { force: true });
    return { kind: 'none' };
  }
  if (!journal) return { kind: 'none' };

  if (journal.state === 'prepared') {
    // Stopped before or during the swap: the original must be live again.
    if (!existsSync(journal.livePath) && existsSync(journal.preRestorePath)) {
      moveDatabase(journal.preRestorePath, journal.livePath);
    }
    rmSync(journal.stagingPath, { force: true });
    rmSync(journalFile, { force: true });
    return { kind: 'rolled-back', journal, reason: 'The restore was interrupted before it finished.' };
  }

  if (existsSync(journal.livePath) && isHealthy(journal.livePath)) {
    rmSync(journalFile, { force: true });
    return { kind: 'completed', journal };
  }

  // The restored database cannot be used: keep it aside and bring the original back.
  if (existsSync(journal.livePath)) {
    moveDatabase(journal.livePath, `${journal.livePath}.failed-restore-${now().getTime()}`);
  }
  if (existsSync(journal.preRestorePath)) moveDatabase(journal.preRestorePath, journal.livePath);
  rmSync(journalFile, { force: true });
  return { kind: 'rolled-back', journal, reason: 'The restored database could not be opened, so the original was kept.' };
}
