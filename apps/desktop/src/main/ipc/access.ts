import type { IpcChannel, IpcError, Permission, SessionUser } from '@nexodesk/shared';

/**
 * Who may call each channel. Every channel in the contract must have a rule
 * (a test checks this), so a new feature cannot be added without deciding
 * who may use it.
 */
export type AccessRule =
  | { kind: 'public' }
  | { kind: 'setup' }
  | { kind: 'session' }
  | { kind: 'permission'; permission: Permission }
  /** Allowed before the first setup (to restore a shop onto a new PC), otherwise needs the permission. */
  | { kind: 'setup-or-permission'; permission: Permission };

const pub: AccessRule = { kind: 'public' };
const session: AccessRule = { kind: 'session' };
const need = (permission: Permission): AccessRule => ({ kind: 'permission', permission });
const setupOr = (permission: Permission): AccessRule => ({ kind: 'setup-or-permission', permission });

export const ACCESS_RULES: Record<IpcChannel, AccessRule> = {
  'system:info': session,
  'system:integrityCheck': need('system.check'),
  'settings:get': pub,
  'settings:set': session,
  'audit:verify': need('audit.verify'),

  'backup:status': need('backup.run'),
  'backup:chooseFolder': need('backup.manage'),
  'backup:setup': need('backup.manage'),
  'backup:addDestination': need('backup.manage'),
  'backup:removeDestination': need('backup.manage'),
  'backup:setSchedule': need('backup.manage'),
  'backup:runNow': need('backup.run'),
  'backup:history': need('backup.run'),

  'restore:chooseFile': setupOr('data.restore'),
  'restore:inspect': setupOr('data.restore'),
  'restore:verify': setupOr('data.restore'),
  'restore:start': setupOr('data.restore'),
  'restore:lastOutcome': pub,

  'license:status': session,
  'license:requestCode': need('license.manage'),
  'license:saveRequestFile': need('license.manage'),
  'license:importFile': need('license.manage'),
  'license:importCode': need('license.manage'),

  'setup:state': pub,
  'setup:createShop': { kind: 'setup' },

  'auth:session': pub,
  'auth:loginPassword': pub,
  'auth:loginPin': pub,
  'auth:pinUsers': pub,
  'auth:lock': pub,
  'auth:changePassword': session,

  'users:list': need('users.manage'),
  'users:create': need('users.manage'),
  'users:update': need('users.manage'),
  'users:resetPassword': need('users.manage'),
  'users:setPin': need('users.manage'),

  'shop:get': session,
  'shop:update': need('shop.manage'),
};

const SIGN_IN: IpcError = { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' };
const NOT_ALLOWED: IpcError = { code: 'FORBIDDEN', message: 'Your role does not allow this. Ask the shop owner.' };

export function checkAccess(rule: AccessRule, state: { setupComplete: boolean; user: SessionUser | null }): IpcError | null {
  switch (rule.kind) {
    case 'public':
      return null;
    case 'setup':
      return state.setupComplete ? { code: 'CONFLICT', message: 'This shop is already set up.' } : null;
    case 'session':
      return state.user ? null : SIGN_IN;
    case 'permission':
      if (!state.user) return SIGN_IN;
      return state.user.permissions.includes(rule.permission) ? null : NOT_ALLOWED;
    case 'setup-or-permission':
      if (!state.setupComplete) return null;
      if (!state.user) return SIGN_IN;
      return state.user.permissions.includes(rule.permission) ? null : NOT_ALLOWED;
  }
}
