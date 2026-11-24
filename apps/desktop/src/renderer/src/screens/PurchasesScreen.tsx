import type { PurchaseDetail, PurchaseReturnSummary, PurchaseSummary } from '@nexodesk/shared';
import { DEVICE_STATUS_LABELS, formatRupees } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/dialog';
import { Badge, Banner, Button, Panel, Properties, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { PurchaseForm } from './PurchaseForm';
import { ReturnForm } from './ReturnForm';

function PurchaseDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { can } = useAuth();
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  useEffect(() => {
    void call('purchases:get', { id }).then(setDetail);
  }, [id]);
  if (!detail) return null;
  const showCost = can('cost.view');
  return (
    <div className="cd-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cd-dialog" role="dialog" aria-modal="true" style={{ width: 'min(860px, calc(100vw - 48px))' }}>
        <div className="cd-dialog__header">
          <h2 className="cd-panel__title">Purchase {detail.number}</h2>
          <p className="cd-panel__description">{detail.supplierName} · {detail.purchaseDate}</p>
        </div>
        <div className="cd-dialog__body">
          <Properties
            items={[
              { label: "Supplier's invoice", value: detail.supplierInvoiceNo || '—' },
              ...(showCost
                ? [
                    { label: 'Subtotal', value: formatRupees(detail.subtotal) },
                    { label: 'Discount', value: formatRupees(detail.discount) },
                    { label: 'Total', value: <strong>{formatRupees(detail.total)}</strong> },
                    { label: 'Paid with purchase', value: formatRupees(detail.paid) },
                  ]
                : []),
              { label: 'Entered by', value: `${detail.createdBy}, ${formatDateTime(detail.createdAt)}` },
              ...(detail.notes ? [{ label: 'Notes', value: detail.notes }] : []),
            ]}
          />
          {detail.lines.map((line) => (
            <div key={line.lineNo} className="cd-line">
              <div className="cd-line__head">
                <strong>{line.description}</strong>
                <span className="cd-money">
                  {line.quantity} × {showCost ? formatRupees(line.unitCost) : ''} {showCost ? `= ${formatRupees(line.lineTotal)}` : ''}
                </span>
              </div>
              {line.devices.length > 0 ? (
                <div className="cd-imei-list">
                  {line.devices.map((device) => (
                    <span key={device.id} className="cd-imei-chip selectable" title={DEVICE_STATUS_LABELS[device.status]}>
                      {device.imei1}
                      {device.status !== 'in_stock' ? ` · ${DEVICE_STATUS_LABELS[device.status]}` : ''}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="cd-dialog__footer"><Button onClick={onClose}>Close</Button></div>
      </div>
    </div>
  );
}

export function PurchasesScreen() {
  const { can } = useAuth();
  const [mode, setMode] = useState<'list' | 'new-purchase' | 'new-return'>('list');
  const [tab, setTab] = useState<'purchases' | 'returns'>('purchases');
  const [query, setQuery] = useState('');
  const [purchases, setPurchases] = useState<PurchaseSummary[] | null>(null);
  const [returns, setReturns] = useState<PurchaseReturnSummary[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextPurchases, nextReturns] = await Promise.all([
        call('purchases:list', { limit: 200, ...(query.trim() ? { query: query.trim() } : {}) }),
        call('purchaseReturns:list', { limit: 200 }),
      ]);
      setPurchases(nextPurchases);
      setReturns(nextReturns);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (mode === 'new-purchase') {
    return (
      <PurchaseForm
        onCancel={() => setMode('list')}
        onDone={(id) => {
          setMode('list');
          setOpen(id);
          void load();
        }}
      />
    );
  }
  if (mode === 'new-return') {
    return (
      <ReturnForm
        onCancel={() => setMode('list')}
        onDone={() => {
          setMode('list');
          setTab('returns');
          void load();
        }}
      />
    );
  }

  if (error) return <Banner tone="danger" title="Purchases could not be loaded">{error}</Banner>;
  if (!purchases || !returns) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;
  const showCost = can('cost.view');

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <Panel
        title="Purchases"
        description="Saved purchases cannot be edited. To correct one, return the stock and enter a new purchase."
        actions={
          <>
            {can('purchase.return') ? <Button onClick={() => setMode('new-return')}>Return to supplier</Button> : null}
            {can('purchase.create') ? <Button variant="primary" onClick={() => setMode('new-purchase')}>New purchase</Button> : null}
          </>
        }
      >
        <div className="cd-toolbar" style={{ padding: 'var(--space-3) 0' }}>
          <Segmented label="List" value={tab} onChange={setTab} options={[{ value: 'purchases', label: 'Purchases' }, { value: 'returns', label: 'Returns' }]} />
          {tab === 'purchases' ? (
            <input className="cd-input" style={{ width: 320 }} placeholder="Search number, supplier, invoice or IMEI" value={query} onChange={(event) => setQuery(event.target.value)} />
          ) : null}
        </div>
        {tab === 'purchases' ? (
          purchases.length === 0 ? (
            <div className="cd-empty">{query ? 'Nothing matches.' : 'No purchases yet.'}</div>
          ) : (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Number</th><th>Date</th><th>Supplier</th><th>Invoice</th><th className="num">Units</th>
                    {showCost ? <th className="num">Total</th> : null}
                    {showCost ? <th>Payment</th> : null}
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((purchase) => (
                    <tr key={purchase.id} className="cd-row-click" onClick={() => setOpen(purchase.id)}>
                      <td className="mono">{purchase.number}</td>
                      <td>{purchase.purchaseDate}</td>
                      <td style={{ fontWeight: 600 }}>{purchase.supplierName}</td>
                      <td>{purchase.supplierInvoiceNo || '—'}</td>
                      <td className="num">{purchase.units}</td>
                      {showCost ? <td className="num">{formatRupees(purchase.total)}</td> : null}
                      {showCost ? (
                        <td>
                          {purchase.paid >= purchase.total ? <Badge tone="success">Paid</Badge> : purchase.paid > 0 ? <Badge tone="warning">Part paid</Badge> : <Badge>On credit</Badge>}
                        </td>
                      ) : null}
                      <td>{purchase.createdBy}</td>
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
                <tr><th>Number</th><th>Date</th><th>Supplier</th><th className="num">Units</th>{showCost ? <th className="num">Value</th> : null}<th>Reason</th><th>By</th></tr>
              </thead>
              <tbody>
                {returns.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.number}</td>
                    <td>{entry.returnDate}</td>
                    <td style={{ fontWeight: 600 }}>{entry.supplierName}</td>
                    <td className="num">{entry.units}</td>
                    {showCost ? <td className="num">{formatRupees(entry.total)}</td> : null}
                    <td>{entry.reason}</td>
                    <td>{entry.createdBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {open !== null ? <PurchaseDialog id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
