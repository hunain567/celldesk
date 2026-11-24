import {
  NewUserSchema,
  ROLE_PERMISSIONS,
  ShopProfileSchema,
  UserPasswordSchema,
  type NewUser,
  type PinUser,
  type Role,
  type SessionUser,
  type ShopProfile,
  type UserSummary,
} from '@nexodesk/shared';
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/connection';
import { AppError } from '../errors';
import type { AuditLog } from './audit';
import { DEFAULT_HASH_COST, hashSecret, verifySecret, type HashCost } from './passwords';

/** Wrong attempts before an account is locked, and how long it stays locked. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 5;

interface UserRow {
  id: string;
  full_name: string;
  username: string;
  role: Role;
  password_hash: string;
  pin_hash: string | null;
  is_active: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

function toSession(row: UserRow): SessionUser {
  return {
    id: row.id,
    fullName: row.full_name,
    username: row.username,
    role: row.role,
    permissions: [...ROLE_PERMISSIONS[row.role]],
    mustChangePassword: row.must_change_password === 1,
  };
}

function validation(error: { issues: Array<{ message: string }> }): AppError {
  return new AppError('VALIDATION_FAILED', error.issues[0]?.message ?? 'Invalid data', error.issues.map((issue) => issue.message));
}

/** Shop profile, user accounts and sign-in checks. */
export class UserService {
  private readonly now: () => Date;
  private readonly cost: HashCost;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly audit: AuditLog,
    options: { now?: () => Date; hashCost?: HashCost } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.cost = options.hashCost ?? DEFAULT_HASH_COST;
  }

  // ---------- Setup and shop profile ----------

  isSetupComplete(): boolean {
    return this.db.prepare(`SELECT 1 FROM app_meta WHERE key = 'setup_completed_at'`).get() !== undefined;
  }

  getShop(): ShopProfile | null {
    const row = this.db.prepare('SELECT * FROM shop_profile WHERE id = 1').get() as
      | { shop_name: string; owner_name: string; phone: string; address: string; city: string; receipt_footer: string }
      | undefined;
    if (!row) return null;
    return {
      shopName: row.shop_name,
      ownerName: row.owner_name,
      phone: row.phone,
      address: row.address,
      city: row.city,
      receiptFooter: row.receipt_footer,
    };
  }

  saveShop(input: ShopProfile, actor: string): void {
    const parsed = ShopProfileSchema.safeParse(input);
    if (!parsed.success) throw validation(parsed.error);
    const shop = parsed.data;
    this.db
      .prepare(
        `INSERT INTO shop_profile (id, shop_name, owner_name, phone, address, city, receipt_footer, updated_at)
         VALUES (1, @shopName, @ownerName, @phone, @address, @city, @receiptFooter, @now)
         ON CONFLICT(id) DO UPDATE SET shop_name = excluded.shop_name, owner_name = excluded.owner_name,
           phone = excluded.phone, address = excluded.address, city = excluded.city,
           receipt_footer = excluded.receipt_footer, updated_at = excluded.updated_at`,
      )
      .run({ ...shop, now: this.now().toISOString() });
    this.audit.append({ actor, action: 'shop.update', entityType: 'shop', entityId: '1' });
  }

  /** First run: shop profile and the owner account, in one transaction. Allowed only once. */
  async createShop(shop: ShopProfile, owner: Omit<NewUser, 'role'>): Promise<SessionUser> {
    if (this.isSetupComplete()) throw new AppError('CONFLICT', 'This shop is already set up.');
    const parsedOwner = NewUserSchema.safeParse({ ...owner, role: 'owner' });
    if (!parsedOwner.success) throw validation(parsedOwner.error);
    const parsedShop = ShopProfileSchema.safeParse(shop);
    if (!parsedShop.success) throw validation(parsedShop.error);

    const passwordHash = await hashSecret(parsedOwner.data.password, this.cost);
    const pinHash = parsedOwner.data.pin ? await hashSecret(parsedOwner.data.pin, this.cost) : null;
    const id = randomUUID();
    const now = this.now().toISOString();

    const create = this.db.transaction(() => {
      if (this.isSetupComplete()) throw new AppError('CONFLICT', 'This shop is already set up.');
      this.saveShop(parsedShop.data, parsedOwner.data.username);
      this.insertUser(id, { ...parsedOwner.data, role: 'owner' }, passwordHash, pinHash, now, false);
      this.db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES ('setup_completed_at', ?, ?)`).run(now, now);
      this.audit.append({ actor: parsedOwner.data.username, action: 'setup.complete', details: { shop: parsedShop.data.shopName } });
    });
    create();
    return toSession(this.rowById(id)!);
  }

  // ---------- Users ----------

  private rowById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  private insertUser(
    id: string,
    user: NewUser,
    passwordHash: string,
    pinHash: string | null,
    now: string,
    mustChangePassword: boolean,
  ): void {
    const taken = this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(user.username);
    if (taken) throw new AppError('CONFLICT', `The username "${user.username}" is already used.`);
    this.db
      .prepare(
        `INSERT INTO users (id, full_name, username, role, password_hash, pin_hash, is_active, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, user.fullName, user.username, user.role, passwordHash, pinHash, mustChangePassword ? 1 : 0, now, now);
  }

  list(): UserSummary[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY is_active DESC, role, full_name').all() as UserRow[];
    return rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      username: row.username,
      role: row.role,
      isActive: row.is_active === 1,
      hasPin: row.pin_hash !== null,
      lockedUntil: row.locked_until && Date.parse(row.locked_until) > this.now().getTime() ? row.locked_until : null,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
    }));
  }

  /** Users who can sign in with a PIN at the counter. */
  pinUsers(): PinUser[] {
    return (
      this.db
        .prepare(`SELECT id, full_name, role FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL ORDER BY full_name`)
        .all() as Array<{ id: string; full_name: string; role: Role }>
    ).map((row) => ({ id: row.id, fullName: row.full_name, role: row.role }));
  }

  /** New staff accounts must choose their own password at first sign-in. */
  async create(input: NewUser, actor: string): Promise<void> {
    const parsed = NewUserSchema.safeParse(input);
    if (!parsed.success) throw validation(parsed.error);
    const passwordHash = await hashSecret(parsed.data.password, this.cost);
    const pinHash = parsed.data.pin ? await hashSecret(parsed.data.pin, this.cost) : null;
    const id = randomUUID();
    this.insertUser(id, parsed.data, passwordHash, pinHash, this.now().toISOString(), true);
    this.audit.append({ actor, action: 'user.create', entityType: 'user', entityId: id, details: { username: parsed.data.username, role: parsed.data.role } });
  }

  private activeOwnerCount(): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM users WHERE role = 'owner' AND is_active = 1`).get() as { n: number }).n;
  }

  update(input: { id: string; fullName: string; role: Role; isActive: boolean }, actor: string): void {
    const row = this.rowById(input.id);
    if (!row) throw new AppError('NOT_FOUND', 'This user no longer exists.');
    const losingOwner = row.role === 'owner' && row.is_active === 1 && (input.role !== 'owner' || !input.isActive);
    if (losingOwner && this.activeOwnerCount() <= 1) {
      throw new AppError('CONFLICT', 'The shop needs at least one active owner. Make another user an owner first.');
    }
    const update = this.db.transaction(() => {
      this.db
        .prepare('UPDATE users SET full_name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.fullName.trim() || row.full_name, input.role, input.isActive ? 1 : 0, this.now().toISOString(), input.id);
      this.audit.append({
        actor,
        action: 'user.update',
        entityType: 'user',
        entityId: input.id,
        details: { role: input.role, active: input.isActive },
      });
    });
    update();
  }

  /** Owner resets a forgotten password; the user must change it at next sign-in. Also unlocks the account. */
  async resetPassword(id: string, newPassword: string, actor: string): Promise<void> {
    const parsed = UserPasswordSchema.safeParse(newPassword);
    if (!parsed.success) throw validation(parsed.error);
    if (!this.rowById(id)) throw new AppError('NOT_FOUND', 'This user no longer exists.');
    const hash = await hashSecret(parsed.data, this.cost);
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(hash, this.now().toISOString(), id);
    this.audit.append({ actor, action: 'user.reset_password', entityType: 'user', entityId: id });
  }

  async setPin(id: string, pin: string | null, actor: string): Promise<void> {
    if (!this.rowById(id)) throw new AppError('NOT_FOUND', 'This user no longer exists.');
    if (pin !== null && !/^\d{4,6}$/.test(pin)) throw new AppError('VALIDATION_FAILED', 'A PIN has 4 to 6 digits.');
    const hash = pin === null ? null : await hashSecret(pin, this.cost);
    this.db.prepare('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?').run(hash, this.now().toISOString(), id);
    this.audit.append({ actor, action: pin === null ? 'user.pin_remove' : 'user.pin_set', entityType: 'user', entityId: id });
  }

  async changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<SessionUser> {
    const row = this.rowById(id);
    if (!row) throw new AppError('NOT_FOUND', 'This user no longer exists.');
    if (!(await verifySecret(currentPassword, row.password_hash))) {
      throw new AppError('VALIDATION_FAILED', 'The current password is not correct.');
    }
    const parsed = UserPasswordSchema.safeParse(newPassword);
    if (!parsed.success) throw validation(parsed.error);
    if (currentPassword === newPassword) throw new AppError('VALIDATION_FAILED', 'Choose a password different from the current one.');
    const hash = await hashSecret(parsed.data, this.cost);
    this.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(hash, this.now().toISOString(), id);
    this.audit.append({ actor: row.username, action: 'user.change_password', entityType: 'user', entityId: id });
    return toSession(this.rowById(id)!);
  }

  // ---------- Sign-in ----------

  private assertCanTry(row: UserRow | undefined): asserts row is UserRow {
    if (!row || row.is_active !== 1) throw new AppError('VALIDATION_FAILED', 'The username or password is not correct.');
    if (row.locked_until && Date.parse(row.locked_until) > this.now().getTime()) {
      const minutes = Math.ceil((Date.parse(row.locked_until) - this.now().getTime()) / 60000);
      throw new AppError('FORBIDDEN', `Too many wrong attempts. This account is locked for ${minutes} more minute${minutes === 1 ? '' : 's'}.`);
    }
  }

  private recordFailure(row: UserRow, method: string): void {
    const attempts = row.failed_attempts + 1;
    const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? new Date(this.now().getTime() + LOCK_MINUTES * 60000).toISOString() : null;
    this.db
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(lockedUntil ? 0 : attempts, lockedUntil, row.id);
    this.audit.append({
      actor: row.username,
      action: lockedUntil ? 'auth.locked' : 'auth.failed',
      entityType: 'user',
      entityId: row.id,
      details: { method },
    });
  }

  private recordSuccess(row: UserRow, method: string): SessionUser {
    const now = this.now().toISOString();
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now, row.id);
    this.audit.append({ actor: row.username, action: 'auth.login', entityType: 'user', entityId: row.id, details: { method } });
    return toSession(row);
  }

  async loginWithPassword(username: string, password: string): Promise<SessionUser> {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserRow | undefined;
    this.assertCanTry(row);
    if (!(await verifySecret(password, row.password_hash))) {
      this.recordFailure(row, 'password');
      throw new AppError('VALIDATION_FAILED', 'The username or password is not correct.');
    }
    return this.recordSuccess(row, 'password');
  }

  async loginWithPin(userId: string, pin: string): Promise<SessionUser> {
    const row = this.rowById(userId);
    this.assertCanTry(row);
    if (!row.pin_hash) throw new AppError('VALIDATION_FAILED', 'This user signs in with a password.');
    if (row.must_change_password === 1) {
      throw new AppError('VALIDATION_FAILED', 'Sign in with your password first to set a new one.');
    }
    if (!(await verifySecret(pin, row.pin_hash))) {
      this.recordFailure(row, 'pin');
      throw new AppError('VALIDATION_FAILED', 'The PIN is not correct.');
    }
    return this.recordSuccess(row, 'pin');
  }

  /** Re-reads a signed-in user, so a role change or deactivation applies immediately. */
  refresh(id: string): SessionUser | null {
    const row = this.rowById(id);
    return row && row.is_active === 1 ? toSession(row) : null;
  }
}
