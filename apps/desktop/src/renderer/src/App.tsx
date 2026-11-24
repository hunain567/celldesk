import type { LicenseStatus } from '@nexodesk/shared';
import { useCallback, useEffect, useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { BackupIcon, DeviceIcon, KeyIcon, RestoreIcon, SystemIcon } from './components/icons';
import { useToast } from './components/toast';
import { Banner, Button } from './components/ui';
import { call } from './lib/api';
import { BackupScreen } from './screens/BackupScreen';
import { LicenseScreen, LICENSE_STATE_LABELS } from './screens/LicenseScreen';
import { RestoreScreen } from './screens/RestoreScreen';
import { SystemScreen } from './screens/SystemScreen';

interface ScreenContext {
  license: LicenseStatus | null;
  reloadLicense: () => void;
}

interface ScreenDefinition {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  render: (context: ScreenContext) => ReactElement;
}

/**
 * Application shell. Navigation lists only screens that exist; each module adds
 * its own entry when it is built.
 */
const sections: Array<{ label: string; screens: ScreenDefinition[] }> = [
  {
    label: 'Data safety',
    screens: [
      { id: 'backup', label: 'Backups', icon: BackupIcon, render: () => <BackupScreen /> },
      { id: 'restore', label: 'Restore Center', icon: RestoreIcon, render: () => <RestoreScreen /> },
    ],
  },
  {
    label: 'Settings',
    screens: [
      {
        id: 'license',
        label: 'Licence',
        icon: KeyIcon,
        render: ({ license, reloadLicense }) => <LicenseScreen status={license} onChanged={reloadLicense} />,
      },
      { id: 'system', label: 'System', icon: SystemIcon, render: () => <SystemScreen /> },
    ],
  },
];

const allScreens = sections.flatMap((section) => section.screens);

/** Shown above every screen except the Licence screen when the licence needs attention. */
function LicenseBanner({ status, onOpen }: { status: LicenseStatus; onOpen: () => void }) {
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
      <Banner tone={tone} title={title} actions={<Button onClick={onOpen}>{status.state === 'unlicensed' ? 'Activate' : 'Open licence'}</Button>}>
        {status.state === 'expiring' ? 'Renew now to avoid any interruption.' : status.reason}
      </Banner>
    </div>
  );
}

export function App() {
  const notify = useToast();
  const [current, setCurrent] = useState<string | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);

  const reloadLicense = useCallback(() => {
    void call('license:status')
      .then((status) => {
        setLicense(status);
        // First screen: activation when not licensed yet, otherwise backups.
        setCurrent((previous) => previous ?? (status.state === 'unlicensed' ? 'license' : 'backup'));
      })
      .catch(() => setCurrent((previous) => previous ?? 'backup'));
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

  const screen = allScreens.find((item) => item.id === current) ?? allScreens[0]!;

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

        {sections.map((section) => (
          <nav key={section.label} className="cd-nav" aria-label={section.label}>
            <div className="cd-nav__label">{section.label}</div>
            {section.screens.map((item) => (
              <button
                key={item.id}
                type="button"
                className="cd-nav__item"
                aria-current={item.id === current ? 'page' : undefined}
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
        </header>
        {license && screen.id !== 'license' ? <LicenseBanner status={license} onOpen={() => setCurrent('license')} /> : null}
        <div className="cd-content">{current ? screen.render({ license, reloadLicense }) : null}</div>
      </main>
    </div>
  );
}
