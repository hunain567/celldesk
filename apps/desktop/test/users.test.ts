import { ipcContract, type IpcChannel } from '@nexodesk/shared';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { ACCESS_RULES, checkAccess } from '../src/main/ipc/access';
import { registerAuthHandlers } from '../src/main/ipc/auth-handlers';
import { IpcRouter } from '../src/main/ipc/router';
import { AuditLog } from '../src/main/services/audit';
import { hashSecret, verifySecret } from '../src/main/services/passwords';
import { SessionManager } from '../src/main/services/session';
import { SettingsStore } from '../src/main/services/settings';
import { LOCK_MINUTES, MAX_FAILED_ATTEMPTS, UserService } from '../src/main/services/users';
import { tempDir, TEST_KEY } from './helpers';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const SHOP = { shopName: 'Madina Mobile', ownerName: 'Usman', phone: '0300-0000000', address: 'Hall Road', city: 'Lahore', receiptFooter: '' };
const OWNER = { fullName: 'Usman Ali', username: 'usman', password: 'owner-pass-1', pin: '1234' };

describe('password hashing', () => {
  it('verifies the right secret only and never stores it', async () => {
    const hash = await hashSecret('correct horse', FAST);
    expect(hash).not.toContain('correct horse');
    expect(await verifySecret('correct horse', hash)).toBe(true);
    expect(await verifySecret('correct horsE', hash)).toBe(false);
    expect(await verifySecret('anything', 'not-a-hash')).toBe(false);
  });
});

describe('users and sign-in', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: SqliteDatabase;
  let clock: { now: Date };
  let users: UserService;

  beforeEach(() => {
    dir = tempDir();
    db = openDatabase(join(dir.path, 'users.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    clock = { now: new Date('2026-11-24T06:00:00Z') };
    users = new UserService(db, new AuditLog(db, () => clock.now), { now: () => clock.now, hashCost: FAST });
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('sets up the shop and its owner exactly once', async () => {
    expect(users.isSetupComplete()).toBe(false);
    const owner = await users.createShop(SHOP, OWNER);
    expect(owner).toMatchObject({ username: 'usman', role: 'owner', mustChangePassword: false });
    expect(owner.permissions).toContain('users.manage');
    expect(users.isSetupComplete()).toBe(true);
    expect(users.getShop()?.shopName).toBe('Madina Mobile');
    await expect(users.createShop(SHOP, { ...OWNER, username: 'other' })).rejects.toThrow(/already set up/);
  });

  it('signs in with password or PIN and rejects wrong ones', async () => {
    await users.createShop(SHOP, OWNER);
    expect((await users.loginWithPassword('USMAN', 'owner-pass-1')).username).toBe('usman');
    await expect(users.loginWithPassword('usman', 'wrong-pass')).rejects.toThrow(/not correct/);
    await expect(users.loginWithPassword('nobody', 'owner-pass-1')).rejects.toThrow(/not correct/);
    const [pinUser] = users.pinUsers();
    expect((await users.loginWithPin(pinUser!.id, '1234')).role).toBe('owner');
    await expect(users.loginWithPin(pinUser!.id, '9999')).rejects.toThrow(/PIN is not correct/);
  });

  it(`locks an account for ${LOCK_MINUTES} minutes after ${MAX_FAILED_ATTEMPTS} wrong attempts`, async () => {
    await users.createShop(SHOP, OWNER);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await expect(users.loginWithPassword('usman', 'wrong-pass')).rejects.toThrow();
    }
    await expect(users.loginWithPassword('usman', 'owner-pass-1')).rejects.toThrow(/locked/);
    clock.now = new Date(clock.now.getTime() + LOCK_MINUTES * 60000 + 1000);
    expect((await users.loginWithPassword('usman', 'owner-pass-1')).username).toBe('usman');
  });

  it('makes new staff choose their own password before using a PIN', async () => {
    await users.createShop(SHOP, OWNER);
    await users.create({ fullName: 'Ali', username: 'ali', role: 'salesman', password: 'temp-pass-1', pin: '4321' }, 'usman');
    const ali = users.list().find((user) => user.username === 'ali')!;
    expect(ali).toMatchObject({ role: 'salesman', hasPin: true });
    await expect(users.loginWithPin(ali.id, '4321')).rejects.toThrow(/password first/);
    const session = await users.loginWithPassword('ali', 'temp-pass-1');
    expect(session).toMatchObject({ mustChangePassword: true, permissions: ['stock.view'] });
    const changed = await users.changeOwnPassword(ali.id, 'temp-pass-1', 'my-own-pass');
    expect(changed.mustChangePassword).toBe(false);
    expect((await users.loginWithPin(ali.id, '4321')).username).toBe('ali');
  });

  it('refuses duplicate usernames and weak input', async () => {
    await users.createShop(SHOP, OWNER);
    await expect(users.create({ fullName: 'X', username: 'Usman', role: 'manager', password: 'long-enough' }, 'usman')).rejects.toThrow(/already used/);
    await expect(users.create({ fullName: 'X', username: 'a b', role: 'manager', password: 'long-enough' }, 'usman')).rejects.toThrow();
    await expect(users.create({ fullName: 'X', username: 'xyz', role: 'manager', password: 'short' }, 'usman')).rejects.toThrow(/at least 8/);
  });

  it('always keeps one active owner', async () => {
    const owner = await users.createShop(SHOP, OWNER);
    expect(() => users.update({ id: owner.id, fullName: 'Usman', role: 'manager', isActive: true }, 'usman')).toThrow(/at least one active owner/);
    expect(() => users.update({ id: owner.id, fullName: 'Usman', role: 'owner', isActive: false }, 'usman')).toThrow(/at least one active owner/);
    await users.create({ fullName: 'Second', username: 'second', role: 'owner', password: 'long-enough' }, 'usman');
    expect(() => users.update({ id: owner.id, fullName: 'Usman', role: 'manager', isActive: true }, 'usman')).not.toThrow();
  });

  it('blocks deactivated users immediately', async () => {
    await users.createShop(SHOP, OWNER);
    await users.create({ fullName: 'Ali', username: 'ali', role: 'salesman', password: 'temp-pass-1' }, 'usman');
    const ali = users.list().find((user) => user.username === 'ali')!;
    users.update({ id: ali.id, fullName: 'Ali', role: 'salesman', isActive: false }, 'usman');
    expect(users.refresh(ali.id)).toBeNull();
    await expect(users.loginWithPassword('ali', 'temp-pass-1')).rejects.toThrow(/not correct/);
  });

  it('owner password reset unlocks the account and forces a change', async () => {
    await users.createShop(SHOP, OWNER);
    await users.create({ fullName: 'Ali', username: 'ali', role: 'salesman', password: 'temp-pass-1' }, 'usman');
    const ali = users.list().find((user) => user.username === 'ali')!;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await expect(users.loginWithPassword('ali', 'nope-nope')).rejects.toThrow();
    await users.resetPassword(ali.id, 'fresh-pass-1', 'usman');
    expect(await users.loginWithPassword('ali', 'fresh-pass-1')).toMatchObject({ mustChangePassword: true });
  });
});

describe('access rules', () => {
  const owner = { id: '1', fullName: 'O', username: 'o', role: 'owner' as const, permissions: ['users.manage', 'data.restore', 'backup.run', 'backup.manage'] as never[], mustChangePassword: false };
  const salesman = { ...owner, role: 'salesman' as const, permissions: [] };

  it('has a rule for every channel', () => {
    expect(Object.keys(ACCESS_RULES).sort()).toEqual(Object.keys(ipcContract).sort());
  });

  it('requires sign-in, checks roles and allows restore only before setup without sign-in', () => {
    const rule = (channel: IpcChannel) => ACCESS_RULES[channel];
    expect(checkAccess(rule('users:list'), { setupComplete: true, user: null })?.code).toBe('UNAUTHENTICATED');
    expect(checkAccess(rule('users:list'), { setupComplete: true, user: salesman })?.code).toBe('FORBIDDEN');
    expect(checkAccess(rule('users:list'), { setupComplete: true, user: owner })).toBeNull();
    expect(checkAccess(rule('backup:runNow'), { setupComplete: true, user: salesman })?.code).toBe('FORBIDDEN');
    expect(checkAccess(rule('restore:start'), { setupComplete: false, user: null })).toBeNull();
    expect(checkAccess(rule('restore:start'), { setupComplete: true, user: null })?.code).toBe('UNAUTHENTICATED');
    expect(checkAccess(rule('setup:createShop'), { setupComplete: true, user: owner })?.code).toBe('CONFLICT');
    expect(checkAccess(rule('auth:loginPassword'), { setupComplete: true, user: null })).toBeNull();
  });
});

describe('session', () => {
  it('ends after the idle limit and counts requests as activity', () => {
    let now = 0;
    const session = new SessionManager(() => 15 * 60000, () => now);
    session.start({ id: '1', fullName: 'O', username: 'o', role: 'owner', permissions: [], mustChangePassword: false });
    now += 10 * 60000;
    expect(session.current()?.username).toBe('o');
    now += 14 * 60000;
    expect(session.current()?.username).toBe('o');
    now += 16 * 60000;
    expect(session.current()).toBeNull();
    expect(session.actor()).toBe('system');
  });
});

describe('auth over IPC', () => {
  it('signs in, refuses role-restricted calls and locks', async () => {
    const dir = tempDir();
    const db = openDatabase(join(dir.path, 'ipc.db'), TEST_KEY);
    try {
      migrate(db, migrations, { appVersion: '0.1.0' });
      const audit = new AuditLog(db);
      const users = new UserService(db, audit, { hashCost: FAST });
      const session = new SessionManager(() => 15 * 60000);
      const router = new IpcRouter({
        validateOutput: true,
        logError: () => undefined,
        authorize: (channel) => checkAccess(ACCESS_RULES[channel], { setupComplete: users.isSetupComplete(), user: session.current() }),
      });
      registerAuthHandlers(router, { users, session, settings: new SettingsStore(db), onSessionEnded: () => undefined });
      const ctx = { senderUrl: 'file:///app' };

      expect(await router.dispatch('setup:state', undefined, ctx)).toMatchObject({ ok: true, data: { completed: false } });
      const created = await router.dispatch('setup:createShop', { shop: SHOP, owner: OWNER }, ctx);
      expect(created.ok).toBe(true);
      expect(await router.dispatch('users:create', { fullName: 'Ali', username: 'ali', role: 'salesman', password: 'temp-pass-1' }, ctx)).toEqual({ ok: true, data: null });

      await router.dispatch('auth:lock', undefined, ctx);
      expect((await router.dispatch('users:list', undefined, ctx)).ok).toBe(false);

      await router.dispatch('auth:loginPassword', { username: 'ali', password: 'temp-pass-1' }, ctx);
      const denied = await router.dispatch('users:list', undefined, ctx);
      expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(audit.verify().valid).toBe(true);
    } finally {
      db.close();
      dir.cleanup();
    }
  });
});
