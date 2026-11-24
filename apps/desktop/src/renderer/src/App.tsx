import type { LicenseStatus, Permission } from '@nexodesk/shared';
import { ROLE_LABELS } from '@nexodesk/shared';
import { useCallback, useEffect, useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { BackupIcon, DeviceIcon, KeyIcon, LockIcon, RestoreIcon, StoreIcon, SystemIcon, UsersIcon } from './components/icons';
import { useToast } from './components/toast';
import { Banner, Button } from './components/ui';
import { call } from './lib/api';
import { useAuth } from './lib/auth';
import { BackupScreen } from './screens/BackupScreen';
import { LicenseScreen, LICENSE_STATE_LABELS } from './screens/LicenseScreen';
import { LoginScreen } from './screens/LoginScreen';
import { RestoreScreen } from './screens/RestoreScreen';
import { SetupWizard } from './screens/SetupWizard';
import { ShopScreen } from './screens/ShopScreen';
import { SystemScreen } from './screens/SystemScreen';
import { UsersScreen } from './screens/UsersScreen';

interface ScreenContext {
  license: LicenseStatus | null;
  reloadLicense: () => void;
}

interface ScreenDefinition {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Hidden from users whose role lacks it; the backend checks it again on every request. */
  permission?: Permission;
  render: (context: ScreenContext) => ReactElement;
}

/**
 * Navigation lists only screens that exist and that the signed-in user may use.
 * Each module adds its own entries when it is built.
 */
const sections: Array<{ label: string; screens: ScreenDefinition[] }> = [
  {
    label: 'Data safety',
    screens: [
      { id: 'backup', label: 'Backups', icon: BackupIcon, permission: 'backup.run', render: () => <BackupScreen /> },
      { id: 'restore', label: 'Restore Center', icon: RestoreIcon, permission: 'data.restore', render: () => <RestoreScreen /> },
    ],
  },
  {
    label: 'Settings',
    screens: [
      { id: 'shop', label: 'Shop', icon: StoreIcon, permission: 'shop.manage', render: () => <ShopScreen /> },
      { id: 'users', label: 'Users', icon: UsersIcon, permission: 'users.manage', render: () => <UsersScreen /> },
      {
        id: 'license',
        label: 'Licence',
        icon: KeyIcon,
        permission: 'license.manage',
        render: ({ license, reloadLicense }) => <LicenseScreen status={license} onChanged={reloadLicense} />,
      },
      { id: 'system', label: 'System', icon: SystemIcon, render: () => <SystemScreen /> },
    ],
  },
];

/** Shown above every screen except the Licence screen when the licence needs attention. */
function LicenseBanner({ status, onOpen }: { status: LicenseStatus; onOpen: (() => void) | null }) {
  if (status.state === 'active') return null;
  const label = LICENSE_STATE_LABELS[status.state];
  const tone = status.state === 'expiring' || status.state === 'grace' ? 'warning' : status.state === 'unlicensed' ? 'info' : 'danger';
  const title =
    status.state === 'expiring'
      ? `Your subscription ends in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}`
      : status.state === 'unlicensed'
        ? 'NexoDesk is not activated yet'
        : label.label;
  return (
    <div className="cd-shell-banner">
      <Banner
        tone={tone}
        title={title}
        actions={onOpen ? <Button onClick={onOpen}>{status.state === 'unlicensed' ? 'Activate' : 'Open licence'}</Button> : undefined}
      >
        {status.state === 'expiring' ? 'Renew now to avoid any interruption.' : status.reason}
        {!onOpen ? ' Tell the shop owner.' : ''}
      </Banner>
    </div>
  );
}

function Shell() {
  const notify = useToast();
  const { user, can, lock } = useAuth();
  const [current, setCurrent] = useState<string | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  const visibleSections = sections
    .map((section) => ({ ...section, screens: section.screens.filter((screen) => !screen.permission || can(screen.permission)) }))
    .filter((section) => section.screens.length > 0);
  const visibleScreens = visibleSections.flatMap((section) => section.screens);

  const reloadLicense = useCallback(() => {
    void call('license:status')
      .then(setLicense)
      .catch(() => setLicense(null));
  }, []);

  useEffect(() => {
    reloadLicense();
    // Expiry is time-based: re-check every 5 minutes while the app is open.
    const timer = window.setInterval(reloadLicense, 5 * 60 * 1000);
    const unsubscribe = window.nexodesk.onEvent((event) => {
      if (event.type === 'license.changed') reloadLicense();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [reloadLicense]);

  // Automatic backups run in the background; tell the user how they ended, whichever screen is open.
  useEffect(
    () =>
      window.nexodesk.onEvent((event) => {
        if (event.type !== 'backup.finished' || event.kind !== 'scheduled') return;
        if (event.status === 'success') {
          notify({ tone: 'success', title: 'Automatic backup completed and verified' });
        } else {
          notify({
            tone: 'danger',
            title: event.status === 'partial' ? 'Automatic backup saved to some locations only' : 'Automatic backup failed',
            message: event.error ?? 'Open Backups for details.',
          });
        }
      }),
    [notify],
  );

  if (!user) return null;
  const screen = visibleScreens.find((item) => item.id === current) ?? visibleScreens[0]!;
  const canManageLicense = can('license.manage');

  return (
    <div className="cd-shell">
      <aside className="cd-sidebar">
        <div className="cd-brand">
          <span className="cd-brand__mark">
            <DeviceIcon />
          </span>
          <div>
            <div className="cd-brand__name">NexoDesk</div>
            <div className="cd-brand__by">by NexoERP</div>
          </div>
        </div>

        {visibleSections.map((section) => (
          <nav key={section.label} className="cd-nav" aria-label={section.label}>
            <div className="cd-nav__label">{section.label}</div>
            {section.screens.map((item) => (
              <button
                key={item.id}
                type="button"
                className="cd-nav__item"
                aria-current={item.id === screen.id ? 'page' : undefined}
                onClick={() => setCurrent(item.id)}
              >
                <item.icon />
                {item.label}
              </button>
            ))}
          </nav>
        ))}

        <div className="cd-sidebar__footer">Offline. Data stays on this PC.</div>
      </aside>

      <main className="cd-main">
        <header className="cd-topbar">
          <h1 className="cd-topbar__title">{screen.label}</h1>
          <div className="cd-topbar__user">
            <div className="cd-topbar__who">
              <div className="cd-topbar__name">{user.fullName}</div>
              <div className="cd-topbar__role">{ROLE_LABELS[user.role]}</div>
            </div>
            <Button variant="ghost" onClick={() => setChangingPassword(true)}>
              Change password
            </Button>
            <Button icon={<LockIcon />} onClick={() => void lock()}>
              Lock
            </Button>
          </div>
        </header>
        {license && screen.id !== 'license' ? (
          <LicenseBanner status={license} onOpen={canManageLicense ? () => setCurrent('license') : null} />
        ) : null}
        <div className="cd-content">{screen.render({ license, reloadLicense })}</div>
      </main>

      {user.mustChangePassword || changingPassword ? (
        <ChangePasswordDialog required={user.mustChangePassword} onClose={() => setChangingPassword(false)} />
      ) : null}
    </div>
  );
}

/** Decides what the person sees: first-run setup, sign-in, or the app. */
export function App() {
  const { setup, user } = useAuth();
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => {
    if (setup && !setup.completed) setWizardOpen(true);
  }, [setup]);

  if (!setup) {
    return (
      <div className="cd-center">
        <span className="cd-spinner" aria-label="Loading" />
      </div>
    );
  }
  if (!setup.completed || wizardOpen) {
    return <SetupWizard onFinished={() => setWizardOpen(false)} />;
  }
  if (!user) return <LoginScreen />;
  return <Shell key={user.id} />;
}
