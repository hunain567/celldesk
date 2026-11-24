import { useCallback, useEffect, useState } from 'react';
import { FileIcon, TrashIcon } from '@ui/components/icons';
import { useToast } from '@ui/components/toast';
import { Badge, Banner, Button, Field, Panel, Properties, Segmented } from '@ui/components/ui';
import type { IssuedLicense, LicenseDetail, RequestPreview } from '../../../shared/contract';
import { copyText, formatDay, formatDayTime, lm, message, PLAN_OPTIONS, planLabel } from '../api';
import { licenseBadge } from './LicensesScreen';

type Plan = (typeof PLAN_OPTIONS)[number]['value'];

/** Shows a freshly issued licence with Save and Copy, so it can go by USB or WhatsApp. */
function IssuedCard({ issued, onDone }: { issued: IssuedLicense; onDone: () => void }) {
  const notify = useToast();
  async function save() {
    try {
      const { path } = await lm('lm:saveLicenseFile', { code: issued.code, fileName: issued.fileName });
      if (path) notify({ tone: 'success', title: 'Licence file saved', message: path });
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not save the file', message: message(error) });
    }
  }
  async function copy() {
    try {
      await copyText(issued.code);
      notify({ tone: 'success', title: 'Licence code copied', message: 'Paste it into WhatsApp for the shop.' });
    } catch {
      notify({ tone: 'danger', title: 'Could not copy the code' });
    }
  }
  return (
    <Banner
      tone="success"
      title={`Licence issued, valid until ${formatDay(issued.validUntil)}`}
      actions={
        <div className="cd-actions">
          <Button icon={<FileIcon />} onClick={() => void save()}>Save .ndlic file</Button>
          <Button onClick={() => void copy()}>Copy code</Button>
          <Button variant="ghost" onClick={onDone}>Done</Button>
        </div>
      }
    >
      Give this file to the shop on a USB drive, or send the code on WhatsApp. In NexoDesk: Licence, then Open licence file.
    </Banner>
  );
}

function ActivatePanel({ license, onIssued }: { license: LicenseDetail; onIssued: (issued: IssuedLicense) => void }) {
  const notify = useToast();
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(text: string) {
    setCode(text);
    setPreview(null);
    if (text.trim().length < 20) return;
    try {
      setPreview(await lm('lm:previewRequest', { code: text.trim() }));
    } catch (error) {
      notify({ tone: 'danger', title: 'This request cannot be used', message: message(error) });
    }
  }

  async function openFile() {
    try {
      const result = await lm('lm:openRequestFile');
      if (result) await check(result.code);
    } catch (error) {
      notify({ tone: 'danger', title: 'Could not open the request', message: message(error) });
    }
  }

  async function issue() {
    setBusy(true);
    try {
      onIssued(await lm('lm:issueForRequest', { licenseId: license.id, code: code.trim() }));
      setCode('');
      setPreview(null);
    } catch (error) {
      notify({ tone: 'danger', title: 'Licence not issued', message: message(error) });
    } finally {
      setBusy(false);
    }
  }

  const otherLicense = preview?.knownLicenseId && preview.knownLicenseId !== license.id;
  return (
    <Panel title="Activate a computer" description="Load the activation request from the shop's computer (.ndreq file or pasted code).">
      <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3) 0' }}>
        <div>
          <Button icon={<FileIcon />} onClick={() => void openFile()}>Open request file</Button>
        </div>
        <Field label="Or paste the request code" hint="The code starts with NDREQ1.">
          {(id) => (
            <textarea id={id} className="cd-input cd-input--mono cd-textarea" rows={3} spellCheck={false} value={code} onChange={(event) => void check(event.target.value)} />
          )}
        </Field>
        {preview ? (
          <>
            <Properties
              items={[
                { label: 'Computer name', value: preview.machineName },
                { label: 'Computer ID', value: <span className="mono">{preview.deviceId.slice(0, 12).toUpperCase()}</span> },
                { label: 'NexoDesk version', value: preview.appVersion },
                { label: 'Request made', value: formatDayTime(preview.createdAt) },
              ]}
            />
            {preview.clockAhead ? (
              <Banner tone="warning" title="The shop computer's clock is ahead">
                It has seen {formatDayTime(preview.latestTimeSeen)}. Ask the shop to correct the date; the new licence will reset the clock check.
              </Banner>
            ) : null}
            {otherLicense ? (
              <Banner tone="warning" title="This computer is registered to another licence">
                {preview.knownShopName} ({preview.knownLicenseId}). Issuing here registers it to this licence as well.
              </Banner>
            ) : null}
            <div>
              <Button variant="primary" busy={busy} onClick={() => void issue()}>Issue licence file</Button>
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export function LicenseDetailScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const notify = useToast();
  const [license, setLicense] = useState<LicenseDetail | null>(null);
  const [issued, setIssued] = useState<IssuedLicense | null>(null);
  const [extendPlan, setExtendPlan] = useState<Plan>('monthly');
  const [customUntil, setCustomUntil] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // A newly issued licence appears at the top of the page; bring it into view.
  useEffect(() => {
    if (issued) document.querySelector('.cd-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [issued]);

  const load = useCallback(async () => {
    try {
      setLicense(await lm('lm:license', { id }));
    } catch (error) {
      notify({ tone: 'danger', title: 'Licence could not be loaded', message: message(error) });
    }
  }, [id, notify]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(name: string, action: () => Promise<unknown>, success: string) {
    setBusy(name);
    try {
      await action();
      notify({ tone: 'success', title: success });
      await load();
    } catch (error) {
      notify({ tone: 'danger', title: 'Not done', message: message(error) });
    } finally {
      setBusy(null);
    }
  }

  async function renew(deviceRowId: number) {
    setBusy(`renew-${deviceRowId}`);
    try {
      setIssued(await lm('lm:issueForDevice', { licenseId: id, deviceRowId }));
      await load();
    } catch (error) {
      notify({ tone: 'danger', title: 'Renewal not issued', message: message(error) });
    } finally {
      setBusy(null);
    }
  }

  if (!license) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;
  const badge = licenseBadge(license);
  const activeDevices = license.devices.filter((device) => device.status === 'active');

  return (
    <div className="cd-page">
      <div><Button variant="ghost" onClick={onBack}>← All licences</Button></div>
      {issued ? <IssuedCard issued={issued} onDone={() => setIssued(null)} /> : null}

      <Panel
        title={license.shopName}
        description={[license.ownerName, license.city, license.phone].filter(Boolean).join(' · ')}
        actions={<Badge tone={badge.tone}>{badge.label}</Badge>}
      >
        <Properties
          items={[
            { label: 'Licence ID', value: <span className="mono selectable">{license.id}</span> },
            { label: 'Plan', value: planLabel(license.plan) },
            { label: 'Valid', value: `${formatDay(license.validFrom)} to ${formatDay(license.validUntil)}` },
            { label: 'Grace period', value: `${license.graceDays} days` },
            { label: 'Computers', value: `${license.activeDevices} of ${license.deviceLimit}` },
            { label: 'Notes', value: license.notes || '—' },
          ]}
        />
      </Panel>

      {license.status === 'active' ? <ActivatePanel license={license} onIssued={(next) => { setIssued(next); void load(); }} /> : null}

      <Panel title="Computers" description="Renewal files can be issued for registered computers without a new request.">
        {license.devices.length === 0 ? (
          <div className="cd-empty">No computer activated yet.</div>
        ) : (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr><th>Computer</th><th>ID</th><th>Activated</th><th>Last file issued</th><th>Status</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {license.devices.map((device) => (
                  <tr key={device.id}>
                    <td>{device.machineName}<div className="cd-field__hint">NexoDesk {device.appVersion}</div></td>
                    <td className="mono">{device.deviceId.slice(0, 12).toUpperCase()}</td>
                    <td>{formatDay(device.firstActivatedAt)}</td>
                    <td>{formatDayTime(device.lastIssuedAt)}</td>
                    <td>{device.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge>Removed</Badge>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {device.status === 'active' ? (
                        <div className="cd-actions" style={{ justifyContent: 'flex-end' }}>
                          <Button busy={busy === `renew-${device.id}`} disabled={license.status !== 'active'} onClick={() => void renew(device.id)}>Issue renewal file</Button>
                          <Button variant="ghost" icon={<TrashIcon />} onClick={() => void act('remove', () => lm('lm:removeDevice', { deviceRowId: device.id }), 'Computer removed')}>Remove</Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {activeDevices.length > 0 ? (
          <div className="cd-field__hint" style={{ paddingTop: 'var(--space-3)' }}>
            Removing a computer frees its slot. Its current licence file keeps working until it expires, because shops work offline.
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Extend subscription"
        description="The new period starts the day after the current end date, or today if the licence has already expired."
        actions={
          <Button
            variant="primary"
            busy={busy === 'extend'}
            disabled={license.status === 'revoked' || (extendPlan === 'custom' && !customUntil)}
            onClick={() =>
              void act('extend', () => lm('lm:extend', { id, plan: extendPlan, ...(extendPlan === 'custom' ? { customUntil } : {}) }), 'Subscription extended. Issue renewal files for its computers.')
            }
          >
            Extend
          </Button>
        }
      >
        <div className="cd-form-row" style={{ padding: 'var(--space-3) 0' }}>
          <Segmented label="Extension" value={extendPlan} onChange={setExtendPlan} options={PLAN_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
          {extendPlan === 'custom' ? (
            <Field label="New last day">
              {(fieldId) => <input id={fieldId} className="cd-input" type="date" value={customUntil} onChange={(event) => setCustomUntil(event.target.value)} />}
            </Field>
          ) : null}
        </div>
      </Panel>

      <Panel title="Licence status" description="Suspended licences get no new files until reactivated. Revoking is permanent and is added to the next NexoDesk release.">
        <div className="cd-actions" style={{ padding: 'var(--space-3) 0' }}>
          {license.status === 'suspended' ? (
            <Button busy={busy === 'status'} onClick={() => void act('status', () => lm('lm:setStatus', { id, status: 'active' }), 'Licence reactivated')}>Reactivate</Button>
          ) : null}
          {license.status === 'active' ? (
            <Button busy={busy === 'status'} onClick={() => void act('status', () => lm('lm:setStatus', { id, status: 'suspended' }), 'Licence suspended')}>Suspend</Button>
          ) : null}
          {license.status !== 'revoked' ? (
            <Button
              variant="danger"
              busy={busy === 'revoke'}
              onClick={() => {
                if (window.confirm(`Revoke ${license.id} for ${license.shopName}? This cannot be undone.`)) {
                  void act('revoke', () => lm('lm:setStatus', { id, status: 'revoked' }), 'Licence revoked');
                }
              }}
            >
              Revoke
            </Button>
          ) : (
            <Badge tone="danger">Revoked</Badge>
          )}
        </div>
      </Panel>

      <Panel title="Activation history">
        <div className="cd-table-wrap">
          <table className="cd-table">
            <thead><tr><th>When</th><th>Event</th><th>Details</th></tr></thead>
            <tbody>
              {license.events.map((event) => (
                <tr key={event.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDayTime(event.at)}</td>
                  <td style={{ textTransform: 'capitalize' }}>{event.kind.replace(/-/g, ' ')}</td>
                  <td>{event.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
