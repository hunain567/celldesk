import { useCallback, useEffect, useState } from 'react';
import { KeyIcon, SystemIcon } from '@ui/components/icons';
import { useToast } from '@ui/components/toast';
import { Banner, Button, Field, Panel } from '@ui/components/ui';
import { lm, message } from './api';
import { LicenseDetailScreen } from './screens/LicenseDetailScreen';
import { LicensesScreen } from './screens/LicensesScreen';
import { SettingsScreen } from './screens/SettingsScreen';

const MIN_PASSWORD = 12;

/** First run creates the vault; later runs unlock it. Nothing is shown before that. */
function VaultGate({ exists, onUnlocked }: { exists: boolean; onUnlocked: () => void }) {
  const notify = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (exists) await lm('vault:unlock', { password });
      else await lm('vault:create', { password });
      setPassword('');
      setConfirm('');
      onUnlocked();
    } catch (error) {
      notify({ tone: 'danger', title: exists ? 'Could not unlock' : 'Could not set up', message: message(error) });
    } finally {
      setBusy(false);
    }
  }

  const ready = exists ? password.length > 0 : password.length >= MIN_PASSWORD && password === confirm && acknowledged;

  return (
    <div className="cd-overlay">
      <form
        style={{ width: 460 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void submit();
        }}
      >
        <Panel
          title={exists ? 'Unlock License Manager' : 'Set up License Manager'}
          description={
            exists
              ? 'Enter the master password.'
              : 'This creates your private signing key. Only this app, on this laptop, can issue NexoDesk licences.'
          }
        >
          <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
            <Field label="Master password" hint={exists ? undefined : `At least ${MIN_PASSWORD} characters`}>
              {(id) => (
                <input id={id} className="cd-input" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
              )}
            </Field>
            {!exists ? (
              <>
                <Field label="Confirm master password" error={confirm && confirm !== password ? 'The passwords do not match.' : null}>
                  {(id) => (
                    <input id={id} className="cd-input" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
                  )}
                </Field>
                <Banner tone="warning" title="There is no password recovery">
                  If the master password is forgotten, no new licences or renewals can be issued for any shop.
                  Write it down and keep it safe.
                </Banner>
                <label className="cd-checkbox">
                  <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                  <span>I have written down the master password.</span>
                </label>
              </>
            ) : null}
            <div>
              <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
                {exists ? 'Unlock' : 'Create and continue'}
              </Button>
            </div>
          </div>
        </Panel>
      </form>
    </div>
  );
}

type View = { screen: 'licenses' } | { screen: 'license'; id: string } | { screen: 'settings' };

export function App() {
  const [vault, setVault] = useState<{ exists: boolean; unlocked: boolean } | null>(null);
  const [view, setView] = useState<View>({ screen: 'licenses' });

  const refresh = useCallback(() => {
    void lm('vault:state').then(setVault);
  }, []);
  useEffect(refresh, [refresh]);

  if (!vault) return null;
  if (!vault.unlocked) return <VaultGate exists={vault.exists} onUnlocked={refresh} />;

  const title = view.screen === 'settings' ? 'Settings' : 'Licences';
  return (
    <div className="cd-shell">
      <aside className="cd-sidebar">
        <div className="cd-brand">
          <span className="cd-brand__mark">
            <KeyIcon />
          </span>
          <div>
            <div className="cd-brand__name">License Manager</div>
            <div className="cd-brand__by">NexoDesk by NexoERP</div>
          </div>
        </div>
        <nav className="cd-nav" aria-label="Main">
          <button
            type="button"
            className="cd-nav__item"
            aria-current={view.screen !== 'settings' ? 'page' : undefined}
            onClick={() => setView({ screen: 'licenses' })}
          >
            <KeyIcon />
            Licences
          </button>
          <button
            type="button"
            className="cd-nav__item"
            aria-current={view.screen === 'settings' ? 'page' : undefined}
            onClick={() => setView({ screen: 'settings' })}
          >
            <SystemIcon />
            Settings
          </button>
        </nav>
        <div className="cd-sidebar__footer">
          <Button
            variant="ghost"
            onClick={() => {
              void lm('vault:lock').then(refresh);
            }}
          >
            Lock
          </Button>
        </div>
      </aside>
      <main className="cd-main">
        <header className="cd-topbar">
          <h1 className="cd-topbar__title">{title}</h1>
        </header>
        <div className="cd-content">
          {view.screen === 'licenses' ? <LicensesScreen onOpen={(id) => setView({ screen: 'license', id })} /> : null}
          {view.screen === 'license' ? <LicenseDetailScreen id={view.id} onBack={() => setView({ screen: 'licenses' })} /> : null}
          {view.screen === 'settings' ? <SettingsScreen /> : null}
        </div>
      </main>
    </div>
  );
}
