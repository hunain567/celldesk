import type { BackupInspection, BackupVerification, RestoreOutcome } from '@nexodesk/shared';
import { useEffect, useState } from 'react';
import { FileIcon, RestoreIcon } from '../components/icons';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel, Properties } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { backupKindLabel, formatBytes, formatDateTime } from '../lib/format';

const CONFIRM_WORD = 'RESTORE';

function OutcomeBanner({ outcome }: { outcome: RestoreOutcome }) {
  if (!outcome) return null;
  if (outcome.kind === 'completed') {
    return (
      <Banner tone="success" title="Data restored">
        Your data was restored from the backup made on {formatDateTime(outcome.backupCreatedAt)}. A copy of the data
        it replaced was kept.
      </Banner>
    );
  }
  return (
    <Banner tone="danger" title="The restore did not complete. Your previous data was kept.">
      {outcome.reason}
    </Banner>
  );
}

/**
 * Restore Center: choose a backup, see what it is, verify it, then restore.
 * The live data is replaced only after a verified safety copy has been made.
 */
export function RestoreScreen() {
  const notify = useToast();
  const [outcome, setOutcome] = useState<RestoreOutcome>(null);
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [password, setPassword] = useState('');
  const [verification, setVerification] = useState<BackupVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState<'choose' | 'verify' | 'restore' | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    void call('restore:lastOutcome')
      .then(setOutcome)
      .catch(() => setOutcome(null));
  }, []);

  function reset() {
    setInspection(null);
    setPassword('');
    setVerification(null);
    setVerifyError(null);
    setConfirmation('');
  }

  async function choose() {
    setBusy('choose');
    try {
      const { path } = await call('restore:chooseFile');
      if (!path) return;
      reset();
      setInspection(await call('restore:inspect', { path }));
    } catch (error) {
      notify({ tone: 'danger', title: 'This file cannot be used', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!inspection) return;
    setBusy('verify');
    setVerifyError(null);
    try {
      setVerification(
        await call('restore:verify', {
          path: inspection.filePath,
          ...(inspection.needsPassword ? { recoveryPassword: password } : {}),
        }),
      );
    } catch (error) {
      setVerification(null);
      setVerifyError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    if (!inspection || !verification) return;
    setBusy('restore');
    try {
      await call('restore:start', {
        path: inspection.filePath,
        confirmation: 'RESTORE',
        ...(inspection.needsPassword ? { recoveryPassword: password } : {}),
      });
      setRestarting(true);
    } catch (error) {
      notify({ tone: 'danger', title: 'Restore was not started', message: errorMessage(error) });
      setBusy(null);
    }
  }

  if (restarting) {
    return (
      <div className="cd-overlay">
        <div className="cd-overlay__card">
          <span className="cd-spinner" aria-hidden="true" />
          <h2 className="cd-panel__title">Restoring your data</h2>
          <p className="cd-panel__description">NexoDesk will restart in a moment. Do not switch off the PC.</p>
        </div>
      </div>
    );
  }

  const records = verification ? Object.values(verification.tableCounts).reduce((sum, count) => sum + count, 0) : 0;
  const canVerify = inspection?.compatible && (!inspection.needsPassword || password.length > 0);
  const canRestore = verification !== null && confirmation === CONFIRM_WORD;

  return (
    <div className="cd-page">
      <OutcomeBanner outcome={outcome} />

      <Panel
        title="1. Choose a backup"
        description="Pick a .ndbak file from a backup drive, USB or another computer."
        actions={
          <Button variant={inspection ? 'secondary' : 'primary'} icon={<FileIcon />} busy={busy === 'choose'} onClick={() => void choose()}>
            {inspection ? 'Choose another file' : 'Choose backup file'}
          </Button>
        }
      >
        {inspection ? (
          <>
            <Properties
              items={[
                { label: 'File', value: <span className="mono selectable">{inspection.filePath}</span> },
                { label: 'Made on', value: formatDateTime(inspection.createdAt) },
                { label: 'Type', value: backupKindLabel(inspection.kind) },
                { label: 'Size', value: formatBytes(inspection.fileSizeBytes) },
                { label: 'Made by', value: `NexoDesk ${inspection.appVersion}` },
                {
                  label: 'Source',
                  value: inspection.sameInstallation ? (
                    <Badge tone="success">This installation</Badge>
                  ) : (
                    <Badge tone="warning">Another computer or installation</Badge>
                  ),
                },
              ]}
            />
            {!inspection.compatible ? (
              <div style={{ paddingTop: 'var(--space-3)' }}>
                <Banner tone="danger" title="This backup cannot be restored by this version">
                  {inspection.compatibilityMessage}
                </Banner>
              </div>
            ) : null}
          </>
        ) : (
          <div className="cd-empty">No backup chosen.</div>
        )}
      </Panel>

      {inspection?.compatible ? (
        <Panel
          title="2. Verify the backup"
          description="Decrypts the whole backup and checks every byte before anything is changed."
          actions={
            <Button variant={verification ? 'secondary' : 'primary'} busy={busy === 'verify'} disabled={!canVerify} onClick={() => void verify()}>
              Verify backup
            </Button>
          }
        >
          <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3) 0' }}>
            {inspection.needsPassword ? (
              <div style={{ maxWidth: 360 }}>
                <Field label="Recovery password" hint="The password set when backups were first set up on the PC that made this backup.">
                  {(id) => (
                    <input
                      id={id}
                      className="cd-input"
                      type="password"
                      autoComplete="off"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setVerification(null);
                      }}
                    />
                  )}
                </Field>
              </div>
            ) : null}
            {verification ? (
              <Banner tone="success" title="Backup verified">
                The backup is complete and undamaged: {records.toLocaleString('en-PK')} records,{' '}
                {formatBytes(verification.databaseSizeBytes)} of data.
              </Banner>
            ) : null}
            {verifyError ? (
              <Banner tone="danger" title="Verification failed">
                {verifyError}
              </Banner>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {verification ? (
        <Panel title="3. Restore" description="Replaces all current shop data with the data in this backup.">
          <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
            <ul className="cd-list">
              <li>A verified safety copy of the current data is made first, and a backup is saved to your backup locations if they are connected.</li>
              <li>All sales, stock and other records made after {formatDateTime(inspection!.createdAt)} will no longer appear.</li>
              <li>NexoDesk restarts. If the restored data cannot be opened, your current data is put back automatically.</li>
            </ul>
            <div className="cd-form-row">
              <div style={{ width: 260 }}>
                <Field label={`Type ${CONFIRM_WORD} to confirm`}>
                  {(id) => (
                    <input
                      id={id}
                      className="cd-input cd-input--mono"
                      autoComplete="off"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
                    />
                  )}
                </Field>
              </div>
              <Button variant="danger" icon={<RestoreIcon />} busy={busy === 'restore'} disabled={!canRestore} onClick={() => void restore()}>
                Restore this backup
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
