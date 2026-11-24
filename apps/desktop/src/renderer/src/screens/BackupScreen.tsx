import type { BackupHistoryEntry, BackupRunResult, BackupSchedule, BackupStatus } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { BackupIcon, FolderIcon, TrashIcon } from '../components/icons';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { backupKindLabel, formatBytes, formatDateTime, formatRelative, formatUpcoming } from '../lib/format';

const MIN_PASSWORD = 8;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function resultToast(result: BackupRunResult) {
  if (result.status === 'success') {
    const size = result.results[0]?.sizeBytes;
    return {
      tone: 'success' as const,
      title: 'Backup completed and verified',
      message: `${result.results.length} location${result.results.length === 1 ? '' : 's'}${size ? `, ${formatBytes(size)}` : ''}.`,
    };
  }
  const failed = result.results.filter((entry) => !entry.ok);
  return {
    tone: 'danger' as const,
    title: result.status === 'partial' ? 'Backup saved to some locations only' : 'Backup failed',
    message: result.error ?? failed.map((entry) => `${entry.destination}: ${entry.error}`).join(' '),
  };
}

/** First-time setup: where to save backups and the recovery password. */
export function BackupSetupPanel({ onDone }: { onDone: () => void }) {
  const notify = useToast();
  const [folder, setFolder] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);

  const passwordError = password.length > 0 && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null;
  const confirmError = confirm.length > 0 && confirm !== password ? 'The passwords do not match.' : null;
  const ready = folder !== null && password.length >= MIN_PASSWORD && confirm === password && acknowledged;

  async function browse() {
    try {
      const { path } = await call('backup:chooseFolder');
      if (path) setFolder(path);
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not open the folder picker', message: errorMessage(error) });
    }
  }

  async function save() {
    if (!folder) return;
    setSaving(true);
    try {
      await call('backup:setup', { destinationPath: folder, recoveryPassword: password });
      setPassword('');
      setConfirm('');
      const result = await call('backup:runNow');
      notify(resultToast(result));
      onDone();
    } catch (error) {
      notify({ tone: 'danger', title: 'Backup setup failed', message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="Set up backups"
      description="NexoDesk keeps your shop data safe by saving encrypted copies to a drive you choose."
    >
      <div className="cd-steps" style={{ padding: 'var(--space-3) 0' }}>
        <div className="cd-step">
          <span className="cd-step__number">1</span>
          <div className="cd-step__body">
            <div className="cd-step__title">Choose where to save backups</div>
            <div className="cd-field__hint">
              Use a USB drive, an external disk or another drive such as D:. Avoid the C: drive: if Windows fails, it
              can be lost together with the data.
            </div>
            <div className="cd-form-row">
              <div className={`cd-path ${folder ? 'cd-path--set' : ''}`} style={{ flex: 1 }}>
                {folder ?? 'No folder chosen'}
              </div>
              <Button icon={<FolderIcon />} onClick={() => void browse()}>
                Browse
              </Button>
            </div>
          </div>
        </div>

        <div className="cd-step">
          <span className="cd-step__number">2</span>
          <div className="cd-step__body">
            <div className="cd-step__title">Set a recovery password</div>
            <div className="cd-field__hint">
              This password is needed to restore a backup on another computer, for example after this PC is
              replaced. Write it down and keep it somewhere safe outside the shop.
            </div>
            <div className="cd-form-grid">
              <Field label="Recovery password" error={passwordError} hint={`At least ${MIN_PASSWORD} characters`}>
                {(id) => (
                  <input
                    id={id}
                    className="cd-input"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    aria-invalid={passwordError ? true : undefined}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
              </Field>
              <Field label="Confirm recovery password" error={confirmError}>
                {(id) => (
                  <input
                    id={id}
                    className="cd-input"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    aria-invalid={confirmError ? true : undefined}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <label className="cd-checkbox">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>
                I have written down the recovery password. I understand that without it, backups cannot be restored on
                another computer.
              </span>
            </label>
          </div>
        </div>

        <div className="cd-step">
          <span className="cd-step__number">3</span>
          <div className="cd-step__body">
            <div className="cd-step__title">Save and make the first backup</div>
            <div>
              <Button variant="primary" icon={<BackupIcon />} busy={saving} disabled={!ready} onClick={() => void save()}>
                Save and back up now
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function SchedulePanel({ saved, onSaved }: { saved: BackupSchedule; onSaved: () => void }) {
  const notify = useToast();
  const [schedule, setSchedule] = useState<BackupSchedule>(saved);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(schedule) !== JSON.stringify(saved);

  useEffect(() => setSchedule(saved), [saved]);

  async function save() {
    setSaving(true);
    try {
      await call('backup:setSchedule', schedule);
      notify({ tone: 'success', title: 'Backup schedule saved' });
      onSaved();
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not save the schedule', message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="Automatic backups"
      description="Runs while NexoDesk is open. A backup missed because the PC was off runs a few minutes after the next start."
      actions={
        <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>
          Save schedule
        </Button>
      }
    >
      <div className="cd-form-row" style={{ padding: 'var(--space-3) 0' }}>
        <div className="cd-field">
          <span className="cd-field__label">Frequency</span>
          <Segmented<BackupSchedule['frequency']>
            label="Frequency"
            value={schedule.frequency}
            onChange={(frequency) => setSchedule({ ...schedule, frequency })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
        </div>
        {schedule.frequency === 'weekly' ? (
          <Field label="Day">
            {(id) => (
              <select
                id={id}
                className="cd-select"
                value={schedule.weekday}
                onChange={(event) => setSchedule({ ...schedule, weekday: Number(event.target.value) })}
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {schedule.frequency === 'monthly' ? (
          <Field label="Day of month">
            {(id) => (
              <select
                id={id}
                className="cd-select"
                value={schedule.dayOfMonth}
                onChange={(event) => setSchedule({ ...schedule, dayOfMonth: Number(event.target.value) })}
              >
                {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {schedule.frequency !== 'off' ? (
          <Field label="Time">
            {(id) => (
              <input
                id={id}
                className="cd-input"
                type="time"
                value={schedule.time}
                onChange={(event) => setSchedule({ ...schedule, time: event.target.value || schedule.time })}
              />
            )}
          </Field>
        ) : null}
      </div>
      {schedule.frequency === 'off' ? (
        <Banner tone="warning" title="Automatic backups are off">
          Backups will only be made when you press Back up now.
        </Banner>
      ) : null}
    </Panel>
  );
}

function LocationsPanel({ status, onChanged }: { status: BackupStatus; onChanged: () => void }) {
  const notify = useToast();
  const canManage = useAuth().can('backup.manage');
  const [busy, setBusy] = useState(false);

  async function add() {
    try {
      const { path } = await call('backup:chooseFolder');
      if (!path) return;
      setBusy(true);
      await call('backup:addDestination', { path });
      notify({ tone: 'success', title: 'Backup location added', message: path });
      onChanged();
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not add the location', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number, path: string) {
    try {
      await call('backup:removeDestination', { id });
      notify({ tone: 'success', title: 'Backup location removed', message: `Existing backups in ${path} were not deleted.` });
      onChanged();
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not remove the location', message: errorMessage(error) });
    }
  }

  return (
    <Panel
      title="Backup locations"
      description="Every backup is saved and verified separately in each location. Use two locations for extra safety."
      actions={
        canManage ? (
          <Button icon={<FolderIcon />} busy={busy} disabled={status.destinations.length >= 3} onClick={() => void add()}>
            Add location
          </Button>
        ) : undefined
      }
    >
      <div className="cd-table-wrap">
        <table className="cd-table">
          <thead>
            <tr>
              <th>Folder</th>
              <th>Status</th>
              <th className="num">Free space</th>
              <th>Last verified backup</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {status.destinations.map((destination) => (
              <tr key={destination.id}>
                <td>
                  <div className="cd-table__path selectable" title={destination.path}>
                    {destination.path}
                  </div>
                  {destination.lastError ? <span className="cd-table__sub">{destination.lastError}</span> : null}
                </td>
                <td>{destination.reachable ? <Badge tone="success">Ready</Badge> : <Badge tone="danger">Not available</Badge>}</td>
                <td className="num">{destination.freeBytes !== null ? formatBytes(destination.freeBytes) : '—'}</td>
                <td>{destination.lastVerifiedAt ? formatRelative(destination.lastVerifiedAt) : 'Never'}</td>
                <td style={{ textAlign: 'right' }}>
                  {canManage ? (
                  <Button
                    variant="ghost"
                    icon={<TrashIcon />}
                    disabled={status.destinations.length <= 1}
                    title={status.destinations.length <= 1 ? 'At least one location is required' : 'Remove this location'}
                    onClick={() => void remove(destination.id, destination.path)}
                  >
                    Remove
                  </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function HistoryPanel({ history }: { history: BackupHistoryEntry[] }) {
  return (
    <Panel title="Backup history" description="Old backups are removed automatically: 14 daily, 8 weekly and 12 monthly are kept.">
      {history.length === 0 ? (
        <div className="cd-empty">No backups yet.</div>
      ) : (
        <div className="cd-table-wrap">
          <table className="cd-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Location</th>
                <th className="num">Size</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td className="num" style={{ textAlign: 'left' }}>
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td>{backupKindLabel(entry.kind)}</td>
                  <td>
                    <div className="cd-table__path" title={entry.filePath ?? entry.destination}>
                      {entry.destination}
                    </div>
                    {entry.error ? <span className="cd-table__sub">{entry.error}</span> : null}
                  </td>
                  <td className="num">{entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '—'}</td>
                  <td>
                    {entry.status === 'verified' ? (
                      <Badge tone="success">Verified</Badge>
                    ) : entry.status === 'failed' ? (
                      <Badge tone="danger">Failed</Badge>
                    ) : (
                      <Badge>Removed by retention</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function BackupScreen() {
  const notify = useToast();
  const canManage = useAuth().can('backup.manage');
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [history, setHistory] = useState<BackupHistoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextHistory] = await Promise.all([call('backup:status'), call('backup:history', { limit: 50 })]);
      setStatus(nextStatus);
      setHistory(nextHistory);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = window.nexodesk.onEvent((event) => {
      if (event.type === 'backup.finished') void load();
    });
    return unsubscribe;
  }, [load]);

  async function runNow() {
    setRunning(true);
    try {
      notify(resultToast(await call('backup:runNow')));
    } catch (error) {
      notify({ tone: 'danger', title: 'Backup failed', message: errorMessage(error) });
    } finally {
      setRunning(false);
      void load();
    }
  }

  if (loadError) {
    return (
      <div className="cd-page">
        <Banner tone="danger" title="Backup information could not be loaded" actions={<Button onClick={() => void load()}>Try again</Button>}>
          {loadError}
        </Banner>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="cd-center">
        <span className="cd-spinner" aria-label="Loading" />
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="cd-page">
        <Banner tone="warning" title="Backups are not set up">
          Until backups are set up, a disk failure or a stolen PC means the shop's data is lost.
          {canManage ? '' : ' Ask the shop owner to set them up.'}
        </Banner>
        {canManage ? <BackupSetupPanel onDone={() => void load()} /> : null}
      </div>
    );
  }

  const reachable = status.destinations.filter((destination) => destination.reachable).length;
  const busy = running || status.running;

  return (
    <div className="cd-page">
      {status.overdue ? (
        <Banner
          tone="danger"
          title={status.lastVerifiedAt ? 'The last verified backup is more than 2 days old' : 'There is no verified backup yet'}
          actions={
            <Button variant="primary" icon={<BackupIcon />} busy={busy} onClick={() => void runNow()}>
              Back up now
            </Button>
          }
        >
          Check that the backup drive is connected, then back up now.
        </Banner>
      ) : null}

      <div className="cd-stats">
        <div className="cd-stat">
          <div className="cd-stat__label">Last verified backup</div>
          <div className="cd-stat__value">{status.lastVerifiedAt ? formatRelative(status.lastVerifiedAt) : 'None'}</div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Next automatic backup</div>
          <div className="cd-stat__value">{status.nextScheduledAt ? formatUpcoming(status.nextScheduledAt) : 'Off'}</div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Locations ready</div>
          <div className="cd-stat__value num">
            {reachable} of {status.destinations.length}
          </div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Last attempt</div>
          <div className="cd-stat__value">
            {status.lastRun === null ? (
              <Badge>None</Badge>
            ) : status.lastRun.status === 'success' ? (
              <Badge tone="success">Succeeded</Badge>
            ) : status.lastRun.status === 'partial' ? (
              <Badge tone="warning">Partly failed</Badge>
            ) : status.lastRun.status === 'running' ? (
              <Badge>Running</Badge>
            ) : (
              <Badge tone="danger">Failed</Badge>
            )}
          </div>
        </div>
      </div>

      <Panel
        title="Back up now"
        description="Makes an encrypted copy of all shop data, then reads it back from each location to prove it can be restored."
        actions={
          <Button variant="primary" icon={<BackupIcon />} busy={busy} onClick={() => void runNow()}>
            {busy ? 'Backing up…' : 'Back up now'}
          </Button>
        }
      >
        {status.lastRun?.error ? (
          <div style={{ padding: 'var(--space-3) 0' }}>
            <Banner tone="danger" title={`Last ${backupKindLabel(status.lastRun.kind).toLowerCase()} backup problem`}>
              {status.lastRun.error}
            </Banner>
          </div>
        ) : (
          <div className="cd-field__hint" style={{ padding: 'var(--space-2) 0' }}>
            Backups are encrypted with AES-256. Opening them on another computer needs the recovery password.
          </div>
        )}
      </Panel>

      <LocationsPanel status={status} onChanged={() => void load()} />
      {canManage ? <SchedulePanel saved={status.schedule} onSaved={() => void load()} /> : null}
      <HistoryPanel history={history} />
    </div>
  );
}
