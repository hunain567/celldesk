import { useState } from 'react';
import { DeviceIcon, SystemIcon } from './components/icons';
import { SystemScreen } from './screens/SystemScreen';

/**
 * Application shell. Navigation lists only screens that exist; each module adds
 * its own entry when it is built.
 */
const screens = [{ id: 'system', label: 'System', icon: SystemIcon, render: () => <SystemScreen /> }] as const;

type ScreenId = (typeof screens)[number]['id'];

export function App() {
  const [current, setCurrent] = useState<ScreenId>('system');
  const screen = screens.find((item) => item.id === current) ?? screens[0];

  return (
    <div className="cd-shell">
      <aside className="cd-sidebar">
        <div className="cd-brand">
          <span className="cd-brand__mark">
            <DeviceIcon />
          </span>
          <div>
            <div className="cd-brand__name">CellDesk</div>
            <div className="cd-brand__by">by NexoERP</div>
          </div>
        </div>

        <nav className="cd-nav" aria-label="Main">
          <div className="cd-nav__label">Settings</div>
          {screens.map((item) => (
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
