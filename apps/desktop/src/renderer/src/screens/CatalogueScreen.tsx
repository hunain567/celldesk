import type { BrandSummary, ItemSummary, VariantSummary } from '@nexodesk/shared';
import { formatRupees } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/dialog';
import { MoneyInput, SearchSelect } from '../components/forms';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel, Segmented } from '../components/ui';
import { call, errorMessage } from '../lib/api';

const RAM_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 16, 24];
const STORAGE_OPTIONS = [8, 16, 32, 64, 128, 256, 512, 1024];

/**
 * Adds a handset variant. Brand and model are picked or created by typing, so
 * a new phone can be added in one step, also from the purchase screen.
 */
export function AddHandsetDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (variantId: number) => void }) {
  const notify = useToast();
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [modelId, setModelId] = useState<number | null>(null);
  const [ramGb, setRamGb] = useState<number | null>(8);
  const [storageGb, setStorageGb] = useState<number | null>(128);
  const [colour, setColour] = useState('');
  const [salePrice, setSalePrice] = useState(0);
  const [minSalePrice, setMinSalePrice] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBrands = useCallback(() => call('catalog:brands').then(setBrands), []);
  useEffect(() => {
    void loadBrands();
  }, [loadBrands]);

  const models = brands.find((brand) => brand.id === brandId)?.models ?? [];

  async function createBrand(name: string) {
    try {
      const { id } = await call('catalog:createBrand', { name });
      await loadBrands();
      setBrandId(id);
      setModelId(null);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  }

  async function createModel(name: string) {
    if (!brandId) return;
    try {
      const { id } = await call('catalog:createModel', { brandId, name });
      await loadBrands();
      setModelId(id);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  }

  async function save() {
    if (!modelId) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await call('catalog:createVariant', { modelId, ramGb, storageGb, colour, salePrice, minSalePrice: minSalePrice || salePrice });
      notify({ tone: 'success', title: 'Handset added' });
      onAdded(id);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Add handset"
      description="Type a brand or model; if it is new, choose Create."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!modelId} onClick={() => void save()}>Add handset</Button>
        </>
      }
    >
      <div className="cd-form-grid">
        <Field label="Brand">
          {(id) => (
            <SearchSelect
              id={id}
              autoFocus
              options={brands.map((brand) => ({ value: brand.id, label: brand.name }))}
              value={brandId}
              onChange={(value) => {
                setBrandId(value);
                setModelId(null);
              }}
              onCreate={(name) => void createBrand(name)}
              createLabel="Create brand"
              placeholder="Samsung, Infinix…"
            />
          )}
        </Field>
        <Field label="Model">
          {(id) =>
            brandId ? (
              <SearchSelect
                id={id}
                options={models.map((model) => ({ value: model.id, label: model.name }))}
                value={modelId}
                onChange={setModelId}
                onCreate={(name) => void createModel(name)}
                createLabel="Create model"
                placeholder="Galaxy A55…"
              />
            ) : (
              <input id={id} className="cd-input" disabled placeholder="Choose the brand first" />
            )
          }
        </Field>
        <Field label="RAM">
          {(id) => (
            <select id={id} className="cd-select" value={ramGb ?? ''} onChange={(event) => setRamGb(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Not shown</option>
              {RAM_OPTIONS.map((value) => (
                <option key={value} value={value}>{value} GB</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Storage">
          {(id) => (
            <select id={id} className="cd-select" value={storageGb ?? ''} onChange={(event) => setStorageGb(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Not shown</option>
              {STORAGE_OPTIONS.map((value) => (
                <option key={value} value={value}>{value >= 1024 ? '1 TB' : `${value} GB`}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Colour" hint="Leave empty if colour does not matter">
          {(id) => <input id={id} className="cd-input" value={colour} onChange={(event) => setColour(event.target.value)} />}
        </Field>
        <div />
        <Field label="Sale price">{(id) => <MoneyInput id={id} value={salePrice} onChange={setSalePrice} />}</Field>
        <Field label="Minimum sale price" hint="Salesmen cannot sell below this. Empty = sale price.">
          {(id) => <MoneyInput id={id} value={minSalePrice} onChange={setMinSalePrice} />}
        </Field>
      </div>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

function EditHandsetDialog({ variant, onClose, onSaved }: { variant: VariantSummary; onClose: () => void; onSaved: () => void }) {
  const notify = useToast();
  const [salePrice, setSalePrice] = useState(variant.salePrice);
  const [minSalePrice, setMinSalePrice] = useState(variant.minSalePrice);
  const [isActive, setIsActive] = useState(variant.isActive);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await call('catalog:updateVariant', { id: variant.id, salePrice, minSalePrice, isActive });
      notify({ tone: 'success', title: 'Prices saved' });
      onSaved();
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={variant.label}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className="cd-form-grid">
        <Field label="Sale price">{(id) => <MoneyInput id={id} autoFocus value={salePrice} onChange={setSalePrice} />}</Field>
        <Field label="Minimum sale price">{(id) => <MoneyInput id={id} value={minSalePrice} onChange={setMinSalePrice} />}</Field>
      </div>
      <label className="cd-checkbox">
        <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
        <span>Active. Inactive handsets are hidden when buying and selling; stock and history stay.</span>
      </label>
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

/** Adds or edits an accessory. */
export function ItemDialog({ item, onClose, onSaved }: { item: ItemSummary | null; onClose: () => void; onSaved: (itemId: number) => void }) {
  const notify = useToast();
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [barcode, setBarcode] = useState(item?.barcode ?? '');
  const [salePrice, setSalePrice] = useState(item?.salePrice ?? 0);
  const [reorderLevel, setReorderLevel] = useState(item?.reorderLevel ?? 0);
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const values = { name, category, barcode: barcode.trim() || null, salePrice, reorderLevel };
      let id = item?.id ?? 0;
      if (item) await call('catalog:updateItem', { ...values, id: item.id, isActive });
      else id = (await call('catalog:createItem', values)).id;
      notify({ tone: 'success', title: item ? 'Item saved' : 'Item added' });
      onSaved(id);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={item ? `Edit ${item.name}` : 'Add accessory'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>{item ? 'Save' : 'Add item'}</Button>
        </>
      }
    >
      <Field label="Name">{(id) => <input id={id} className="cd-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} />}</Field>
      <div className="cd-form-grid">
        <Field label="Category" hint="For example Covers, Chargers, Handsfree">
          {(id) => <input id={id} className="cd-input" value={category} onChange={(event) => setCategory(event.target.value)} />}
        </Field>
        <Field label="Barcode" hint="Scan the product barcode">
          {(id) => <input id={id} className="cd-input mono" value={barcode} onChange={(event) => setBarcode(event.target.value.trim())} />}
        </Field>
        <Field label="Sale price">{(id) => <MoneyInput id={id} value={salePrice} onChange={setSalePrice} />}</Field>
        <Field label="Low-stock alert at" hint="0 = no alert">
          {(id) => <input id={id} className="cd-input num" type="number" min={0} value={reorderLevel} onChange={(event) => setReorderLevel(Math.max(0, Number(event.target.value) || 0))} />}
        </Field>
      </div>
      {item ? (
        <label className="cd-checkbox">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          <span>Active</span>
        </label>
      ) : null}
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

export function CatalogueScreen() {
  const [tab, setTab] = useState<'handsets' | 'accessories'>('handsets');
  const [query, setQuery] = useState('');
  const [variants, setVariants] = useState<VariantSummary[] | null>(null);
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'add-handset' } | { kind: 'edit-handset'; variant: VariantSummary } | { kind: 'item'; item: ItemSummary | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextVariants, nextItems] = await Promise.all([
        call('catalog:variants', { includeInactive: true }),
        call('catalog:items', { includeInactive: true }),
      ]);
      setVariants(nextVariants);
      setItems(nextItems);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger" title="Catalogue could not be loaded">{error}</Banner>;
  if (!variants || !items) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shownVariants = variants.filter((variant) => terms.every((term) => variant.label.toLowerCase().includes(term)));
  const shownItems = items.filter((item) => terms.every((term) => `${item.name} ${item.category} ${item.barcode ?? ''}`.toLowerCase().includes(term)));

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <Panel
        title="Catalogue"
        description="Handsets are tracked one by one by IMEI. Accessories are counted by quantity."
        actions={
          tab === 'handsets' ? (
            <Button variant="primary" onClick={() => setDialog({ kind: 'add-handset' })}>Add handset</Button>
          ) : (
            <Button variant="primary" onClick={() => setDialog({ kind: 'item', item: null })}>Add accessory</Button>
          )
        }
      >
        <div className="cd-toolbar" style={{ padding: 'var(--space-3) 0' }}>
          <Segmented label="Catalogue type" value={tab} onChange={setTab} options={[{ value: 'handsets', label: `Handsets (${variants.length})` }, { value: 'accessories', label: `Accessories (${items.length})` }]} />
          <input className="cd-input" style={{ width: 280 }} placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {tab === 'handsets' ? (
          shownVariants.length === 0 ? (
            <div className="cd-empty">{variants.length === 0 ? 'No handsets yet. Add the first one.' : 'Nothing matches.'}</div>
          ) : (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr><th>Handset</th><th className="num">Sale price</th><th className="num">Minimum price</th><th className="num">In stock</th><th>Status</th><th aria-label="Actions" /></tr>
                </thead>
                <tbody>
                  {shownVariants.map((variant) => (
                    <tr key={variant.id}>
                      <td style={{ fontWeight: 600 }}>{variant.label}</td>
                      <td className="num">{formatRupees(variant.salePrice)}</td>
                      <td className="num">{formatRupees(variant.minSalePrice)}</td>
                      <td className="num">{variant.inStock}</td>
                      <td>{variant.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</td>
                      <td style={{ textAlign: 'right' }}><Button variant="ghost" onClick={() => setDialog({ kind: 'edit-handset', variant })}>Edit prices</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : shownItems.length === 0 ? (
          <div className="cd-empty">{items.length === 0 ? 'No accessories yet. Add the first one.' : 'Nothing matches.'}</div>
        ) : (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr><th>Item</th><th>Category</th><th>Barcode</th><th className="num">Sale price</th><th className="num">On hand</th><th>Status</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {shownItems.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td>{item.category || '—'}</td>
                    <td className="mono">{item.barcode ?? '—'}</td>
                    <td className="num">{formatRupees(item.salePrice)}</td>
                    <td className="num">{item.onHand}</td>
                    <td>{item.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td style={{ textAlign: 'right' }}><Button variant="ghost" onClick={() => setDialog({ kind: 'item', item })}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {dialog?.kind === 'add-handset' ? <AddHandsetDialog onClose={() => setDialog(null)} onAdded={() => void load()} /> : null}
      {dialog?.kind === 'edit-handset' ? <EditHandsetDialog variant={dialog.variant} onClose={() => setDialog(null)} onSaved={() => void load()} /> : null}
      {dialog?.kind === 'item' ? <ItemDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={() => void load()} /> : null}
    </div>
  );
}
