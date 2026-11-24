import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ui/components/toast';
import { Badge, Banner, Button, Field, Panel, Segmented, type Tone } from '@ui/components/ui';
import type { CreateLicenseInput, Dashboard, LicenseSummary } from '../../../shared/contract';
import { formatDay, lm, message, PLAN_OPTIONS, planLabel, todayIso } from '../api';

const DAY_MS = 24 * 60 * 60 * 1000;

export function licenseBadge(license: Pick<LicenseSummary, 'status' | 'validUntil' | 'graceDays'>): { label: string; tone: Tone } {
  if (license.status === 'revoked') return { label: 'Revoked', tone: 'danger' };
  if (license.status === 'suspended') return { label: 'Suspended', tone: 'warning' };
  const left = Date.parse(license.validUntil) - Date.now();
  if (left < 0) return { label: left > -license.graceDays * DAY_MS ? 'In grace period' : 'Expired', tone: 'danger' };
  if (left <= 7 * DAY_MS) return { label: `Ends in ${Math.ceil(left / DAY_MS)} days`, tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

const emptyForm = (): CreateLicenseInput => ({
  shopName: '',
  ownerName: '',
  phone: '',
  city: '',
  plan: 'monthly',
  validFrom: todayIso(),
  deviceLimit: 1,
  graceDays: 3,
  notes: '',
});

function NewLicensePanel({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const notify = useToast();
  const [form, setForm] = useState<CreateLicenseInput>(emptyForm);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CreateLicenseInput>(key: K, value: CreateLicenseInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function create() {
    setBusy(true);
    try {
      const input = form.plan === 'custom' ? form : { ...form, customUntil: undefined };
      const { id } = await lm('lm:createLicense', input);
      notify({ tone: 'success', title: 'Licence created', message: `${form.shopName}: ${id}` });
      onCreated(id);
    } catch (error) {
      notify({ tone: 'danger', title: 'Licence not created', message: message(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="New licence"
      description="Create the licence, then activate the shop's computer from its request file."
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!form.shopName.trim() || (form.plan === 'custom' && !form.customUntil)} onClick={() => void create()}>
            Create licence
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
        <div className="cd-form-grid">
          <Field label="Shop name">
            {(id) => <input id={id} className="cd-input" value={form.shopName} onChange={(event) => set('shopName', event.target.value)} />}
          </Field>
          <Field label="Owner name">
            {(id) => <input id={id} className="cd-input" value={form.ownerName} onChange={(event) => set('ownerName', event.target.value)} />}
          </Field>
          <Field label="Phone">
            {(id) => <input id={id} className="cd-input" value={form.phone} onChange={(event) => set('phone', event.target.value)} />}
          </Field>
          <Field label="City">
            {(id) => <input id={id} className="cd-input" value={form.city} onChange={(event) => set('city', event.target.value)} />}
          </Field>
        </div>
        <div className="cd-form-row">
          <div className="cd-field">
            <span className="cd-field__label">Plan</span>
            <Segmented
              label="Plan"
              value={form.plan}
              onChange={(plan) => set('plan', plan)}
              options={PLAN_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            />
          </div>
          <Field label="Starts on">
            {(id) => <input id={id} className="cd-input" type="date" value={form.validFrom} onChange={(event) => set('validFrom', event.target.value)} />}
          </Field>
          {form.plan === 'custom' ? (
            <Field label="Last day">
              {(id) => (
                <input id={id} className="cd-input" type="date" value={form.customUntil ?? ''} onChange={(event) => set('customUntil', event.target.value || undefined)} />
              )}
            </Field>
          ) : null}
          <Field label="Computers allowed">
            {(id) => (
              <input id={id} className="cd-input" type="number" min={1} max={20} style={{ width: 120 }} value={form.deviceLimit} onChange={(event) => set('deviceLimit', Number(event.target.value) || 1)} />
            )}
          </Field>
          <Field label="Grace days">
            {(id) => (
              <input id={id} className="cd-input" type="number" min={0} max={30} style={{ width: 110 }} value={form.graceDays} onChange={(event) => set('graceDays', Number(event.target.value) || 0)} />
            )}
          </Field>
        </div>
        <Field label="Notes">
          {(id) => <input id={id} className="cd-input" value={form.notes} onChange={(event) => set('notes', event.target.value)} />}
        </Field>
      </div>
    </Panel>
  );
}

export function LicensesScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const [licenses, setLicenses] = useState<LicenseSummary[] | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([lm('lm:licenses'), lm('lm:dashboard')]);
      setLicenses(list);
      setDashboard(stats);
    } catch (loadError) {
      setError(message(loadError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger" title="Licences could not be loaded">{error}</Banner>;
  if (!licenses || !dashboard) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? licenses.filter((license) =>
        [license.shopName, license.ownerName, license.phone, license.city, license.id].some((value) => value.toLowerCase().includes(needle)),
      )
    : licenses;

  return (
    <div className="cd-page">
      <div className="cd-stats">
        <div className="cd-stat"><div className="cd-stat__label">Active licences</div><div className="cd-stat__value num">{dashboard.activeLicenses}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Ending in 7 days</div><div className="cd-stat__value num">{dashboard.expiringSoon}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Expired</div><div className="cd-stat__value num">{dashboard.expired}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Computers</div><div className="cd-stat__value num">{dashboard.devices}</div></div>
      </div>

      {creating ? (
        <NewLicensePanel onCancel={() => setCreating(false)} onCreated={(id) => onOpen(id)} />
      ) : (
        <Panel
          title="All licences"
          description="Sorted by end date, soonest first."
          actions={
            <>
              <input className="cd-input" placeholder="Search shop, phone, city or ID" value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: 280 }} />
              <Button variant="primary" onClick={() => setCreating(true)}>New licence</Button>
            </>
          }
        >
          {visible.length === 0 ? (
            <div className="cd-empty">{licenses.length === 0 ? 'No licences yet. Create the first one.' : 'No licence matches the search.'}</div>
          ) : (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Shop</th>
                    <th>Licence ID</th>
                    <th>Plan</th>
                    <th>Valid until</th>
                    <th className="num">Computers</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((license) => {
                    const badge = licenseBadge(license);
                    return (
                      <tr key={license.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(license.id)}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{license.shopName}</div>
                          <div className="cd-field__hint">{[license.ownerName, license.city, license.phone].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="mono">{license.id}</td>
                        <td>{planLabel(license.plan)}</td>
                        <td>{formatDay(license.validUntil)}</td>
                        <td className="num">{license.activeDevices} / {license.deviceLimit}</td>
                        <td><Badge tone={badge.tone}>{badge.label}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
