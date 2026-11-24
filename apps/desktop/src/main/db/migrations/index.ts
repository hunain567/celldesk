import type { Migration } from '../migrator';
import { migration0001 } from './0001_init';
import { migration0002 } from './0002_backup';

/**
 * Every migration the app ships, in order. Never edit or remove a migration
 * that has been released; add a new one instead.
 */
export const migrations: readonly Migration[] = [migration0001, migration0002];
