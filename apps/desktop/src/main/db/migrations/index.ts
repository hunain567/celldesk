import type { Migration } from '../migrator';
import { migration0001 } from './0001_init';
import { migration0002 } from './0002_backup';
import { migration0003 } from './0003_users';
import { migration0004 } from './0004_inventory';
import { migration0005 } from './0005_sales';

/**
 * Every migration the app ships, in order. Never edit or remove a migration
 * that has been released; add a new one instead.
 */
export const migrations: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005];
