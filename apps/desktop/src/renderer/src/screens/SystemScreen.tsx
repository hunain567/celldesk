import type { AuditVerifyResult, IntegrityResult, SystemInfo, Theme } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { ListCheckIcon, ShieldCheckIcon } from '../components/icons';
import { useToast } from '../components/toast';
import { Badge, Button, Panel, Properties, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { useTheme } from '../lib/theme';

/**
 * System status: database health, version information and appearance.
 * Every value on this screen comes from the main process.
 */
export function SystemScreen() {
  const notify = useToast();
  const { theme, setTheme } = useTheme();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityResult | null>(null);
  const [audit, setAudit] = useState<AuditVerifyResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await call('system:info'));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  async function runIntegrityCheck() {
    setChecking(true);
    try {
      const result = await call('system:integrityCheck');
      setIntegrity(result);
      notify(
        result.ok
          ? { tone: 'success', title: 'Database is healthy', message: 'No problems were found.' }
          : { tone: 'danger', title: 'Database problems found', message: `${result.messages.length} problem(s) need attention.` },
      );
      void loadInfo();
    } catch (error) {
      notify({ tone: 'danger', title: 'Integrity check failed', message: errorMessage(error) });
    } finally {
      setChecking(false);
    }
  }

  async function verifyAudit() {
    setVerifying(true);
    try {
      const result = await call('audit:verify');
      setAudit(result);
      notify(
        result.valid
          ? { tone: 'success', title: 'Activity log is intact', message: `${result.entriesChecked} entries verified.` }
          : { tone: 'danger', title: 'Activity log was altered', message: `First changed entry: #${result.firstBrokenId}.` },
      );
    } catch (error) {
      notify({ tone: 'danger', title: 'Verification failed', message: errorMessage(error) });
    } finally {
      setVerifying(false);
    }
  }

  async function changeTheme(next: Theme) {
    try {
      await setTheme(next);
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not save the theme', message: errorMessage(error) });
    }
  }

  if (loadError) {
    return (
      <div className="cd-page">
        <Panel title="System information unavailable" description={loadError}>
          <Button variant="primary" onClick={() => void loadInfo()}>
            Try again
          </Button>
        </Panel>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="cd-center">
        <span className="cd-spinner" aria-label="Loading" />
      </div>
    );
  }

  const schemaCurrent = info.schemaVersion === info.latestSchemaVersion;

  return (
    <div className="cd-page">
      <div className="cd-stats">
        <div className="cd-stat">
          <div className="cd-stat__label">Database</div>
          <div className="cd-stat__value">
            {integrity === null ? (
              <Badge>Not checked</Badge>
            ) : integrity.ok ? (
              <Badge tone="success">Healthy</Badge>
            ) : (
              <Badge tone="danger">Problems found</Badge>
            )}
          </div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Encryption</div>
          <div className="cd-stat__value">
            {info.databaseEncrypted ? <Badge tone="success">Encrypted</Badge> : <Badge tone="danger">Off</Badge>}
          </div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Database size</div>
          <div className="cd-stat__value num">{formatBytes(info.databaseSizeBytes)}</div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Schema</div>
          <div className="cd-stat__value num">
            v{info.schemaVersion}{' '}
            {schemaCurrent ? <Badge tone="success">Up to date</Badge> : <Badge tone="warning">Update pending</Badge>}
          </div>
        </div>
      </div>

      <Panel
        title="Data protection"
        description="Check the database for damage and confirm no one has altered the activity log."
        actions={
          <>
            <Button icon={<ListCheckIcon />} busy={verifying} onClick={() => void verifyAudit()}>
              Verify activity log
            </Button>
            <Button variant="primary" icon={<ShieldCheckIcon />} busy={checking} onClick={() => void runIntegrityCheck()}>
              Run integrity check
            </Button>
          </>
        }
      >
        <Properties
          items={[
            {
              label: 'Last integrity check',
              value: integrity ? formatDateTime(integrity.checkedAt) : 'Not run in this session',
            },
            {
              label: 'Activity log',
              value: audit
                ? audit.valid
                  ? `Intact, ${audit.entriesChecked} entries verified`
                  : `Altered at entry #${audit.firstBrokenId}`
                : 'Not verified in this session',
            },
            { label: 'Data folder', value: <span className="mono selectable">{info.dataDirectory}</span> },
          ]}
        />
        {integrity && !integrity.ok ? (
          <ul className="cd-messages">
            {integrity.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel title="About this installation">
        <Properties
          items={[
            { label: 'Version', value: <span className="num">{info.appVersion}</span> },
            { label: 'Installation ID', value: <span className="mono selectable">{info.installId}</span> },
            { label: 'Running since', value: formatDateTime(info.startedAt) },
            { label: 'Platform', value: `${info.platform}, Electron ${info.electronVersion}` },
          ]}
        />
      </Panel>

      <Panel title="Appearance" description="Follow Windows, or always use light or dark.">
        <Segmented<Theme>
          label="Theme"
          value={theme}
          onChange={(next) => void changeTheme(next)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Panel>
    </div>
  );
}
