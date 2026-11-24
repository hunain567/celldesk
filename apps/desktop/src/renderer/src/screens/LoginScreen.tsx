import type { PinUser } from '@nexodesk/shared';
import { ROLE_LABELS } from '@nexodesk/shared';
import { useEffect, useState } from 'react';
import { DeviceIcon } from '../components/icons';
import { Banner, Button, Field, Panel, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Sign-in with username and password, or a quick PIN at the counter. */
export function LoginScreen() {
  const { setup, signedIn } = useAuth();
  const [mode, setMode] = useState<'password' | 'pin'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pinUsers, setPinUsers] = useState<PinUser[]>([]);
  const [pinUser, setPinUser] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call('auth:pinUsers').then((list) => {
      setPinUsers(list);
      if (list.length > 0) setMode('pin');
    });
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === 'password'
          ? await call('auth:loginPassword', { username, password })
          : await call('auth:loginPin', { userId: pinUser!, pin });
      setPassword('');
      setPin('');
      signedIn(user);
    } catch (loginError) {
      setError(errorMessage(loginError));
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === 'password' ? username.trim().length > 0 && password.length > 0 : pinUser !== null && pin.length >= 4;

  return (
    <div className="cd-auth">
      <form
        className="cd-auth__card"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void submit();
        }}
      >
        <div className="cd-auth__brand">
          <span className="cd-brand__mark">
            <DeviceIcon />
          </span>
          <div>
            <div className="cd-auth__title">{setup?.shopName ?? 'NexoDesk'}</div>
            <div className="cd-brand__by">NexoDesk by NexoERP</div>
          </div>
        </div>

        <Panel
          title="Sign in"
          actions={
            pinUsers.length > 0 ? (
              <Segmented
                label="Sign-in method"
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  setError(null);
                }}
                options={[
                  { value: 'pin', label: 'PIN' },
                  { value: 'password', label: 'Password' },
                ]}
              />
            ) : undefined
          }
        >
          <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
            {mode === 'password' ? (
              <>
                <Field label="Username">
                  {(id) => (
                    <input id={id} className="cd-input" autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
                  )}
                </Field>
                <Field label="Password">
                  {(id) => (
                    <input id={id} className="cd-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
                  )}
                </Field>
              </>
            ) : (
              <>
                <div className="cd-pin-users" role="group" aria-label="Who is signing in">
                  {pinUsers.map((user) => (
                    <button key={user.id} type="button" className="cd-pin-user" aria-pressed={pinUser === user.id} onClick={() => setPinUser(user.id)}>
                      <div style={{ fontWeight: 600 }}>{user.fullName}</div>
                      <div className="cd-field__hint">{ROLE_LABELS[user.role]}</div>
                    </button>
                  ))}
                </div>
                {pinUser ? (
                  <Field label="PIN">
                    {(id) => (
                      <input
                        id={id}
                        className="cd-input cd-pin-input"
                        type="password"
                        inputMode="numeric"
                        autoFocus
                        maxLength={6}
                        value={pin}
                        onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                      />
                    )}
                  </Field>
                ) : null}
              </>
            )}
            {error ? <Banner tone="danger" title={error} /> : null}
            <div>
              <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
                Sign in
              </Button>
            </div>
          </div>
        </Panel>
        <div className="cd-field__hint">Forgot your password? Ask the shop owner to reset it from Users.</div>
      </form>
    </div>
  );
}
