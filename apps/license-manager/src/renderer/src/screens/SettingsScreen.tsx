import { useCallback, useEffect, useState } from 'react';
import { FolderIcon } from '@ui/components/icons';
import { useToast } from '@ui/components/toast';
import { Banner, Button, Panel, Properties } from '@ui/components/ui';
import type { SettingsInfo } from '../../../shared/contract';
import { copyText, formatDayTime, lm, message } from '../api';

const BACKUP_REMINDER_DAYS = 7;

export function SettingsScreen() {
  const notify = useToast();
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [backingUp, setBackingUp] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await lm('lm:settings'));
    } catch (error) {
      notify({ tone: 'danger', title: 'Settings could not be loaded', message: message(error) });
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  async function backup() {
    setBackingUp(true);
    try {
      const { path } = await lm('lm:backup');
      if (path) {
        notify({ tone: 'success', title: 'License Manager backup saved', message: path });
        void load();
      }
    } catch (error) {
      notify({ tone: 'danger', title: 'Backup failed', message: message(error) });
    } finally {
      setBackingUp(false);
    }
  }

  if (!settings) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;
  const backupOld =
    !settings.lastBackupAt || Date.now() - Date.parse(settings.lastBackupAt) > BACKUP_REMINDER_DAYS * 24 * 60 * 60 * 1000;

  return (
    <div className="cd-page">
      {backupOld ? (
        <Banner tone="danger" title={settings.lastBackupAt ? 'The last License Manager backup is more than a week old' : 'The License Manager has never been backed up'}>
          If this laptop is lost or damaged without a backup, no shop can be renewed. Keep backups on a USB drive kept away from the laptop.
        </Banner>
      ) : null}

      <Panel
        title="Back up License Manager"
        description="Saves the encrypted database (licences, customers and the signing key) and the file needed to open it. The master password is still required."
        actions={<Button variant="primary" icon={<FolderIcon />} busy={backingUp} onClick={() => void backup()}>Back up now</Button>}
      >
        <Properties
          items={[
            { label: 'Last backup', value: settings.lastBackupAt ? formatDayTime(settings.lastBackupAt) : 'Never' },
            { label: 'Data folder', value: <span className="mono selectable">{settings.dataDirectory}</span> },
          ]}
        />
      </Panel>

      <Panel
        title="Licence verification key"
        description="NexoDesk checks every licence with this public key. Paste it into apps/desktop/src/main/licensing/vendor-key.ts before building a NexoDesk installer. It is safe to share; the private key never leaves this app."
        actions={
          <Button
            onClick={() => {
              void copyText(settings.publicKeyPem).then(
                () => notify({ tone: 'success', title: 'Public key copied' }),
                () => notify({ tone: 'danger', title: 'Could not copy' }),
              );
            }}
          >
            Copy public key
          </Button>
        }
      >
        <pre className="cd-path cd-path--set selectable" style={{ whiteSpace: 'pre-wrap', padding: 'var(--space-3)', margin: 'var(--space-3) 0' }}>
          {settings.publicKeyPem}
        </pre>
      </Panel>

      <Panel
        title="Revoked licences"
        description="Add these ids to packages/licensing/src/revoked.ts in the next NexoDesk release so they stop working after the shop updates."
      >
        {settings.revokedLicenseIds.length === 0 ? (
          <div className="cd-empty">No revoked licences.</div>
        ) : (
          <pre className="cd-path cd-path--set selectable" style={{ whiteSpace: 'pre-wrap', padding: 'var(--space-3)', margin: 'var(--space-3) 0' }}>
            {settings.revokedLicenseIds.map((id) => `'${id}',`).join('\n')}
          </pre>
        )}
      </Panel>
    </div>
  );
}
