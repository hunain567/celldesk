import type { AccountSummary, SaleDetail, SaleReturnSummary, SaleSummary } from '@nexodesk/shared';
import { formatRupees, WARRANTY_LABELS } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/dialog';
import { MoneyInput } from '../components/forms';
import { ReceiptDialog } from '../components/Receipt';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel, Properties, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { AccountSelect } from './SuppliersScreen';

/** Takes items back from a sale and refunds or credits the customer. */
function SaleReturnDialog({ sale, onClose, onDone }: { sale: SaleDetail; onClose: () => void; onDone: () => void }) {
  const notify = useToast();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [accountId, setAccountId] = useState(1);
  const [refund, setRefund] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call('accounts:list').then(setAccounts);
  }, []);

  const value = sale.lines.reduce((sum, line) => sum + line.netUnitPrice * (quantities[line.id] ?? 0), 0);
  useEffect(() => setRefund(value), [value]);
  const hasCustomer = sale.customerId !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { number } = await call('saleReturns:create', {
        saleId: sale.id,
        lines: Object.entries(quantities)
          .filter(([, quantity]) => quantity > 0)
          .map(([saleLineId, quantity]) => ({ saleLineId: Number(saleLineId), quantity })),
        reason,
        refund: refund > 0 ? { accountId, amount: refund } : null,
      });
      notify({ tone: 'success', title: `Return ${number} saved`, message: 'The items are back in stock.' });
      onDone();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Return from ${sale.number}`}
      description="Items go back into stock at the price the customer paid."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={value === 0 || !reason.trim() || refund > value || (!hasCustomer && refund !== value)} onClick={() => void save()}>
            Save return
          </Button>
        </>
      }
    >
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
                <input type="checkbox" aria-label={`Return ${line.description}`} checked={quantity > 0} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.checked ? 1 : 0 }))} />
              ) : (
                <input
                  className="cd-input num"
                  style={{ width: 80 }}
                  type="number"
                  min={0}
                  max={remaining}
                  aria-label={`Quantity of ${line.description} returned`}
                  value={quantity}
                  onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: Math.min(remaining, Math.max(0, Number(event.target.value) || 0)) }))}
                />
              )}
            </div>
          );
        })}
      </div>
      <Field label="Reason">{(id) => <input id={id} className="cd-input" placeholder="Faulty, changed mind…" value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
      <div className="cd-totals__row" style={{ fontWeight: 600 }}><span>Value of return</span><span>{formatRupees(value)}</span></div>
      <div className="cd-form-grid">
        <Field label="Refund from">{(id) => <AccountSelect id={id} accounts={accounts} value={accountId} onChange={setAccountId} />}</Field>
        <Field
          label="Refund amount"
          error={refund > value ? 'More than the value of the return' : null}
          hint={hasCustomer ? (refund < value ? `${formatRupees(value - refund)} is credited to ${sale.customerName}'s account.` : undefined) : 'A walk-in sale is refunded in full.'}
        >
          {(id) => (hasCustomer ? <MoneyInput id={id} value={refund} onChange={setRefund} /> : <input id={id} className="cd-input num" readOnly value={formatRupees(value)} />)}
        </Field>
      </div>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

function SaleDialog({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [mode, setMode] = useState<'view' | 'receipt' | 'return'>('view');
  const load = useCallback(() => void call('sales:get', { id }).then(setSale), [id]);
  useEffect(load, [load]);
  if (!sale) return null;
  if (mode === 'receipt') return <ReceiptDialog saleId={sale.id} reprint onClose={() => setMode('view')} />;
  if (mode === 'return') {
    return (
      <SaleReturnDialog
        sale={sale}
        onClose={() => setMode('view')}
        onDone={() => {
          setMode('view');
          load();
          onChanged();
        }}
      />
    );
  }
  const canReturn = can('sale.return') && sale.lines.some((line) => line.returnedQuantity < line.quantity);
  return (
    <Dialog
      title={`Sale ${sale.number}`}
      description={`${sale.customerName || 'Walk-in customer'} · ${formatDateTime(sale.createdAt)} · ${sale.createdBy}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {canReturn ? <Button variant="danger" onClick={() => setMode('return')}>Return items</Button> : null}
          <Button variant="primary" onClick={() => setMode('receipt')}>Print receipt</Button>
        </>
      }
    >
      <Properties
        items={[
          ...(sale.customerPhone ? [{ label: 'Mobile', value: sale.customerPhone }] : []),
          ...(sale.discount > 0 ? [{ label: 'Discount', value: formatRupees(sale.discount) }] : []),
          { label: 'Total', value: <strong>{formatRupees(sale.total)}</strong> },
          ...(sale.exchangeCredit > 0 ? [{ label: 'Exchange credit', value: `${formatRupees(sale.exchangeCredit)} (${sale.exchangeReturnNumber})` }] : []),
          { label: 'Paid', value: sale.payments.length ? sale.payments.map((payment) => `${payment.accountName} ${formatRupees(payment.amount)}`).join(', ') : '—' },
          ...(sale.due > 0 ? [{ label: 'On account', value: <Badge tone="warning">{formatRupees(sale.due)}</Badge> }] : []),
          ...(sale.profit !== null ? [{ label: 'Profit', value: formatRupees(sale.profit) }] : []),
          ...(sale.notes ? [{ label: 'Notes', value: sale.notes }] : []),
        ]}
      />
      {sale.lines.map((line) => (
        <div key={line.id} className="cd-line">
          <div className="cd-line__head">
            <strong>{line.description}</strong>
            <span className="cd-money">{line.quantity} × {formatRupees(line.unitPrice)}</span>
          </div>
          <div className="cd-cart-line__meta">
            {line.imei1 ? <span className="mono">IMEI {line.imei1}{line.imei2 ? ` / ${line.imei2}` : ''} · </span> : null}
            {line.warrantyType && line.warrantyType !== 'none' ? `${WARRANTY_LABELS[line.warrantyType]} warranty ${line.warrantyMonths} months · ` : ''}
            {line.unitCost !== null ? `cost ${formatRupees(line.unitCost)}` : ''}
            {line.returnedQuantity > 0 ? <Badge tone="warning">{line.kind === 'device' ? 'Returned' : `${line.returnedQuantity} returned`}</Badge> : null}
          </div>
        </div>
      ))}
      {sale.returns.length > 0 ? (
        <div className="cd-field__hint">
          Returns: {sale.returns.map((entry) => `${entry.number} (${formatRupees(entry.total)}${entry.refunded ? `, ${formatRupees(entry.refunded)} refunded` : ''})`).join(', ')}
        </div>
      ) : null}
    </Dialog>
  );
}

export function SalesScreen() {
  const [tab, setTab] = useState<'sales' | 'returns'>('sales');
  const [query, setQuery] = useState('');
  const [sales, setSales] = useState<SaleSummary[] | null>(null);
  const [returns, setReturns] = useState<SaleReturnSummary[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextSales, nextReturns] = await Promise.all([
        call('sales:list', { limit: 300, ...(query.trim() ? { query: query.trim() } : {}) }),
        call('saleReturns:list', { limit: 300 }),
      ]);
      setSales(nextSales);
      setReturns(nextReturns);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (error) return <Banner tone="danger" title="Sales could not be loaded">{error}</Banner>;
  if (!sales || !returns) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <Panel title="Sales" description="Saved sales cannot be edited. Use a return or an exchange to correct one.">
        <div className="cd-toolbar" style={{ padding: 'var(--space-3) 0' }}>
          <Segmented label="List" value={tab} onChange={setTab} options={[{ value: 'sales', label: 'Sales' }, { value: 'returns', label: 'Returns' }]} />
          {tab === 'sales' ? (
            <input className="cd-input" style={{ width: 340 }} placeholder="Search receipt number, customer, mobile or IMEI" value={query} onChange={(event) => setQuery(event.target.value)} />
          ) : null}
        </div>
        {tab === 'sales' ? (
          sales.length === 0 ? (
            <div className="cd-empty">{query ? 'Nothing matches.' : 'No sales yet.'}</div>
          ) : (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr><th>Receipt</th><th>Date</th><th>Customer</th><th className="num">Units</th><th className="num">Total</th><th>Payment</th><th>By</th></tr>
                </thead>
                <tbody>
                  {sales.map((sale) => (
                    <tr key={sale.id} className="cd-row-click" onClick={() => setOpen(sale.id)}>
                      <td className="mono">{sale.number}</td>
                      <td>{formatDateTime(sale.createdAt)}</td>
                      <td style={{ fontWeight: 600 }}>{sale.customerName || 'Walk-in'}</td>
                      <td className="num">{sale.units}</td>
                      <td className="num">{formatRupees(sale.total)}</td>
                      <td>
                        {sale.due > 0 ? <Badge tone="warning">{formatRupees(sale.due)} on account</Badge> : <Badge tone="success">Paid</Badge>}{' '}
                        {sale.exchangeCredit > 0 ? <Badge>Exchange</Badge> : null} {sale.hasReturns ? <Badge tone="danger">Returned</Badge> : null}
                      </td>
                      <td>{sale.createdBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : returns.length === 0 ? (
          <div className="cd-empty">No returns yet.</div>
        ) : (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr><th>Number</th><th>Date</th><th>From sale</th><th>Customer</th><th className="num">Units</th><th className="num">Value</th><th>Settled</th><th>Reason</th><th>By</th></tr>
              </thead>
              <tbody>
                {returns.map((entry) => (
                  <tr key={entry.id} className="cd-row-click" onClick={() => setOpen(entry.saleId)}>
                    <td className="mono">{entry.number}</td>
                    <td>{entry.returnDate}</td>
                    <td className="mono">{entry.saleNumber}</td>
                    <td>{entry.customerName || 'Walk-in'}</td>
                    <td className="num">{entry.units}</td>
                    <td className="num">{formatRupees(entry.total)}</td>
                    <td>{entry.exchangeSaleNumber ? `Exchange ${entry.exchangeSaleNumber}` : entry.refunded > 0 ? `Refund ${formatRupees(entry.refunded)}` : 'On account'}</td>
                    <td>{entry.reason}</td>
                    <td>{entry.createdBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {open !== null ? <SaleDialog id={open} onClose={() => setOpen(null)} onChanged={() => void load()} /> : null}
    </div>
  );
}
