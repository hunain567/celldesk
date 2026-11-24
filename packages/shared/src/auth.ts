import { z } from 'zod';

export const RoleSchema = z.enum(['owner', 'manager', 'salesman', 'technician']);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  salesman: 'Salesman',
  technician: 'Technician',
};

/**
 * Permissions for features that exist today. Each new module adds its own
 * permissions here and grants them to roles below.
 */
export const PermissionSchema = z.enum([
  'users.manage',
  'shop.manage',
  'backup.manage',
  'backup.run',
  'data.restore',
  'license.manage',
  'system.check',
  'audit.verify',
  'catalog.manage',
  'stock.view',
  'cost.view',
  'supplier.manage',
  'supplier.pay',
  'purchase.view',
  'purchase.create',
  'purchase.return',
]);
export type Permission = z.infer<typeof PermissionSchema>;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PermissionSchema.options,
  manager: [
    'backup.run',
    'system.check',
    'catalog.manage',
    'stock.view',
    'cost.view',
    'supplier.manage',
    'supplier.pay',
    'purchase.view',
    'purchase.create',
    'purchase.return',
  ],
  salesman: ['stock.view'],
  technician: ['stock.view'],
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const MIN_USER_PASSWORD = 8;
export const PIN_PATTERN = /^\d{4,6}$/;

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, 'Use 3 to 32 letters, numbers, dots, dashes or underscores');
export const UserPasswordSchema = z
  .string()
  .min(MIN_USER_PASSWORD, `Use at least ${MIN_USER_PASSWORD} characters`)
  .max(256);
export const PinSchema = z.string().regex(PIN_PATTERN, 'A PIN has 4 to 6 digits');
export const FullNameSchema = z.string().trim().min(1, 'Enter the name').max(100);

export const SessionUserSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  username: z.string(),
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const UserSummarySchema = z.object({
  id: z.string(),
  fullName: z.string(),
  username: z.string(),
  role: RoleSchema,
  isActive: z.boolean(),
  hasPin: z.boolean(),
  lockedUntil: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const PinUserSchema = z.object({ id: z.string(), fullName: z.string(), role: RoleSchema });
export type PinUser = z.infer<typeof PinUserSchema>;

export const ShopProfileSchema = z.object({
  shopName: z.string().trim().min(1, 'Enter the shop name').max(120),
  ownerName: z.string().trim().max(100),
  phone: z.string().trim().max(40),
  address: z.string().trim().max(300),
  city: z.string().trim().max(80),
  /** Printed at the bottom of receipts. */
  receiptFooter: z.string().trim().max(300),
});
export type ShopProfile = z.infer<typeof ShopProfileSchema>;

export const SetupStateSchema = z.object({
  completed: z.boolean(),
  shopName: z.string().nullable(),
  autoLockMinutes: z.number().int(),
});
export type SetupState = z.infer<typeof SetupStateSchema>;

export const NewUserSchema = z.object({
  fullName: FullNameSchema,
  username: UsernameSchema,
  role: RoleSchema,
  password: UserPasswordSchema,
  pin: PinSchema.optional(),
});
export type NewUser = z.infer<typeof NewUserSchema>;
