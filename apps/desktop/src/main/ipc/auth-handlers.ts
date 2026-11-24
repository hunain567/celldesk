import type { SessionUser } from '@nexodesk/shared';
import { AppError } from '../errors';
import type { SessionManager } from '../services/session';
import type { SettingsStore } from '../services/settings';
import type { UserService } from '../services/users';
import type { IpcRouter } from './router';

export interface AuthHandlerDependencies {
  users: UserService;
  session: SessionManager;
  settings: SettingsStore;
  onSessionEnded: () => void;
}

function requireUser(session: SessionManager): SessionUser {
  const user = session.current();
  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
  return user;
}

export function registerAuthHandlers(router: IpcRouter, deps: AuthHandlerDependencies): void {
  const { users, session } = deps;

  router.register('setup:state', () => ({
    completed: users.isSetupComplete(),
    shopName: users.getShop()?.shopName ?? null,
    autoLockMinutes: deps.settings.get('security.autoLockMinutes'),
  }));

  router.register('setup:createShop', async ({ shop, owner }) => {
    const user = await users.createShop(shop, owner);
    session.start(user);
    return user;
  });

  router.register('auth:session', () => {
    const current = session.current();
    if (!current) return null;
    // Pick up role changes or deactivation made since sign-in.
    const fresh = users.refresh(current.id);
    session.replace(fresh);
    return fresh;
  });

  router.register('auth:loginPassword', async ({ username, password }) => {
    const user = await users.loginWithPassword(username, password);
    session.start(user);
    return user;
  });

  router.register('auth:loginPin', async ({ userId, pin }) => {
    const user = await users.loginWithPin(userId, pin);
    session.start(user);
    return user;
  });

  router.register('auth:pinUsers', () => users.pinUsers());

  router.register('auth:lock', () => {
    session.end();
    deps.onSessionEnded();
    return null;
  });

  router.register('auth:changePassword', async ({ currentPassword, newPassword }) => {
    const user = requireUser(session);
    const updated = await users.changeOwnPassword(user.id, currentPassword, newPassword);
    session.replace(updated);
    return updated;
  });

  router.register('users:list', () => users.list());

  router.register('users:create', async (input) => {
    await users.create(input, session.actor());
    return null;
  });

  router.register('users:update', (input) => {
    const actor = requireUser(session);
    users.update(input, actor.username);
    // A user who deactivated or demoted themselves is signed out at once.
    if (input.id === actor.id) {
      const fresh = users.refresh(actor.id);
      session.replace(fresh);
      if (!fresh) deps.onSessionEnded();
    }
    return null;
  });

  router.register('users:resetPassword', async ({ id, newPassword }) => {
    await users.resetPassword(id, newPassword, session.actor());
    return null;
  });

  router.register('users:setPin', async ({ id, pin }) => {
    await users.setPin(id, pin, session.actor());
    return null;
  });

  router.register('shop:get', () => users.getShop());

  router.register('shop:update', (shop) => {
    users.saveShop(shop, session.actor());
    return null;
  });
}
