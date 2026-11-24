import { MIN_USER_PASSWORD } from '@nexodesk/shared';
import { useState } from 'react';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Dialog } from './dialog';
import { useToast } from './toast';
import { Banner, Button, Field } from './ui';

/** Change own password. When `required`, the dialog cannot be dismissed (first sign-in after a reset). */
export function ChangePasswordDialog({ required, onClose }: { required: boolean; onClose: () => void }) {
  const { signedIn, lock } = useAuth();
  const notify = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = current.length > 0 && next.length >= MIN_USER_PASSWORD && next === confirm;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      signedIn(await call('auth:changePassword', { currentPassword: current, newPassword: next }));
      notify({ tone: 'success', title: 'Password changed' });
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={required ? 'Choose your own password' : 'Change password'}
      description={required ? 'Your password was set by the owner. Choose a new one that only you know.' : undefined}
      onClose={required ? undefined : onClose}
      footer={
        <>
          {required ? (
            <Button variant="ghost" onClick={() => void lock()}>
              Sign out
            </Button>
          ) : (
            <Button onClick={onClose}>Cancel</Button>
          )}
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>
            Save password
          </Button>
        </>
      }
    >
      <Field label="Current password">
        {(id) => <input id={id} className="cd-input" type="password" autoFocus value={current} onChange={(event) => setCurrent(event.target.value)} />}
      </Field>
      <Field label="New password" hint={`At least ${MIN_USER_PASSWORD} characters`}>
        {(id) => <input id={id} className="cd-input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />}
      </Field>
      <Field label="Confirm new password" error={confirm && confirm !== next ? 'The passwords do not match.' : null}>
        {(id) => <input id={id} className="cd-input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />}
      </Field>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}
