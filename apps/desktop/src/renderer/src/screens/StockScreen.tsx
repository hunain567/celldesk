import type { DeviceDetail, ItemSummary, StockDevice, VariantSummary } from '@nexodesk/shared';
import { CONDITION_LABELS, DEVICE_STATUS_LABELS, formatRupees, PTA_LABELS, WARRANTY_LABELS } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Panel, Properties, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';

const DOC_TYPES: Record<string, string> = { purchase: 'Received (purchase)', purchase_return: 'Returned to supplier' };

/** Everything known about one handset, from either IMEI. */
export function DeviceDialog({ device, onClose }: { device: DeviceDetail; onClose: () => void }) {
  return (
    <Dialog title={device.label} description={`IMEI ${device.imei1}${device.imei2 ? ` · ${device.imei2}` : ''}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <Properties
        items={[
          { label: 'Status', value: <Badge tone={device.status === 'in_stock' ? 'success' : 'neutral'}>{DEVICE_STATUS_LABELS[device.status]}</Badge> },
          { label: 'Condition', value: CONDITION_LABELS[device.condition] },
          { label: 'PTA', value: PTA_LABELS[device.ptaStatus] },
          { label: 'Warranty', value: device.warrantyType === 'none' ? 'None' : `${WARRANTY_LABELS[device.warrantyType]}, ${device.warrantyMonths} months` },
          { label: 'Sale price', value: formatRupees(device.salePrice) },
          ...(device.cost !== null ? [{ label: 'Cost', value: formatRupees(device.cost) }] : []),
          { label: 'Supplier', value: device.supplierName ?? '—' },
          { label: 'Purchase', value: device.purchaseNumber ? `${device.purchaseNumber}, ${device.purchaseDate}` : '—' },
        ]}
      />
      <div>
        <div className="cd-field__label" style={{ marginBottom: 6 }}>History</div>
        <ul className="cd-list">
          {device.history.map((entry, index) => (
            <li key={index}>
              {formatDateTime(entry.at)}: {DOC_TYPES[entry.docType] ?? entry.docType}
              {entry.docNumber ? ` ${entry.docNumber}` : ''} by {entry.createdBy}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/** Search box that opens a handset by IMEI (typed or scanned). */
export function ImeiLookup() {
  const notify = useToast();
  const [imei, setImei] = useState('');
  const [device, setDevice] = useState<DeviceDetail | null>(null);

  async function lookup() {
    const value = imei.trim();
    if (!value) return;
    try {
      const found = await call('stock:lookupImei', { imei: value });
      if (found) {
        setDevice(found);
        setImei('');
      } else {
        notify({ tone: 'danger', title: 'IMEI not found', message: `${value} has never been received in this shop.` });
      }
    } catch (error) {
      notify({ tone: 'danger', title: 'Lookup failed', message: errorMessage(error) });
    }
  }

  return (
    <>
      <form
        className="cd-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <input className="cd-input mono" style={{ width: 240 }} placeholder="Scan or type an IMEI" inputMode="numeric" value={imei} onChange={(event) => setImei(event.target.value.replace(/\D/g, ''))} />
        <Button type="submit" disabled={!imei.trim()}>Find</Button>
      </form>
      {device ? <DeviceDialog device={device} onClose={() => setDevice(null)} /> : null}
    </>
  );
}

function DevicesDialog({ variant, onClose }: { variant: VariantSummary; onClose: () => void }) {
  const [devices, setDevices] = useState<StockDevice[] | null>(null);
  useEffect(() => {
    void call('stock:devices', { variantId: variant.id }).then(setDevices);
  }, [variant.id]);
  return (
    <Dialog title={variant.label} description={`${variant.inStock} in stock`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {!devices ? (
        <span className="cd-spinner" aria-label="Loading" />
      ) : devices.length === 0 ? (
        <div className="cd-empty">None in stock.</div>
      ) : (
        <div className="cd-table-wrap">
          <table className="cd-table">
            <thead>
              <tr>
                <th>IMEI</th>
                <th>Condition</th>
                <th>PTA</th>
                {devices[0]!.cost !== null ? <th className="num">Cost</th> : null}
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td className="mono selectable">{device.imei1}</td>
                  <td>{CONDITION_LABELS[device.condition]}</td>
                  <td>{PTA_LABELS[device.ptaStatus]}</td>
                  {device.cost !== null ? <td className="num">{formatRupees(device.cost)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

export function StockScreen() {
  const [tab, setTab] = useState<'handsets' | 'accessories'>('handsets');
  const [query, setQuery] = useState('');
  const [onlyInStock, setOnlyInStock] = useState(true);
  const [variants, setVariants] = useState<VariantSummary[] | null>(null);
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<VariantSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextVariants, nextItems] = await Promise.all([call('catalog:variants', {}), call('catalog:items', {})]);
      setVariants(nextVariants);
      setItems(nextItems);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger" title="Stock could not be loaded">{error}</Banner>;
  if (!variants || !items) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const showCost = variants.some((variant) => variant.stockValue !== null) || items.some((item) => item.averageCost !== null);
  const visibleVariants = variants.filter((variant) => (!onlyInStock || variant.inStock > 0) && terms.every((term) => variant.label.toLowerCase().includes(term)));
  const visibleItems = items.filter((item) => (!onlyInStock || item.onHand > 0) && terms.every((term) => `${item.name} ${item.category} ${item.barcode ?? ''}`.toLowerCase().includes(term)));
  const handsetCount = variants.reduce((sum, variant) => sum + variant.inStock, 0);
  const stockValue = variants.reduce((sum, variant) => sum + (variant.stockValue ?? 0), 0) + items.reduce((sum, item) => sum + (item.averageCost ?? 0) * Math.max(item.onHand, 0), 0);
  const lowStock = items.filter((item) => item.isActive && item.reorderLevel > 0 && item.onHand <= item.reorderLevel).length;

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <div className="cd-stats">
        <div className="cd-stat"><div className="cd-stat__label">Handsets in stock</div><div className="cd-stat__value num">{handsetCount}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Handset models</div><div className="cd-stat__value num">{variants.filter((variant) => variant.inStock > 0).length}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Accessories low on stock</div><div className="cd-stat__value num">{lowStock}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Stock value at cost</div><div className="cd-stat__value num">{showCost ? formatRupees(stockValue) : '—'}</div></div>
      </div>

      <Panel
        title="Stock"
        actions={<ImeiLookup />}
      >
        <div className="cd-toolbar" style={{ padding: 'var(--space-3) 0' }}>
          <Segmented label="Stock type" value={tab} onChange={setTab} options={[{ value: 'handsets', label: 'Handsets' }, { value: 'accessories', label: 'Accessories' }]} />
          <input className="cd-input" style={{ width: 280 }} placeholder={tab === 'handsets' ? 'Search brand, model, colour' : 'Search name, category, barcode'} value={query} onChange={(event) => setQuery(event.target.value)} />
          <label className="cd-checkbox">
            <input type="checkbox" checked={onlyInStock} onChange={(event) => setOnlyInStock(event.target.checked)} />
            <span>Only items in stock</span>
          </label>
        </div>

        {tab === 'handsets' ? (
          visibleVariants.length === 0 ? (
            <div className="cd-empty">{variants.length === 0 ? 'No handsets yet. Add them in Catalogue or receive them with a purchase.' : 'Nothing matches.'}</div>
          ) : (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>Handset</th>
                    <th className="num">In stock</th>
                    <th className="num">Sale price</th>
                    <th className="num">Minimum price</th>
                    {showCost ? <th className="num">Last cost</th> : null}
                    {showCost ? <th className="num">Value at cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleVariants.map((variant) => (
                    <tr key={variant.id} className="cd-row-click" onClick={() => variant.inStock > 0 && setOpen(variant)}>
                      <td style={{ fontWeight: 600 }}>
                        {variant.label}
                        {!variant.isActive ? <span className="cd-field__hint"> (inactive)</span> : null}
                      </td>
                      <td className="num">{variant.inStock}</td>
                      <td className="num">{formatRupees(variant.salePrice)}</td>
                      <td className="num">{formatRupees(variant.minSalePrice)}</td>
                      {showCost ? <td className="num">{variant.lastCost !== null ? formatRupees(variant.lastCost) : '—'}</td> : null}
                      {showCost ? <td className="num">{formatRupees(variant.stockValue ?? 0)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : visibleItems.length === 0 ? (
          <div className="cd-empty">{items.length === 0 ? 'No accessories yet. Add them in Catalogue.' : 'Nothing matches.'}</div>
        ) : (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Barcode</th>
                  <th className="num">On hand</th>
                  <th className="num">Sale price</th>
                  {showCost ? <th className="num">Average cost</th> : null}
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td>{item.category || '—'}</td>
                    <td className="mono">{item.barcode ?? '—'}</td>
                    <td className="num">
                      {item.onHand}
                      {item.reorderLevel > 0 && item.onHand <= item.reorderLevel ? <> <Badge tone="warning">Low</Badge></> : null}
                    </td>
                    <td className="num">{formatRupees(item.salePrice)}</td>
                    {showCost ? <td className="num">{item.averageCost !== null ? formatRupees(item.averageCost) : '—'}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {open ? <DevicesDialog variant={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
