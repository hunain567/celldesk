import type { Role, UserSummary } from '@nexodesk/shared';
import { MIN_USER_PASSWORD, ROLE_LABELS, RoleSchema, USERNAME_PATTERN } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including users, restore and licence',
  manager: 'Purchases, suppliers, catalogue, stock with cost prices, backups',
  salesman: 'Stock lookup without cost prices (sales arrive with the POS module)',
  technician: 'Stock lookup (repair jobs arrive with the repairs module)',
};

function RoleSelect({ id, value, onChange }: { id: string; value: Role; onChange: (role: Role) => void }) {
  return (
    <select id={id} className="cd-select" value={value} onChange={(event) => onChange(event.target.value as Role)}>
      {RoleSchema.options.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

function AddUserDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const notify = useToast();
  const [form, setForm] = useState({ fullName: '', username: '', role: 'salesman' as Role, password: '', pin: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usernameValid = USERNAME_PATTERN.test(form.username);
  const pinValid = form.pin === '' || /^\d{4,6}$/.test(form.pin);
  const ready = form.fullName.trim() !== '' && usernameValid && form.password.length >= MIN_USER_PASSWORD && pinValid;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('users:create', {
        fullName: form.fullName,
        username: form.username,
        role: form.role,
        password: form.password,
        ...(form.pin ? { pin: form.pin } : {}),
      });
      notify({ tone: 'success', title: 'User added', message: `${form.fullName} chooses their own password at first sign-in.` });
      onAdded();
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Add user"
      description="Give the user this temporary password. They will be asked to change it when they first sign in."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>Add user</Button>
        </>
      }
    >
      <Field label="Full name">
        {(id) => <input id={id} className="cd-input" autoFocus value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} />}
      </Field>
      <Field label="Username" error={form.username && !usernameValid ? 'Use 3 to 32 small letters, numbers, dots, dashes or underscores.' : null}>
        {(id) => <input id={id} className="cd-input" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} />}
      </Field>
      <Field label="Role" hint={ROLE_HELP[form.role]}>
        {(id) => <RoleSelect id={id} value={form.role} onChange={(role) => setForm({ ...form, role })} />}
      </Field>
      <Field label="Temporary password" hint={`At least ${MIN_USER_PASSWORD} characters`}>
        {(id) => <input id={id} className="cd-input" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />}
      </Field>
      <Field label="Quick PIN (optional)" hint="4 to 6 digits for fast sign-in at the counter" error={!pinValid ? 'A PIN has 4 to 6 digits.' : null}>
        {(id) => <input id={id} className="cd-input" inputMode="numeric" maxLength={6} value={form.pin} onChange={(event) => setForm({ ...form, pin: event.target.value.replace(/\D/g, '') })} />}
      </Field>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, onSaved }: { user: UserSummary; onClose: () => void; onSaved: () => void }) {
  const notify = useToast();
  const [fullName, setFullName] = useState(user.fullName);
  const [role, setRole] = useState<Role>(user.role);
  const [isActive, setIsActive] = useState(user.isActive);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(name: string, action: () => Promise<unknown>, success: string) {
    setBusy(name);
    setError(null);
    try {
      await action();
      notify({ tone: 'success', title: success });
      onSaved();
      onClose();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      title={`Edit ${user.fullName}`}
      description={`Username: ${user.username}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            busy={busy === 'save'}
            disabled={!fullName.trim() || (fullName === user.fullName && role === user.role && isActive === user.isActive)}
            onClick={() => void run('save', () => call('users:update', { id: user.id, fullName, role, isActive }), 'User updated')}
          >
            Save changes
          </Button>
        </>
      }
    >
      <Field label="Full name">{(id) => <input id={id} className="cd-input" value={fullName} onChange={(event) => setFullName(event.target.value)} />}</Field>
      <Field label="Role" hint={ROLE_HELP[role]}>
        {(id) => <RoleSelect id={id} value={role} onChange={setRole} />}
      </Field>
      <label className="cd-checkbox">
        <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
        <span>Active. Inactive users cannot sign in; their past work stays in the records.</span>
      </label>

      <div className="cd-form-row">
        <div style={{ flex: 1 }}>
          <Field label="Reset password" hint="Also unlocks a locked account">
            {(id) => <input id={id} className="cd-input" placeholder="New temporary password" value={password} onChange={(event) => setPassword(event.target.value)} />}
          </Field>
        </div>
        <Button
          busy={busy === 'password'}
          disabled={password.length < MIN_USER_PASSWORD}
          onClick={() => void run('password', () => call('users:resetPassword', { id: user.id, newPassword: password }), 'Password reset')}
        >
          Reset
        </Button>
      </div>

      <div className="cd-form-row">
        <div style={{ flex: 1 }}>
          <Field label={user.hasPin ? 'Change PIN' : 'Set a PIN'}>
            {(id) => <input id={id} className="cd-input" inputMode="numeric" maxLength={6} placeholder="4 to 6 digits" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} />}
          </Field>
        </div>
        <Button busy={busy === 'pin'} disabled={!/^\d{4,6}$/.test(pin)} onClick={() => void run('pin', () => call('users:setPin', { id: user.id, pin }), 'PIN saved')}>
          Save PIN
        </Button>
        {user.hasPin ? (
          <Button variant="ghost" busy={busy === 'nopin'} onClick={() => void run('nopin', () => call('users:setPin', { id: user.id, pin: null }), 'PIN removed')}>
            Remove PIN
          </Button>
        ) : null}
      </div>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

export function UsersScreen() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await call('users:list'));
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger" title="Users could not be loaded">{error}</Banner>;
  if (!users) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  return (
    <div className="cd-page">
      <Panel
        title="Users"
        description="Everyone who works at the counter should have their own account, so every sale and change shows who made it."
        actions={<Button variant="primary" onClick={() => setAdding(true)}>Add user</Button>}
      >
        <div className="cd-table-wrap">
          <table className="cd-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Sign-in</th>
                <th>Last sign-in</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td style={{ fontWeight: 600 }}>
                    {user.fullName}
                    {user.id === me?.id ? <span className="cd-field__hint"> (you)</span> : null}
                  </td>
                  <td className="mono">{user.username}</td>
                  <td>{ROLE_LABELS[user.role]}</td>
                  <td>{user.hasPin ? 'Password and PIN' : 'Password'}</td>
                  <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</td>
                  <td>
                    {!user.isActive ? <Badge>Inactive</Badge> : user.lockedUntil ? <Badge tone="danger">Locked</Badge> : <Badge tone="success">Active</Badge>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Button variant="ghost" onClick={() => setEditing(user)}>Edit</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {adding ? <AddUserDialog onClose={() => setAdding(false)} onAdded={() => void load()} /> : null}
      {editing ? <EditUserDialog user={editing} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
    </div>
  );
}
