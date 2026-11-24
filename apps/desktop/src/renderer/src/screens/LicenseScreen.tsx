import type { LicenseStatus } from '@nexodesk/shared';
import { useState } from 'react';
import { FileIcon, KeyIcon } from '../components/icons';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel, Properties, type Tone } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';

export const LICENSE_STATE_LABELS: Record<LicenseStatus['state'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  expiring: { label: 'Expiring soon', tone: 'warning' },
  grace: { label: 'Grace period', tone: 'warning' },
  expired: { label: 'Expired — read-only', tone: 'danger' },
  revoked: { label: 'Cancelled', tone: 'danger' },
  'clock-problem': { label: 'Date and time problem', tone: 'danger' },
  invalid: { label: 'Not valid', tone: 'danger' },
  unlicensed: { label: 'Not activated', tone: 'neutral' },
};

const dateOnly = new Intl.DateTimeFormat('en-PK', { day: 'numeric', month: 'long', year: 'numeric' });

export function LicenseScreen({ status, onChanged }: { status: LicenseStatus | null; onChanged: () => void }) {
  const notify = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'save' | 'copy' | 'file' | 'code' | null>(null);

  async function saveRequest() {
    setBusy('save');
    try {
      const { path } = await call('license:saveRequestFile');
      if (path) notify({ tone: 'success', title: 'Activation request saved', message: path });
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not save the request', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function copyRequest() {
    setBusy('copy');
    try {
      const { code: requestCode } = await call('license:requestCode');
      await navigator.clipboard.writeText(requestCode);
      notify({ tone: 'success', title: 'Activation request copied', message: 'Paste it into a WhatsApp message to NexoERP.' });
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not copy the request', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  function activated(next: LicenseStatus) {
    notify({
      tone: 'success',
      title: 'Licence installed',
      message: next.validUntil ? `Valid until ${dateOnly.format(new Date(next.validUntil))}.` : undefined,
    });
    setCode('');
    onChanged();
  }

  async function importFile() {
    setBusy('file');
    try {
      const next = await call('license:importFile');
      if (next) activated(next);
    } catch (error) {
      notify({ tone: 'danger', title: 'Licence not installed', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function importCode() {
    setBusy('code');
    try {
      activated(await call('license:importCode', { code: code.trim() }));
    } catch (error) {
      notify({ tone: 'danger', title: 'Licence not installed', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <div className="cd-center">
        <span className="cd-spinner" aria-label="Loading" />
      </div>
    );
  }

  const state = LICENSE_STATE_LABELS[status.state];
  const hasLicense = status.licenseId !== null;

  return (
    <div className="cd-page">
      {status.reason ? (
        <Banner tone={state.tone === 'neutral' ? 'info' : state.tone === 'success' ? 'info' : state.tone} title={state.label}>
          {status.reason}
        </Banner>
      ) : null}

      <div className="cd-stats">
        <div className="cd-stat">
          <div className="cd-stat__label">Status</div>
          <div className="cd-stat__value">
            <Badge tone={state.tone}>{state.label}</Badge>
          </div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Plan</div>
          <div className="cd-stat__value">{status.planLabel ?? '—'}</div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Valid until</div>
          <div className="cd-stat__value">{status.validUntil ? dateOnly.format(new Date(status.validUntil)) : '—'}</div>
        </div>
        <div className="cd-stat">
          <div className="cd-stat__label">Days left</div>
          <div className="cd-stat__value num">{status.daysLeft ?? '—'}</div>
        </div>
      </div>

      {hasLicense ? (
        <Panel title="Licence details">
          <Properties
            items={[
              { label: 'Shop', value: status.shopName },
              { label: 'Owner', value: status.ownerName || '—' },
              { label: 'Licence ID', value: <span className="mono selectable">{status.licenseId}</span> },
              { label: 'Valid from', value: status.validFrom ? dateOnly.format(new Date(status.validFrom)) : '—' },
              {
                label: 'Grace period ends',
                value: status.graceEndsAt ? formatDateTime(status.graceEndsAt) : '—',
              },
              { label: 'Issued', value: status.issuedAt ? formatDateTime(status.issuedAt) : '—' },
              { label: 'Computer ID', value: <span className="mono selectable">{status.deviceIdShort}</span> },
            ]}
          />
        </Panel>
      ) : null}

      <Panel
        title={hasLicense ? 'Renew the licence' : 'Activate NexoDesk'}
        description="Activation and renewal work without internet. Send the request to NexoERP and install the licence file you receive."
      >
        <div className="cd-steps" style={{ padding: 'var(--space-3) 0' }}>
          <div className="cd-step">
            <span className="cd-step__number">1</span>
            <div className="cd-step__body">
              <div className="cd-step__title">Send this computer's activation request</div>
              <div className="cd-field__hint">
                Save it to a USB drive, or copy it and send it on WhatsApp. It identifies this computer only; it
                contains no shop data. Computer ID: <span className="mono">{status.deviceIdShort}</span>
              </div>
              <div className="cd-actions">
                <Button icon={<FileIcon />} busy={busy === 'save'} onClick={() => void saveRequest()}>
                  Save request file
                </Button>
                <Button busy={busy === 'copy'} onClick={() => void copyRequest()}>
                  Copy request code
                </Button>
              </div>
            </div>
          </div>

          <div className="cd-step">
            <span className="cd-step__number">2</span>
            <div className="cd-step__body">
              <div className="cd-step__title">Install the licence you receive</div>
              <div>
                <Button variant="primary" icon={<KeyIcon />} busy={busy === 'file'} onClick={() => void importFile()}>
                  Open licence file
                </Button>
              </div>
              <Field label="Or paste the licence code" hint="The code starts with NDLIC1.">
                {(id) => (
                  <textarea
                    id={id}
                    className="cd-input cd-input--mono cd-textarea"
                    rows={3}
                    value={code}
                    spellCheck={false}
                    onChange={(event) => setCode(event.target.value)}
                  />
                )}
              </Field>
              <div>
                <Button busy={busy === 'code'} disabled={code.trim().length < 20} onClick={() => void importCode()}>
                  Activate with code
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
