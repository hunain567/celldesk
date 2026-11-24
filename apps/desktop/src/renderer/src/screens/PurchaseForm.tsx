import type { AccountSummary, Condition, ItemSummary, PtaStatus, PurchaseInput, SupplierSummary, VariantSummary, WarrantyType } from '@nexodesk/shared';
import { CONDITION_LABELS, formatRupees, isValidImei, PTA_LABELS, WARRANTY_LABELS } from '@nexodesk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoneyInput, SearchSelect, todayIso } from '../components/forms';
import { useToast } from '../components/toast';
import { Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AddHandsetDialog, ItemDialog } from './CatalogueScreen';
import { AccountSelect, SupplierDialog } from './SuppliersScreen';

interface ScannedDevice {
  imei1: string;
  imei2: string | null;
  /** Problem reported by the server (already in the system, etc.). */
  problem: string | null;
}

interface HandsetLine {
  key: number;
  kind: 'device';
  variantId: number | null;
  unitCost: number;
  condition: Condition;
  ptaStatus: PtaStatus;
  warrantyType: WarrantyType;
  warrantyMonths: number;
  devices: ScannedDevice[];
}

interface ItemLine {
  key: number;
  kind: 'item';
  itemId: number | null;
  quantity: number;
  unitCost: number;
}

type Line = HandsetLine | ItemLine;
let nextKey = 1;

const newHandsetLine = (): HandsetLine => ({
  key: nextKey++,
  kind: 'device',
  variantId: null,
  unitCost: 0,
  condition: 'new',
  ptaStatus: 'approved',
  warrantyType: 'official',
  warrantyMonths: 12,
  devices: [],
});
const newItemLine = (): ItemLine => ({ key: nextKey++, kind: 'item', itemId: null, quantity: 1, unitCost: 0 });

function lineTotal(line: Line): number {
  return line.kind === 'device' ? line.unitCost * line.devices.length : line.unitCost * line.quantity;
}

/**
 * Scanner-friendly IMEI entry: scan IMEI 1, press Enter (most scanners do),
 * scan IMEI 2 or press Enter to skip. The handset is added and the cursor goes
 * back to IMEI 1 for the next box.
 */
function ImeiScanner({ taken, onAdd }: { taken: Set<string>; onAdd: (imei1: string, imei2: string | null) => void }) {
  const [imei1, setImei1] = useState('');
  const [imei2, setImei2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);

  function check(value: string): string | null {
    if (!isValidImei(value)) return `${value || 'This'} is not a valid IMEI. Scan it again.`;
    if (taken.has(value)) return `${value} is already in this purchase.`;
    return null;
  }

  function add() {
    const problem = check(imei1) ?? (imei2 ? (imei2 === imei1 ? 'IMEI 2 is the same as IMEI 1.' : check(imei2)) : null);
    if (problem) {
      setError(problem);
      return;
    }
    onAdd(imei1, imei2 || null);
    setImei1('');
    setImei2('');
    setError(null);
    first.current?.focus();
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <div className="cd-scan">
        <Field label="IMEI 1">
          {(id) => (
            <input
              id={id}
              ref={first}
              className="cd-input mono"
              inputMode="numeric"
              placeholder="Scan IMEI 1"
              value={imei1}
              onChange={(event) => setImei1(event.target.value.replace(/\D/g, '').slice(0, 15))}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const problem = check(imei1);
                if (problem) setError(problem);
                else {
                  setError(null);
                  second.current?.focus();
                }
              }}
            />
          )}
        </Field>
        <Field label="IMEI 2 (Enter to skip)">
          {(id) => (
            <input
              id={id}
              ref={second}
              className="cd-input mono"
              inputMode="numeric"
              placeholder="Scan IMEI 2"
              value={imei2}
              onChange={(event) => setImei2(event.target.value.replace(/\D/g, '').slice(0, 15))}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add();
              }}
            />
          )}
        </Field>
        <Button variant="primary" disabled={!imei1} onClick={add}>Add</Button>
      </div>
      {error ? <div className="cd-field__error">{error}</div> : null}
    </div>
  );
}

export function PurchaseForm({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const notify = useToast();
  const { can } = useAuth();
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [variants, setVariants] = useState<VariantSummary[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayIso());
  const [lines, setLines] = useState<Line[]>([newHandsetLine()]);
  const [discount, setDiscount] = useState(0);
  const [notes, setNotes] = useState('');
  const [payNow, setPayNow] = useState(false);
  const [accountId, setAccountId] = useState(1);
  const [payAmount, setPayAmount] = useState(0);
  const [reference, setReference] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'supplier' } | { kind: 'handset'; lineKey: number } | { kind: 'item'; lineKey: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const loadLists = useCallback(async () => {
    const [nextSuppliers, nextVariants, nextItems, nextAccounts] = await Promise.all([
      call('suppliers:list', {}),
      call('catalog:variants', {}),
      call('catalog:items', {}),
      call('accounts:list'),
    ]);
    setSuppliers(nextSuppliers);
    setVariants(nextVariants);
    setItems(nextItems);
    setAccounts(nextAccounts);
  }, []);
  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const update = (key: number, change: Partial<HandsetLine> | Partial<ItemLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? ({ ...line, ...change } as Line) : line)));

  const takenImeis = new Set(lines.flatMap((line) => (line.kind === 'device' ? line.devices.flatMap((device) => [device.imei1, ...(device.imei2 ? [device.imei2] : [])]) : [])));
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const total = Math.max(subtotal - discount, 0);
  const units = lines.reduce((sum, line) => sum + (line.kind === 'device' ? line.devices.length : line.quantity), 0);
  const effectivePay = payNow ? payAmount : 0;

  useEffect(() => {
    if (payNow) setPayAmount(total);
  }, [payNow, total]);

  async function addDevice(line: HandsetLine, imei1: string, imei2: string | null) {
    const device: ScannedDevice = { imei1, imei2, problem: null };
    update(line.key, { devices: [...line.devices, device] });
    // Ask the backend whether these IMEIs were ever received before.
    try {
      const problems = await call('purchases:checkImeis', { imeis: [imei1, ...(imei2 ? [imei2] : [])] });
      if (problems.length > 0) {
        setLines((current) =>
          current.map((candidate) =>
            candidate.key === line.key && candidate.kind === 'device'
              ? { ...candidate, devices: candidate.devices.map((entry) => (entry.imei1 === imei1 ? { ...entry, problem: problems[0]!.message } : entry)) }
              : candidate,
          ),
        );
      }
    } catch {
      // The full check runs again when saving.
    }
  }

  async function save() {
    if (!supplierId) return;
    setBusy(true);
    setErrors([]);
    const input: PurchaseInput = {
      supplierId,
      supplierInvoiceNo: invoiceNo,
      purchaseDate,
      discount,
      notes,
      lines: lines
        .filter((line) => (line.kind === 'device' ? line.variantId && line.devices.length > 0 : line.itemId && line.quantity > 0))
        .map((line) =>
          line.kind === 'device'
            ? {
                kind: 'device' as const,
                variantId: line.variantId!,
                unitCost: line.unitCost,
                devices: line.devices.map((device) => ({
                  imei1: device.imei1,
                  imei2: device.imei2,
                  condition: line.condition,
                  ptaStatus: line.ptaStatus,
                  warrantyType: line.warrantyType,
                  warrantyMonths: line.warrantyType === 'none' ? 0 : line.warrantyMonths,
                })),
              }
            : { kind: 'item' as const, itemId: line.itemId!, quantity: line.quantity, unitCost: line.unitCost },
        ),
      payment: payNow && payAmount > 0 ? { accountId, amount: payAmount, reference } : null,
    };
    try {
      const { id, number } = await call('purchases:create', input);
      notify({ tone: 'success', title: `Purchase ${number} saved`, message: `${units} unit${units === 1 ? '' : 's'} added to stock.` });
      onDone(id);
    } catch (error) {
      const details = (error as { error?: { details?: string[] } }).error?.details;
      setErrors([errorMessage(error), ...(details ?? [])]);
    } finally {
      setBusy(false);
    }
  }

  const problems = lines.some((line) => line.kind === 'device' && line.devices.some((device) => device.problem));
  const incomplete = lines.some((line) => (line.kind === 'device' ? line.devices.length > 0 && !line.variantId : !line.itemId));
  const ready = supplierId !== null && units > 0 && !problems && !incomplete && discount <= subtotal && effectivePay <= total;

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <div className="cd-toolbar">
        <Button variant="ghost" onClick={onCancel}>← Purchases</Button>
      </div>
      <div className="cd-doc-grid">
        <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
          <Panel title="New purchase">
            <div className="cd-form-grid" style={{ padding: 'var(--space-3) 0' }}>
              <Field label="Supplier">
                {(id) => (
                  <SearchSelect
                    id={id}
                    autoFocus
                    options={suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name, hint: supplier.city }))}
                    value={supplierId}
                    onChange={setSupplierId}
                    {...(can('supplier.manage') ? { onCreate: () => setDialog({ kind: 'supplier' }), createLabel: 'Add new supplier' } : {})}
                  />
                )}
              </Field>
              <div className="cd-form-grid">
                <Field label="Supplier's invoice no.">{(id) => <input id={id} className="cd-input" value={invoiceNo} onChange={(event) => setInvoiceNo(event.target.value)} />}</Field>
                <Field label="Date">{(id) => <input id={id} className="cd-input" type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} />}</Field>
              </div>
            </div>
          </Panel>

          {lines.map((line, index) =>
            line.kind === 'device' ? (
              <div key={line.key} className="cd-line cd-panel">
                <div className="cd-line__head">
                  <strong>Handsets {index + 1}</strong>
                  <Button variant="ghost" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}>Remove</Button>
                </div>
                <div className="cd-form-grid">
                  <Field label="Handset">
                    {(id) => (
                      <SearchSelect
                        id={id}
                        options={variants.map((variant) => ({ value: variant.id, label: variant.label, hint: `${variant.inStock} in stock` }))}
                        value={line.variantId}
                        onChange={(variantId) => {
                          const variant = variants.find((candidate) => candidate.id === variantId);
                          update(line.key, { variantId, ...(line.unitCost === 0 && variant?.lastCost ? { unitCost: variant.lastCost } : {}) });
                        }}
                        {...(can('catalog.manage') ? { onCreate: () => setDialog({ kind: 'handset', lineKey: line.key }), createLabel: 'Add new handset' } : {})}
                        placeholder="Search brand, model, colour"
                      />
                    )}
                  </Field>
                  <Field label="Cost per handset">{(id) => <MoneyInput id={id} value={line.unitCost} onChange={(unitCost) => update(line.key, { unitCost })} />}</Field>
                </div>
                <div className="cd-form-row">
                  <Field label="Condition">
                    {(id) => (
                      <select id={id} className="cd-select" value={line.condition} onChange={(event) => update(line.key, { condition: event.target.value as Condition })}>
                        {Object.entries(CONDITION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    )}
                  </Field>
                  <Field label="PTA">
                    {(id) => (
                      <select id={id} className="cd-select" value={line.ptaStatus} onChange={(event) => update(line.key, { ptaStatus: event.target.value as PtaStatus })}>
                        {Object.entries(PTA_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    )}
                  </Field>
                  <Field label="Warranty">
                    {(id) => (
                      <select id={id} className="cd-select" value={line.warrantyType} onChange={(event) => update(line.key, { warrantyType: event.target.value as WarrantyType })}>
                        {Object.entries(WARRANTY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    )}
                  </Field>
                  {line.warrantyType !== 'none' ? (
                    <Field label="Months">
                      {(id) => (
                        <select id={id} className="cd-select" value={line.warrantyMonths} onChange={(event) => update(line.key, { warrantyMonths: Number(event.target.value) })}>
                          {[1, 3, 6, 12, 18, 24].map((months) => <option key={months} value={months}>{months}</option>)}
                        </select>
                      )}
                    </Field>
                  ) : null}
                </div>
                <ImeiScanner taken={takenImeis} onAdd={(imei1, imei2) => void addDevice(line, imei1, imei2)} />
                {line.devices.length > 0 ? (
                  <div className="cd-imei-list">
                    {line.devices.map((device) => (
                      <span key={device.imei1} className={`cd-imei-chip ${device.problem ? 'cd-imei-chip--bad' : ''}`} title={device.problem ?? undefined}>
                        {device.imei1}
                        {device.imei2 ? ` / ${device.imei2}` : ''}
                        {device.problem ? ` — ${device.problem}` : ''}
                        <button type="button" aria-label={`Remove ${device.imei1}`} onClick={() => update(line.key, { devices: line.devices.filter((entry) => entry.imei1 !== device.imei1) })}>×</button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="cd-field__hint">
                  {line.devices.length} handset{line.devices.length === 1 ? '' : 's'} · {formatRupees(lineTotal(line))}
                </div>
              </div>
            ) : (
              <div key={line.key} className="cd-line cd-panel">
                <div className="cd-line__head">
                  <strong>Accessories {index + 1}</strong>
                  <Button variant="ghost" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}>Remove</Button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 100px 1fr 1fr', gap: 'var(--space-3)', alignItems: 'end' }}>
                  <Field label="Item (or scan barcode)">
                    {(id) => (
                      <SearchSelect
                        id={id}
                        options={items.map((item) => ({ value: item.id, label: item.name, hint: item.barcode ?? item.category }))}
                        value={line.itemId}
                        onChange={(itemId) => {
                          const item = items.find((candidate) => candidate.id === itemId);
                          update(line.key, { itemId, ...(line.unitCost === 0 && item?.averageCost ? { unitCost: item.averageCost } : {}) });
                        }}
                        {...(can('catalog.manage') ? { onCreate: () => setDialog({ kind: 'item', lineKey: line.key }), createLabel: 'Add new accessory' } : {})}
                      />
                    )}
                  </Field>
                  <Field label="Quantity">
                    {(id) => <input id={id} className="cd-input num" type="number" min={1} value={line.quantity} onChange={(event) => update(line.key, { quantity: Math.max(1, Number(event.target.value) || 1) })} />}
                  </Field>
                  <Field label="Cost each">{(id) => <MoneyInput id={id} value={line.unitCost} onChange={(unitCost) => update(line.key, { unitCost })} />}</Field>
                  <div className="cd-money" style={{ paddingBottom: 8, textAlign: 'right' }}>{formatRupees(lineTotal(line))}</div>
                </div>
              </div>
            ),
          )}

          <div className="cd-toolbar">
            <Button onClick={() => setLines((current) => [...current, newHandsetLine()])}>+ Add handsets</Button>
            <Button onClick={() => setLines((current) => [...current, newItemLine()])}>+ Add accessories</Button>
          </div>
        </div>

        <div style={{ position: 'sticky', top: 0, display: 'grid', gap: 'var(--space-4)' }}>
          <Panel title="Summary">
            <div className="cd-totals" style={{ padding: 'var(--space-3) 0' }}>
              <div className="cd-totals__row"><span>Units</span><span>{units}</span></div>
              <div className="cd-totals__row"><span>Subtotal</span><span>{formatRupees(subtotal)}</span></div>
              <Field label="Discount from supplier">{(id) => <MoneyInput id={id} value={discount} onChange={setDiscount} />}</Field>
              <div className="cd-totals__row cd-totals__row--grand"><span>Total</span><span>{formatRupees(total)}</span></div>
              {can('supplier.pay') ? (
                <label className="cd-checkbox" style={{ marginTop: 'var(--space-2)' }}>
                  <input type="checkbox" checked={payNow} onChange={(event) => setPayNow(event.target.checked)} />
                  <span>Paying now</span>
                </label>
              ) : null}
              {payNow ? (
                <>
                  <Field label="Amount paid">{(id) => <MoneyInput id={id} value={payAmount} onChange={setPayAmount} />}</Field>
                  <Field label="Paid from">{(id) => <AccountSelect id={id} accounts={accounts} value={accountId} onChange={setAccountId} />}</Field>
                  <Field label="Reference">{(id) => <input id={id} className="cd-input" value={reference} onChange={(event) => setReference(event.target.value)} />}</Field>
                </>
              ) : null}
              <div className="cd-totals__row"><span>Added to supplier balance</span><span>{formatRupees(Math.max(total - effectivePay, 0))}</span></div>
              <Field label="Notes">{(id) => <input id={id} className="cd-input" value={notes} onChange={(event) => setNotes(event.target.value)} />}</Field>
              <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>Save purchase</Button>
              {problems ? <div className="cd-field__error">Remove the IMEIs marked in red before saving.</div> : null}
            </div>
          </Panel>
          {errors.length > 0 ? (
            <Banner tone="danger" title={errors[0]!}>
              {errors.slice(1, 6).map((detail) => <div key={detail}>{detail}</div>)}
            </Banner>
          ) : null}
        </div>
      </div>

      {dialog?.kind === 'supplier' ? (
        <SupplierDialog supplier={null} onClose={() => setDialog(null)} onSaved={(id) => void loadLists().then(() => setSupplierId(id))} />
      ) : null}
      {dialog?.kind === 'handset' ? (
        <AddHandsetDialog onClose={() => setDialog(null)} onAdded={(variantId) => void loadLists().then(() => update(dialog.lineKey, { variantId }))} />
      ) : null}
      {dialog?.kind === 'item' ? (
        <ItemDialog item={null} onClose={() => setDialog(null)} onSaved={(itemId) => void loadLists().then(() => update(dialog.lineKey, { itemId }))} />
      ) : null}
    </div>
  );
}
