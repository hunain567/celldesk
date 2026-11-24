import { useEffect, useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { BackupIcon, DeviceIcon, RestoreIcon, SystemIcon } from './components/icons';
import { useToast } from './components/toast';
import { BackupScreen } from './screens/BackupScreen';
import { RestoreScreen } from './screens/RestoreScreen';
import { SystemScreen } from './screens/SystemScreen';

interface ScreenDefinition {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  render: () => ReactElement;
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
    screens: [{ id: 'system', label: 'System', icon: SystemIcon, render: () => <SystemScreen /> }],
  },
];

const allScreens = sections.flatMap((section) => section.screens);

export function App() {
  const notify = useToast();
  const [current, setCurrent] = useState('backup');
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
        <div className="cd-content">{screen.render()}</div>
      </main>
    </div>
  );
}
