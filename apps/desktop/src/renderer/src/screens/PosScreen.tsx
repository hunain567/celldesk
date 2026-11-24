import type { AccountSummary, CustomerSummary, ItemSummary, PosDevice, SaleDetail, SaleSummary, StockDevice, VariantSummary } from '@nexodesk/shared';
import { CONDITION_LABELS, formatRupees, PTA_LABELS } from '@nexodesk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/dialog';
import { MoneyInput, SearchSelect } from '../components/forms';
import { ReceiptDialog } from '../components/Receipt';
import { useToast } from '../components/toast';
import { Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AccountSelect } from './SuppliersScreen';

type CartLine =
  | { key: string; kind: 'device'; device: PosDevice; unitPrice: number }
  | { key: string; kind: 'item'; itemId: number; name: string; onHand: number; quantity: number; unitPrice: number };

interface Exchange {
  sale: SaleDetail;
  quantities: Record<number, number>;
  reason: string;
}

interface PaymentRow {
  accountId: number;
  amount: number;
  reference: string;
}

let keySeed = 0;
const nextKey = () => `line-${(keySeed += 1)}`;

/** Returned value of the chosen exchange lines, at the price the customer paid. */
function exchangeValue(exchange: Exchange | null): number {
  if (!exchange) return 0;
  return exchange.sale.lines.reduce((sum, line) => sum + line.netUnitPrice * (exchange.quantities[line.id] ?? 0), 0);
}

function NewCustomerDialog({ initialName, onClose, onCreated }: { initialName: string; onClose: () => void; onCreated: (id: number) => void }) {
  const looksLikePhone = /^[\d+\-\s]{7,}$/.test(initialName);
  const [name, setName] = useState(looksLikePhone ? '' : initialName);
  const [phone, setPhone] = useState(looksLikePhone ? initialName : '');
  const [city, setCity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await call('customers:create', { name, phone, city, address: '' });
      onCreated(id);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="New customer"
      description="Needed to leave a balance on account or to find the customer's purchases later."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>Add customer</Button>
        </>
      }
    >
      <Field label="Name">{(id) => <input id={id} className="cd-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} />}</Field>
      <Field label="Mobile number" hint="Used to find the customer next time">
        {(id) => <input id={id} className="cd-input" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />}
      </Field>
      <Field label="City">{(id) => <input id={id} className="cd-input" value={city} onChange={(event) => setCity(event.target.value)} />}</Field>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

/** Picks an IMEI from the handsets in stock for one variant. */
function PickDeviceDialog({ variant, exclude, onClose, onPick }: { variant: VariantSummary; exclude: number[]; onClose: () => void; onPick: (device: StockDevice) => void }) {
  const [devices, setDevices] = useState<StockDevice[] | null>(null);
  useEffect(() => {
    void call('stock:devices', { variantId: variant.id }).then((rows) => setDevices(rows.filter((row) => !exclude.includes(row.id))));
  }, [variant.id, exclude]);
  return (
    <Dialog title={variant.label} description="Choose the handset the customer is taking." onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
      {!devices ? (
        <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>
      ) : devices.length === 0 ? (
        <div className="cd-empty">No more of this handset in stock.</div>
      ) : (
        <div className="cd-pick-list">
          {devices.map((device) => (
            <button key={device.id} type="button" className="cd-pick" onClick={() => onPick(device)}>
              <span className="mono">{device.imei1}</span>
              <span className="cd-cart-line__meta">{CONDITION_LABELS[device.condition]} · {PTA_LABELS[device.ptaStatus]}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Finds an earlier sale and chooses what the customer is giving back. */
function ExchangeDialog({
  initial,
  onClose,
  onConfirm,
}: {
  initial: { saleId: number; imei?: string } | null;
  onClose: () => void;
  onConfirm: (exchange: Exchange) => void;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SaleSummary[] | null>(null);
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (saleId: number, imei?: string) => {
    setError(null);
    try {
      const detail = await call('sales:get', { id: saleId });
      setSale(detail);
      const preselected = detail.lines.find((line) => imei && (line.imei1 === imei || line.imei2 === imei) && line.returnedQuantity < line.quantity);
      setQuantities(preselected ? { [preselected.id]: 1 } : {});
    } catch (openError) {
      setError(errorMessage(openError));
    }
  }, []);

  useEffect(() => {
    if (initial) void open(initial.saleId, initial.imei);
  }, [initial, open]);

  async function search() {
    if (!query.trim()) return;
    setError(null);
    const found = await call('sales:list', { query: query.trim(), limit: 10 });
    if (found.length === 1) void open(found[0]!.id, query.trim());
    else setMatches(found);
  }

  const value = sale ? exchangeValue({ sale, quantities, reason }) : 0;
  const chosen = Object.values(quantities).some((quantity) => quantity > 0);

  return (
    <Dialog
      title="Exchange"
      description="Take back items from an earlier sale. Their value pays for this sale."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!sale || !chosen || !reason.trim()} onClick={() => sale && onConfirm({ sale, quantities, reason: reason.trim() })}>
            Use {formatRupees(value)} for this sale
          </Button>
        </>
      }
    >
      {!sale ? (
        <>
          <form
            className="cd-pos-scan"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <Field label="Receipt number, IMEI or customer phone">
              {(id) => <input id={id} className="cd-input" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />}
            </Field>
            <Button type="submit" variant="primary">Find</Button>
          </form>
          {matches && matches.length === 0 ? <div className="cd-empty">No sale found.</div> : null}
          {matches && matches.length > 1 ? (
            <div className="cd-pick-list">
              {matches.map((match) => (
                <button key={match.id} type="button" className="cd-pick" onClick={() => void open(match.id)}>
                  <span><strong>{match.number}</strong> · {match.saleDate}</span>
                  <span className="cd-cart-line__meta">{match.customerName || 'Walk-in'} · {formatRupees(match.total)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="cd-toolbar" style={{ justifyContent: 'space-between' }}>
            <span><strong>{sale.number}</strong> · {sale.saleDate} · {sale.customerName || 'Walk-in'}</span>
            {!initial ? <Button variant="ghost" onClick={() => setSale(null)}>Another sale</Button> : null}
          </div>
          <div className="cd-pick-list">
            {sale.lines.map((line) => {
              const remaining = line.quantity - line.returnedQuantity;
              const quantity = quantities[line.id] ?? 0;
              return (
                <div key={line.id} className="cd-pick" aria-pressed={quantity > 0} style={{ cursor: 'default', opacity: remaining > 0 ? 1 : 0.5 }}>
                  <span>
                    <strong>{line.description}</strong>
                    <span className="cd-cart-line__meta" style={{ display: 'block' }}>
                      {line.imei1 ? `IMEI ${line.imei1} · ` : ''}paid {formatRupees(line.netUnitPrice)}
                      {remaining <= 0 ? ' · already returned' : ''}
                    </span>
                  </span>
                  {remaining <= 0 ? null : line.kind === 'device' ? (
                    <input type="checkbox" aria-label={`Take back ${line.description}`} checked={quantity > 0} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.checked ? 1 : 0 }))} />
                  ) : (
                    <input
                      className="cd-input num"
                      style={{ width: 80 }}
                      type="number"
                      min={0}
                      max={remaining}
                      aria-label={`Quantity of ${line.description} taken back`}
                      value={quantity}
                      onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: Math.min(remaining, Math.max(0, Number(event.target.value) || 0)) }))}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <Field label="Reason">{(id) => <input id={id} className="cd-input" placeholder="Wants a different model, faulty…" value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
        </>
      )}
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

export function PosScreen() {
  const { can } = useAuth();
  const notify = useToast();
  const scanRef = useRef<HTMLInputElement>(null);
  const [variants, setVariants] = useState<VariantSummary[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [code, setCode] = useState('');
  const [scanMessage, setScanMessage] = useState<{ text: string; saleId?: number; imei?: string } | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  const [discount, setDiscount] = useState(0);
  const [payments, setPayments] = useState<PaymentRow[]>([{ accountId: 1, amount: 0, reference: '' }]);
  const [autoPay, setAutoPay] = useState(true);
  const [received, setReceived] = useState(0);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [refundAccountId, setRefundAccountId] = useState(1);
  const [refundAmount, setRefundAmount] = useState(0);
  const [notes, setNotes] = useState('');

  const [pickVariant, setPickVariant] = useState<VariantSummary | null>(null);
  const [newCustomer, setNewCustomer] = useState<string | null>(null);
  const [exchangeStart, setExchangeStart] = useState<{ saleId: number; imei?: string } | null | false>(false);
  const [receiptFor, setReceiptFor] = useState<number | null>(null);
  const [error, setError] = useState<{ title: string; details?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadLists = useCallback(async () => {
    const [nextVariants, nextItems, nextCustomers, nextAccounts] = await Promise.all([
      call('catalog:variants', {}),
      call('catalog:items', {}),
      call('customers:list', { limit: 500 }),
      call('accounts:list'),
    ]);
    setVariants(nextVariants.filter((variant) => variant.inStock > 0));
    setItems(nextItems.filter((item) => item.onHand > 0));
    setCustomers(nextCustomers);
    setAccounts(nextAccounts);
  }, []);
  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const focusScan = () => window.setTimeout(() => scanRef.current?.focus(), 0);

  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * (line.kind === 'device' ? 1 : line.quantity), 0);
  const total = Math.max(subtotal - discount, 0);
  const ratio = subtotal > 0 ? total / subtotal : 0;
  const credit = exchangeValue(exchange);
  const applied = Math.min(credit, total);
  const due = total - applied;
  const excess = credit - applied;
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const customer = customers.find((entry) => entry.id === customerId) ?? null;
  const cashAccountIds = accounts.filter((account) => account.kind === 'cash').map((account) => account.id);
  const cashPaid = payments.filter((payment) => cashAccountIds.includes(payment.accountId)).reduce((sum, payment) => sum + payment.amount, 0);

  // While the cashier has not typed amounts, one payment row follows the amount due.
  useEffect(() => {
    if (autoPay) setPayments((current) => [{ ...current[0]!, amount: due }]);
  }, [due, autoPay]);
  useEffect(() => {
    setRefundAmount(excess);
  }, [excess]);

  const belowMinimum = (line: CartLine) => line.kind === 'device' && Math.round(line.unitPrice * ratio) < line.device.minSalePrice;
  const blockedByMinimum = !can('sale.belowMinimum') && lines.some(belowMinimum);
  const itemShort = (line: CartLine) =>
    line.kind === 'item' && lines.filter((entry) => entry.kind === 'item' && entry.itemId === line.itemId).reduce((sum, entry) => sum + (entry.kind === 'item' ? entry.quantity : 0), 0) > line.onHand;

  function addDevice(device: PosDevice) {
    if (lines.some((line) => line.kind === 'device' && line.device.id === device.id)) {
      setScanMessage({ text: `IMEI ${device.imei1} is already in this sale.` });
      return;
    }
    setLines((current) => [...current, { key: nextKey(), kind: 'device', device, unitPrice: device.salePrice }]);
    setScanMessage(null);
  }

  function addItem(item: { id: number; name: string; onHand: number; salePrice: number }) {
    setLines((current) => {
      const existing = current.find((line) => line.kind === 'item' && line.itemId === item.id);
      if (existing) return current.map((line) => (line === existing && line.kind === 'item' ? { ...line, quantity: line.quantity + 1 } : line));
      return [...current, { key: nextKey(), kind: 'item', itemId: item.id, name: item.name, onHand: item.onHand, quantity: 1, unitPrice: item.salePrice }];
    });
    setScanMessage(null);
  }

  async function scan() {
    const value = code.trim();
    if (!value) return;
    try {
      const found = await call('pos:lookup', { code: value });
      setCode('');
      if (!found) setScanMessage({ text: `Nothing found for ${value}. Check the IMEI or barcode.` });
      else if (found.kind === 'device') addDevice(found.device);
      else if (found.kind === 'item') addItem(found.item);
      else if (found.kind === 'sold') setScanMessage({ text: found.message, saleId: found.saleId, imei: value });
      else setScanMessage({ text: found.message });
    } catch (scanError) {
      setScanMessage({ text: errorMessage(scanError) });
    }
    focusScan();
  }

  async function pickDevice(variant: VariantSummary, device: StockDevice) {
    setPickVariant(null);
    const found = await call('pos:lookup', { code: device.imei1 });
    if (found?.kind === 'device') addDevice(found.device);
    focusScan();
  }

  function reset() {
    setLines([]);
    setCustomerId(null);
    setWalkInName('');
    setWalkInPhone('');
    setDiscount(0);
    setPayments([{ accountId: cashAccountIds[0] ?? 1, amount: 0, reference: '' }]);
    setAutoPay(true);
    setReceived(0);
    setExchange(null);
    setNotes('');
    setError(null);
    setScanMessage(null);
    void loadLists();
    focusScan();
  }

  const ready =
    lines.length > 0 &&
    !busy &&
    !blockedByMinimum &&
    !lines.some(itemShort) &&
    discount <= subtotal &&
    paid <= due &&
    (customer !== null || paid === due) &&
    (excess === 0 || customer !== null || refundAmount === excess) &&
    refundAmount <= excess;

  async function complete() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call('sales:create', {
        customerId,
        customerName: customer ? '' : walkInName,
        customerPhone: customer ? '' : walkInPhone,
        lines: lines.map((line) =>
          line.kind === 'device'
            ? { kind: 'device' as const, deviceId: line.device.id, unitPrice: line.unitPrice }
            : { kind: 'item' as const, itemId: line.itemId, quantity: line.quantity, unitPrice: line.unitPrice },
        ),
        discount,
        payments: payments.filter((payment) => payment.amount > 0),
        exchange: exchange
          ? {
              saleId: exchange.sale.id,
              lines: Object.entries(exchange.quantities)
                .filter(([, quantity]) => quantity > 0)
                .map(([saleLineId, quantity]) => ({ saleLineId: Number(saleLineId), quantity })),
              reason: exchange.reason,
            }
          : null,
        refund: excess > 0 && refundAmount > 0 ? { accountId: refundAccountId, amount: refundAmount } : null,
        notes,
      });
      notify({ tone: 'success', title: `Sale ${result.number} saved` });
      setReceiptFor(result.id);
    } catch (saveError) {
      const details = (saveError as { error?: { details?: string[] } }).error?.details;
      setError({ title: errorMessage(saveError), ...(details ? { details } : {}) });
    } finally {
      setBusy(false);
    }
  }

  // F9 completes the sale from anywhere on the screen.
  const completeRef = useRef(complete);
  completeRef.current = complete;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'F9') {
        event.preventDefault();
        void completeRef.current();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return (
    <div className="cd-page" style={{ maxWidth: 1320 }}>
      <div className="cd-doc-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 360px' }}>
        <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
          <Panel
            title="Sale"
            actions={
              can('sale.return') ? (
                <Button onClick={() => setExchangeStart(null)} disabled={exchange !== null}>
                  Exchange
                </Button>
              ) : undefined
            }
          >
            <div style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-3) 0' }}>
              <form
                className="cd-pos-scan"
                onSubmit={(event) => {
                  event.preventDefault();
                  void scan();
                }}
              >
                <Field label="Scan IMEI or barcode">
                  {(id) => <input id={id} ref={scanRef} className="cd-input mono" autoFocus autoComplete="off" value={code} onChange={(event) => setCode(event.target.value.slice(0, 64))} />}
                </Field>
                <Button type="submit" variant="primary" disabled={!code.trim()}>Add</Button>
              </form>
              {scanMessage ? (
                <div className="cd-field__error" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                  <span>{scanMessage.text}</span>
                  {scanMessage.saleId && can('sale.return') && !exchange ? (
                    <Button variant="ghost" onClick={() => setExchangeStart({ saleId: scanMessage.saleId!, ...(scanMessage.imei ? { imei: scanMessage.imei } : {}) })}>
                      Take it back in exchange
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <div className="cd-form-grid">
                <Field label="Find handset in stock">
                  {(id) => (
                    <SearchSelect
                      id={id}
                      value={null}
                      placeholder="Brand, model or colour"
                      options={variants.map((variant) => ({ value: variant.id, label: variant.label, hint: `${variant.inStock} in stock · ${formatRupees(variant.salePrice)}` }))}
                      onChange={(value) => setPickVariant(variants.find((variant) => variant.id === value) ?? null)}
                    />
                  )}
                </Field>
                <Field label="Add accessory">
                  {(id) => (
                    <SearchSelect
                      id={id}
                      value={null}
                      placeholder="Name or barcode"
                      options={items.map((item) => ({ value: item.id, label: item.name, hint: `${item.onHand} in stock · ${formatRupees(item.salePrice)}` }))}
                      onChange={(value) => {
                        const item = items.find((entry) => entry.id === value);
                        if (item) addItem(item);
                        focusScan();
                      }}
                    />
                  )}
                </Field>
              </div>
            </div>

            {lines.length === 0 ? (
              <div className="cd-empty">Scan a handset or accessory to start.</div>
            ) : (
              <div>
                {lines.map((line) => (
                  <div key={line.key} className="cd-cart-line">
                    <div>
                      <strong>{line.kind === 'device' ? line.device.label : line.name}</strong>
                      {line.kind === 'device' ? (
                        <div className="cd-cart-line__meta">
                          <span className="mono">{line.device.imei1}</span> · {CONDITION_LABELS[line.device.condition]} · {PTA_LABELS[line.device.ptaStatus]}
                        </div>
                      ) : (
                        <div className="cd-cart-line__meta">{line.onHand} in stock</div>
                      )}
                      {belowMinimum(line) && line.kind === 'device' ? (
                        <div className={can('sale.belowMinimum') ? 'cd-cart-line__warn' : 'cd-cart-line__error'}>
                          Below the minimum price of {formatRupees(line.device.minSalePrice)}
                          {can('sale.belowMinimum') ? '' : '. Ask the owner or a manager.'}
                        </div>
                      ) : null}
                      {itemShort(line) ? <div className="cd-cart-line__error">More than the stock on hand.</div> : null}
                    </div>
                    {line.kind === 'item' ? (
                      <input
                        className="cd-input num"
                        type="number"
                        min={1}
                        aria-label={`Quantity of ${line.name}`}
                        value={line.quantity}
                        onChange={(event) => setLines((current) => current.map((entry) => (entry.key === line.key && entry.kind === 'item' ? { ...entry, quantity: Math.max(1, Number(event.target.value) || 1) } : entry)))}
                      />
                    ) : (
                      <span className="cd-cart-line__meta" style={{ textAlign: 'center' }}>1</span>
                    )}
                    <MoneyInput value={line.unitPrice} onChange={(unitPrice) => setLines((current) => current.map((entry) => (entry.key === line.key ? { ...entry, unitPrice } : entry)))} />
                    <span className="cd-money" style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatRupees(line.unitPrice * (line.kind === 'device' ? 1 : line.quantity))}
                    </span>
                    <Button variant="ghost" aria-label="Remove" onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {exchange ? (
            <Panel
              title={`Taken back from ${exchange.sale.number}`}
              description={exchange.reason}
              actions={<Button variant="ghost" onClick={() => setExchange(null)}>Cancel exchange</Button>}
            >
              <div style={{ padding: 'var(--space-3) 0' }}>
                {exchange.sale.lines
                  .filter((line) => (exchange.quantities[line.id] ?? 0) > 0)
                  .map((line) => (
                    <div key={line.id} className="cd-totals__row">
                      <span>
                        {exchange.quantities[line.id]} × {line.description}
                        {line.imei1 ? <span className="cd-cart-line__meta mono"> {line.imei1}</span> : null}
                      </span>
                      <span className="cd-money">{formatRupees(line.netUnitPrice * (exchange.quantities[line.id] ?? 0))}</span>
                    </div>
                  ))}
              </div>
            </Panel>
          ) : null}
        </div>

        <Panel title="Payment">
          <div className="cd-totals" style={{ padding: 'var(--space-3) 0' }}>
            <Field label="Customer" hint={customer ? `Balance ${formatRupees(customer.balance)}` : 'Leave empty for a walk-in customer'}>
              {(id) => (
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <div style={{ flex: 1 }}>
                    <SearchSelect
                      id={id}
                      value={customerId}
                      placeholder="Name or mobile number"
                      options={customers.map((entry) => ({ value: entry.id, label: entry.name, hint: entry.phone }))}
                      onChange={setCustomerId}
                      onCreate={(text) => setNewCustomer(text)}
                      createLabel="New customer"
                    />
                  </div>
                  {customerId !== null ? <Button variant="ghost" onClick={() => setCustomerId(null)}>Clear</Button> : null}
                </div>
              )}
            </Field>
            {customerId === null ? (
              <div className="cd-form-grid">
                <Field label="Name on receipt">{(id) => <input id={id} className="cd-input" value={walkInName} onChange={(event) => setWalkInName(event.target.value)} />}</Field>
                <Field label="Mobile">{(id) => <input id={id} className="cd-input" inputMode="tel" value={walkInPhone} onChange={(event) => setWalkInPhone(event.target.value)} />}</Field>
              </div>
            ) : null}

            <div className="cd-totals__row"><span>Subtotal</span><span>{formatRupees(subtotal)}</span></div>
            <Field label="Discount on bill" error={discount > subtotal ? 'More than the bill' : null}>
              {(id) => <MoneyInput id={id} value={discount} onChange={setDiscount} />}
            </Field>
            <div className="cd-totals__row cd-totals__row--grand"><span>Total</span><span>{formatRupees(total)}</span></div>
            {exchange ? <div className="cd-totals__row"><span>Exchange credit</span><span>-{formatRupees(applied)}</span></div> : null}
            {exchange ? <div className="cd-totals__row" style={{ fontWeight: 600 }}><span>To pay</span><span>{formatRupees(due)}</span></div> : null}

            {due > 0
              ? payments.map((payment, index) => (
                  <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--space-2)', alignItems: 'end' }}>
                    <Field label={index === 0 ? 'Paid by' : 'And'}>
                      {(id) => (
                        <AccountSelect id={id} accounts={accounts} value={payment.accountId} onChange={(accountId) => setPayments((current) => current.map((entry, position) => (position === index ? { ...entry, accountId } : entry)))} />
                      )}
                    </Field>
                    <Field label="Amount">
                      {(id) => (
                        <MoneyInput
                          id={id}
                          value={payment.amount}
                          onChange={(amount) => {
                            setAutoPay(false);
                            setPayments((current) => current.map((entry, position) => (position === index ? { ...entry, amount } : entry)));
                          }}
                        />
                      )}
                    </Field>
                    {index > 0 ? (
                      <Button variant="ghost" aria-label="Remove payment" onClick={() => setPayments((current) => current.filter((_, position) => position !== index))}>✕</Button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))
              : null}
            {due > 0 && payments.length < 4 ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setAutoPay(false);
                  setPayments((current) => [...current, { accountId: accounts.find((account) => account.kind !== 'cash')?.id ?? 1, amount: Math.max(due - paid, 0), reference: '' }]);
                }}
              >
                + Split payment
              </Button>
            ) : null}
            {due > 0 && paid < due ? (
              <div className={customer ? 'cd-field__hint' : 'cd-field__error'}>
                {customer ? `${formatRupees(due - paid)} will be added to ${customer.name}'s account.` : `${formatRupees(due - paid)} unpaid. Choose a customer to sell on credit.`}
              </div>
            ) : null}
            {paid > due ? <div className="cd-field__error">Payments are more than the amount due.</div> : null}

            {cashPaid > 0 ? (
              <div className="cd-form-grid">
                <Field label="Cash received">{(id) => <MoneyInput id={id} value={received} onChange={setReceived} />}</Field>
                <div className="cd-field">
                  <span className="cd-field__label">Change</span>
                  <strong className="cd-money" style={{ fontSize: 'var(--text-lg)', paddingTop: 6 }}>{received > cashPaid ? formatRupees(received - cashPaid) : '—'}</strong>
                </div>
              </div>
            ) : null}

            {excess > 0 ? (
              <>
                <div className="cd-totals__row" style={{ fontWeight: 600 }}><span>Owed to customer</span><span>{formatRupees(excess)}</span></div>
                <Field label="Refund from">{(id) => <AccountSelect id={id} accounts={accounts} value={refundAccountId} onChange={setRefundAccountId} />}</Field>
                {customer ? (
                  <Field label="Refund amount" hint={refundAmount < excess ? `${formatRupees(excess - refundAmount)} stays on ${customer.name}'s account.` : undefined}>
                    {(id) => <MoneyInput id={id} value={refundAmount} onChange={setRefundAmount} />}
                  </Field>
                ) : null}
              </>
            ) : null}

            <Field label="Notes">{(id) => <input id={id} className="cd-input" value={notes} onChange={(event) => setNotes(event.target.value)} />}</Field>
            <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void complete()}>
              Complete sale (F9)
            </Button>
            {lines.length > 0 ? <Button variant="ghost" onClick={reset}>Clear</Button> : null}
            {error ? (
              <Banner tone="danger" title={error.title}>
                {error.details ? <ul className="cd-list">{error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul> : null}
              </Banner>
            ) : null}
          </div>
        </Panel>
      </div>

      {pickVariant ? (
        <PickDeviceDialog
          variant={pickVariant}
          exclude={lines.flatMap((line) => (line.kind === 'device' ? [line.device.id] : []))}
          onClose={() => setPickVariant(null)}
          onPick={(device) => void pickDevice(pickVariant, device)}
        />
      ) : null}
      {newCustomer !== null ? (
        <NewCustomerDialog
          initialName={newCustomer}
          onClose={() => setNewCustomer(null)}
          onCreated={(id) => {
            setNewCustomer(null);
            void call('customers:list', { limit: 500 }).then((next) => {
              setCustomers(next);
              setCustomerId(id);
            });
          }}
        />
      ) : null}
      {exchangeStart !== false ? (
        <ExchangeDialog
          initial={exchangeStart}
          onClose={() => setExchangeStart(false)}
          onConfirm={(next) => {
            setExchange(next);
            setExchangeStart(false);
            setScanMessage(null);
            if (next.sale.customerId && customerId === null) setCustomerId(next.sale.customerId);
            focusScan();
          }}
        />
      ) : null}
      {receiptFor !== null ? (
        <ReceiptDialog
          saleId={receiptFor}
          reprint={false}
          onClose={() => {
            setReceiptFor(null);
            reset();
          }}
          extraAction={{
            label: 'New sale',
            onClick: () => {
              setReceiptFor(null);
              reset();
            },
          }}
        />
      ) : null}
    </div>
  );
}
