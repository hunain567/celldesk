import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Folder created inside every backup destination. */
export const BACKUP_FOLDER_NAME = 'NexoDesk Backups';

export function backupFolder(destination: string, installId: string): string {
  return join(destination, BACKUP_FOLDER_NAME, installId.slice(0, 8));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function backupFileName(kind: string, date: Date): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `NexoDesk_${stamp}_${kind}.ndbak`;
}

export function uniqueTempPath(directory: string, prefix: string): string {
  mkdirSync(directory, { recursive: true });
  return join(directory, `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}.db`);
}

/** Converts file system errors into messages a shop owner can act on. */
export function friendlyFileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOSPC':
      return 'The drive is full.';
    case 'ENOENT':
    case 'ENOTDIR':
      return 'The folder was not found. Is the drive connected?';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'NexoDesk is not allowed to write to this folder.';
    case 'EIO':
    case 'ENXIO':
    case 'ENODEV':
    case 'EBUSY':
      return 'The drive was disconnected or could not be written.';
    default:
      return error instanceof Error && !code ? error.message : 'The backup file could not be written.';
  }
}

export interface DestinationCheck {
  ok: boolean;
  freeBytes: number | null;
  error: string | null;
}

/**
 * Proves a destination can take a backup right now: the folder exists, a file
 * can be written and removed there, and enough free space is available.
 */
export async function checkDestination(path: string, installId: string, neededBytes: number): Promise<DestinationCheck> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { ok: false, freeBytes: null, error: 'The backup location is not a folder.' };
  } catch (error) {
    return { ok: false, freeBytes: null, error: friendlyFileError(error) };
  }

  let freeBytes: number | null = null;
  try {
    const folder = backupFolder(path, installId);
    await mkdir(folder, { recursive: true });
    const probe = join(folder, `.write-test-${randomBytes(4).toString('hex')}`);
    await writeFile(probe, 'NexoDesk write test');
    await rm(probe, { force: true });
    const fs = await statfs(path);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch (error) {
    return { ok: false, freeBytes, error: friendlyFileError(error) };
  }

  if (freeBytes !== null && freeBytes < neededBytes) {
    return { ok: false, freeBytes, error: 'There is not enough free space on this drive.' };
  }
  return { ok: true, freeBytes, error: null };
}

/** Appends one JSON line to a journal kept outside the database. */
export function appendJournal(directory: string, fileName: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, fileName), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // The database history is the primary record; the journal is a convenience copy.
  }
}
