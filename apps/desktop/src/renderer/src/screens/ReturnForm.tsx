import type { AccountSummary, DeviceDetail, ItemSummary, SupplierSummary } from '@nexodesk/shared';
import { formatRupees } from '@nexodesk/shared';
import { useEffect, useState } from 'react';
import { MoneyInput, SearchSelect, todayIso } from '../components/forms';
import { useToast } from '../components/toast';
import { Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { AccountSelect } from './SuppliersScreen';

/** Returns handsets (scanned by IMEI) and accessories to the supplier they came from. */
export function ReturnForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const notify = useToast();
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [returnDate, setReturnDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [devices, setDevices] = useState<DeviceDetail[]>([]);
  const [itemLines, setItemLines] = useState<Array<{ itemId: number; quantity: number }>>([]);
  const [imei, setImei] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [refund, setRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState(0);
  const [accountId, setAccountId] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([call('suppliers:list', {}), call('catalog:items', {}), call('accounts:list')]).then(([nextSuppliers, nextItems, nextAccounts]) => {
      setSuppliers(nextSuppliers);
      setItems(nextItems.filter((item) => item.onHand > 0));
      setAccounts(nextAccounts);
    });
  }, []);

  async function scan() {
    const value = imei.trim();
    if (!value) return;
    setScanError(null);
    try {
      const device = await call('stock:lookupImei', { imei: value });
      if (!device) return setScanError(`${value} was never received in this shop.`);
      if (device.status !== 'in_stock') return setScanError(`${value} is not in stock.`);
      if (supplierId && device.supplierId !== supplierId) return setScanError(`${value} was bought from ${device.supplierName ?? 'another supplier'}.`);
      if (devices.some((entry) => entry.id === device.id)) return setScanError(`${value} is already in this return.`);
      if (!supplierId && device.supplierId) setSupplierId(device.supplierId);
      setDevices((current) => [...current, device]);
      setImei('');
    } catch (scanFailure) {
      setScanError(errorMessage(scanFailure));
    }
  }

  const itemValue = itemLines.reduce((sum, line) => sum + (items.find((item) => item.id === line.itemId)?.averageCost ?? 0) * line.quantity, 0);
  const deviceValue = devices.reduce((sum, device) => sum + (device.cost ?? 0), 0);
  const total = itemValue + deviceValue;

  async function save() {
    if (!supplierId) return;
    setBusy(true);
    setError(null);
    try {
      const { number } = await call('purchaseReturns:create', {
        supplierId,
        returnDate,
        reason,
        deviceIds: devices.map((device) => device.id),
        items: itemLines,
        refund: refund && refundAmount > 0 ? { accountId, amount: refundAmount, reference: '' } : null,
      });
      notify({ tone: 'success', title: `Return ${number} saved`, message: 'The stock was removed and the supplier balance updated.' });
      onDone();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  const ready = supplierId !== null && (devices.length > 0 || itemLines.length > 0) && reason.trim() !== '';

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <div className="cd-toolbar">
        <Button variant="ghost" onClick={onCancel}>← Purchases</Button>
      </div>
      <div className="cd-doc-grid">
        <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
          <Panel title="Return to supplier">
            <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
              <div className="cd-form-grid">
                <Field label="Supplier" hint="Filled in from the first IMEI scanned">
                  {(id) => (
                    <SearchSelect
                      id={id}
                      options={suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name, hint: supplier.city }))}
                      value={supplierId}
                      onChange={(value) => {
                        setSupplierId(value);
                        setDevices((current) => current.filter((device) => device.supplierId === value));
                      }}
                    />
                  )}
                </Field>
                <Field label="Date">{(id) => <input id={id} className="cd-input" type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} />}</Field>
              </div>
              <Field label="Reason">{(id) => <input id={id} className="cd-input" placeholder="Faulty, wrong model, dead on arrival…" value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
            </div>
          </Panel>

          <Panel title="Handsets">
            <form
              className="cd-scan"
              style={{ gridTemplateColumns: '1fr auto', margin: 'var(--space-3) 0' }}
              onSubmit={(event) => {
                event.preventDefault();
                void scan();
              }}
            >
              <Field label="Scan IMEI">
                {(id) => <input id={id} className="cd-input mono" autoFocus inputMode="numeric" value={imei} onChange={(event) => setImei(event.target.value.replace(/\D/g, '').slice(0, 15))} />}
              </Field>
              <Button type="submit" variant="primary" disabled={!imei}>Add</Button>
            </form>
            {scanError ? <div className="cd-field__error" style={{ marginBottom: 'var(--space-3)' }}>{scanError}</div> : null}
            {devices.length > 0 ? (
              <div className="cd-table-wrap">
                <table className="cd-table">
                  <thead><tr><th>Handset</th><th>IMEI</th><th className="num">Cost</th><th aria-label="Remove" /></tr></thead>
                  <tbody>
                    {devices.map((device) => (
                      <tr key={device.id}>
                        <td>{device.label}</td>
                        <td className="mono">{device.imei1}</td>
                        <td className="num">{device.cost !== null ? formatRupees(device.cost) : '—'}</td>
                        <td style={{ textAlign: 'right' }}><Button variant="ghost" onClick={() => setDevices((current) => current.filter((entry) => entry.id !== device.id))}>Remove</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Panel>

          <Panel title="Accessories" actions={<Button onClick={() => items[0] && setItemLines((current) => [...current, { itemId: items[0]!.id, quantity: 1 }])} disabled={items.length === 0}>+ Add accessory</Button>}>
            {itemLines.length === 0 ? (
              <div className="cd-empty">No accessories in this return.</div>
            ) : (
              <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3) 0' }}>
                {itemLines.map((line, index) => {
                  const item = items.find((candidate) => candidate.id === line.itemId);
                  return (
                    <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 110px auto', gap: 'var(--space-3)', alignItems: 'end' }}>
                      <Field label="Item">
                        {(id) => (
                          <SearchSelect
                            id={id}
                            options={items.map((candidate) => ({ value: candidate.id, label: candidate.name, hint: `${candidate.onHand} on hand` }))}
                            value={line.itemId}
                            onChange={(itemId) => setItemLines((current) => current.map((entry, position) => (position === index ? { ...entry, itemId } : entry)))}
                          />
                        )}
                      </Field>
                      <Field label="Quantity" error={item && line.quantity > item.onHand ? `Only ${item.onHand} on hand` : null}>
                        {(id) => (
                          <input
                            id={id}
                            className="cd-input num"
                            type="number"
                            min={1}
                            value={line.quantity}
                            onChange={(event) => setItemLines((current) => current.map((entry, position) => (position === index ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) } : entry)))}
                          />
                        )}
                      </Field>
                      <Button variant="ghost" onClick={() => setItemLines((current) => current.filter((_, position) => position !== index))}>Remove</Button>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Summary">
          <div className="cd-totals" style={{ padding: 'var(--space-3) 0' }}>
            <div className="cd-totals__row"><span>Handsets</span><span>{devices.length}</span></div>
            <div className="cd-totals__row"><span>Accessories</span><span>{itemLines.reduce((sum, line) => sum + line.quantity, 0)}</span></div>
            <div className="cd-totals__row cd-totals__row--grand"><span>Value at cost</span><span>{formatRupees(total)}</span></div>
            <label className="cd-checkbox" style={{ marginTop: 'var(--space-2)' }}>
              <input type="checkbox" checked={refund} onChange={(event) => {
                setRefund(event.target.checked);
                if (event.target.checked) setRefundAmount(total);
              }} />
              <span>Supplier is paying money back now</span>
            </label>
            {refund ? (
              <>
                <Field label="Amount received">{(id) => <MoneyInput id={id} value={refundAmount} onChange={setRefundAmount} />}</Field>
                <Field label="Received into">{(id) => <AccountSelect id={id} accounts={accounts} value={accountId} onChange={setAccountId} />}</Field>
              </>
            ) : (
              <div className="cd-field__hint">Without a refund, the value is taken off what the shop owes this supplier.</div>
            )}
            <Button variant="primary" busy={busy} disabled={!ready || (refund && refundAmount > total)} onClick={() => void save()}>Save return</Button>
            {!reason.trim() && (devices.length > 0 || itemLines.length > 0) ? <div className="cd-field__hint">Enter a reason to save.</div> : null}
            {error ? <Banner tone="danger" title={error} /> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
