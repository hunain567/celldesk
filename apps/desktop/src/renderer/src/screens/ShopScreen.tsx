import type { ShopProfile } from '@nexodesk/shared';
import { useEffect, useState } from 'react';
import { useToast } from '../components/toast';
import { Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

export const EMPTY_SHOP: ShopProfile = { shopName: '', ownerName: '', phone: '', address: '', city: '', receiptFooter: '' };

/** Shop details fields, shared by the setup wizard and the Shop screen. */
export function ShopFields({ value, onChange }: { value: ShopProfile; onChange: (next: ShopProfile) => void }) {
  const set = (key: keyof ShopProfile) => (event: { target: { value: string } }) => onChange({ ...value, [key]: event.target.value });
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div className="cd-form-grid">
        <Field label="Shop name" hint="Printed on receipts">
          {(id) => <input id={id} className="cd-input" value={value.shopName} onChange={set('shopName')} />}
        </Field>
        <Field label="Owner name">
          {(id) => <input id={id} className="cd-input" value={value.ownerName} onChange={set('ownerName')} />}
        </Field>
        <Field label="Phone">
          {(id) => <input id={id} className="cd-input" value={value.phone} onChange={set('phone')} />}
        </Field>
        <Field label="City">
          {(id) => <input id={id} className="cd-input" value={value.city} onChange={set('city')} />}
        </Field>
      </div>
      <Field label="Address">
        {(id) => <input id={id} className="cd-input" value={value.address} onChange={set('address')} />}
      </Field>
      <Field label="Receipt footer" hint="For example: No return without receipt. Warranty as per company policy.">
        {(id) => <input id={id} className="cd-input" value={value.receiptFooter} onChange={set('receiptFooter')} />}
      </Field>
    </div>
  );
}

export function ShopScreen() {
  const notify = useToast();
  const { setup, refresh } = useAuth();
  const [shop, setShop] = useState<ShopProfile | null>(null);
  const [saved, setSaved] = useState<ShopProfile | null>(null);
  const [lockMinutes, setLockMinutes] = useState(setup?.autoLockMinutes ?? 15);
  const [busy, setBusy] = useState<'shop' | 'lock' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call('shop:get')
      .then((value) => {
        setShop(value ?? EMPTY_SHOP);
        setSaved(value ?? EMPTY_SHOP);
      })
      .catch((loadError) => setError(errorMessage(loadError)));
  }, []);

  async function saveShop() {
    if (!shop) return;
    setBusy('shop');
    try {
      await call('shop:update', shop);
      setSaved(shop);
      notify({ tone: 'success', title: 'Shop details saved' });
      void refresh();
    } catch (saveError) {
      notify({ tone: 'danger', title: 'Not saved', message: errorMessage(saveError) });
    } finally {
      setBusy(null);
    }
  }

  async function saveLock() {
    setBusy('lock');
    try {
      await call('settings:set', { key: 'security.autoLockMinutes', value: lockMinutes });
      notify({ tone: 'success', title: 'Auto-lock saved', message: `The screen locks after ${lockMinutes} minutes without activity.` });
      void refresh();
    } catch (saveError) {
      notify({ tone: 'danger', title: 'Not saved', message: errorMessage(saveError) });
    } finally {
      setBusy(null);
    }
  }

  if (error) return <Banner tone="danger" title="Shop details could not be loaded">{error}</Banner>;
  if (!shop) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  return (
    <div className="cd-page">
      <Panel
        title="Shop details"
        description="Shown on the sign-in screen and printed on receipts."
        actions={
          <Button variant="primary" busy={busy === 'shop'} disabled={!shop.shopName.trim() || JSON.stringify(shop) === JSON.stringify(saved)} onClick={() => void saveShop()}>
            Save
          </Button>
        }
      >
        <div style={{ padding: 'var(--space-3) 0' }}>
          <ShopFields value={shop} onChange={setShop} />
        </div>
      </Panel>

      <Panel
        title="Auto-lock"
        description="When nobody uses NexoDesk for this long, the screen locks and staff must sign in again."
        actions={
          <Button busy={busy === 'lock'} disabled={lockMinutes === setup?.autoLockMinutes} onClick={() => void saveLock()}>
            Save
          </Button>
        }
      >
        <div className="cd-form-row" style={{ padding: 'var(--space-3) 0' }}>
          <Field label="Lock after (minutes)">
            {(id) => (
              <select id={id} className="cd-select" value={lockMinutes} onChange={(event) => setLockMinutes(Number(event.target.value))}>
                {[5, 10, 15, 30, 60, 120].map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} minutes
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Panel>
    </div>
  );
}
