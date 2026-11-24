import type { AccountSummary, SupplierStatement, SupplierSummary } from '@nexodesk/shared';
import { formatRupees } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/dialog';
import { MoneyInput, todayIso } from '../components/forms';
import { useToast } from '../components/toast';
import { Badge, Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Adds or edits a supplier. New suppliers can start with an amount already owed. */
export function SupplierDialog({ supplier, onClose, onSaved }: { supplier: SupplierSummary | null; onClose: () => void; onSaved: (id: number) => void }) {
  const notify = useToast();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [city, setCity] = useState(supplier?.city ?? '');
  const [address, setAddress] = useState(supplier?.address ?? '');
  const [openingBalance, setOpeningBalance] = useState(0);
  const [isActive, setIsActive] = useState(supplier?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let id = supplier?.id ?? 0;
      if (supplier) await call('suppliers:update', { id: supplier.id, name, phone, city, address, isActive });
      else id = (await call('suppliers:create', { name, phone, city, address, openingBalance })).id;
      notify({ tone: 'success', title: supplier ? 'Supplier saved' : 'Supplier added' });
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
      title={supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>{supplier ? 'Save' : 'Add supplier'}</Button>
        </>
      }
    >
      <Field label="Name">{(id) => <input id={id} className="cd-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} />}</Field>
      <div className="cd-form-grid">
        <Field label="Phone">{(id) => <input id={id} className="cd-input" value={phone} onChange={(event) => setPhone(event.target.value)} />}</Field>
        <Field label="City">{(id) => <input id={id} className="cd-input" value={city} onChange={(event) => setCity(event.target.value)} />}</Field>
      </div>
      <Field label="Address">{(id) => <input id={id} className="cd-input" value={address} onChange={(event) => setAddress(event.target.value)} />}</Field>
      {supplier ? (
        <label className="cd-checkbox">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          <span>Active</span>
        </label>
      ) : (
        <Field label="Amount already owed to this supplier" hint="Opening balance from before NexoDesk. Leave 0 if nothing is owed.">
          {(id) => <MoneyInput id={id} value={openingBalance} onChange={setOpeningBalance} />}
        </Field>
      )}
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

/** Account picker used wherever money moves. */
export function AccountSelect({ id, accounts, value, onChange }: { id: string; accounts: AccountSummary[]; value: number; onChange: (id: number) => void }) {
  return (
    <select id={id} className="cd-select" value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {accounts.filter((account) => account.isActive).map((account) => (
        <option key={account.id} value={account.id}>{account.name}</option>
      ))}
    </select>
  );
}

function PayDialog({ supplier, onClose, onPaid }: { supplier: SupplierSummary; onClose: () => void; onPaid: () => void }) {
  const notify = useToast();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [accountId, setAccountId] = useState(1);
  const [amount, setAmount] = useState(Math.max(supplier.balance, 0));
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call('accounts:list').then(setAccounts);
  }, []);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { number } = await call('suppliers:pay', { supplierId: supplier.id, accountId, amount, paymentDate, reference, notes });
      notify({ tone: 'success', title: `Payment ${number} saved`, message: `${formatRupees(amount)} paid to ${supplier.name}.` });
      onPaid();
      onClose();
    } catch (payError) {
      setError(errorMessage(payError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Pay ${supplier.name}`}
      description={`Currently owed: ${formatRupees(supplier.balance)}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={amount <= 0} onClick={() => void pay()}>Save payment</Button>
        </>
      }
    >
      <div className="cd-form-grid">
        <Field label="Amount">{(id) => <MoneyInput id={id} autoFocus value={amount} onChange={setAmount} />}</Field>
        <Field label="Paid from">{(id) => <AccountSelect id={id} accounts={accounts} value={accountId} onChange={setAccountId} />}</Field>
        <Field label="Date">{(id) => <input id={id} className="cd-input" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />}</Field>
        <Field label="Reference" hint="Cheque, transaction ID">{(id) => <input id={id} className="cd-input" value={reference} onChange={(event) => setReference(event.target.value)} />}</Field>
      </div>
      <Field label="Notes">{(id) => <input id={id} className="cd-input" value={notes} onChange={(event) => setNotes(event.target.value)} />}</Field>
      {amount > supplier.balance && supplier.balance >= 0 ? (
        <Banner tone="warning" title="This is more than the amount owed">The extra becomes an advance with this supplier.</Banner>
      ) : null}
      {error ? <Banner tone="danger" title={error} /> : null}
    </Dialog>
  );
}

function StatementDialog({ supplierId, onClose, onChanged }: { supplierId: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [statement, setStatement] = useState<SupplierStatement | null>(null);
  const [paying, setPaying] = useState(false);
  const load = useCallback(() => call('suppliers:statement', { supplierId }).then(setStatement), [supplierId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!statement) return null;
  const { supplier } = statement;
  return (
    <>
      <div className="cd-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <div className="cd-dialog" role="dialog" aria-modal="true" style={{ width: 'min(860px, calc(100vw - 48px))' }}>
          <div className="cd-dialog__header">
            <h2 className="cd-panel__title">{supplier.name}</h2>
            <p className="cd-panel__description">{[supplier.phone, supplier.city].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="cd-dialog__body">
            <div className="cd-stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <div className="cd-stat">
                <div className="cd-stat__label">{supplier.balance >= 0 ? 'Shop owes' : 'Advance with supplier'}</div>
                <div className="cd-stat__value num">{formatRupees(Math.abs(supplier.balance))}</div>
              </div>
              <div className="cd-stat">
                <div className="cd-stat__label">Last purchase</div>
                <div className="cd-stat__value">{supplier.lastPurchaseDate ?? '—'}</div>
              </div>
            </div>
            {statement.entries.length === 0 ? (
              <div className="cd-empty">No transactions yet.</div>
            ) : (
              <div className="cd-table-wrap" style={{ margin: 0 }}>
                <table className="cd-table">
                  <thead>
                    <tr><th>Date</th><th>Type</th><th>Number</th><th>Details</th><th className="num">Bought</th><th className="num">Paid / returned</th><th className="num">Balance</th></tr>
                  </thead>
                  <tbody>
                    {statement.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{entry.date}</td>
                        <td>{entry.docType}</td>
                        <td className="mono">{entry.docNumber ?? '—'}</td>
                        <td>{entry.memo}</td>
                        <td className="num">{entry.credit ? formatRupees(entry.credit) : ''}</td>
                        <td className="num">{entry.debit ? formatRupees(entry.debit) : ''}</td>
                        <td className="num">{formatRupees(entry.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="cd-dialog__footer">
            <Button onClick={onClose}>Close</Button>
            {can('supplier.pay') ? <Button variant="primary" onClick={() => setPaying(true)}>Pay supplier</Button> : null}
          </div>
        </div>
      </div>
      {paying ? (
        <PayDialog
          supplier={supplier}
          onClose={() => setPaying(false)}
          onPaid={() => {
            void load();
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

export function SuppliersScreen() {
  const { can } = useAuth();
  const [suppliers, setSuppliers] = useState<SupplierSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<SupplierSummary | null | 'new'>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSuppliers(await call('suppliers:list', { includeInactive: true }));
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger" title="Suppliers could not be loaded">{error}</Banner>;
  if (!suppliers) return <div className="cd-center"><span className="cd-spinner" aria-label="Loading" /></div>;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = suppliers.filter((supplier) => (showInactive || supplier.isActive) && terms.every((term) => `${supplier.name} ${supplier.phone} ${supplier.city}`.toLowerCase().includes(term)));
  const totalOwed = suppliers.reduce((sum, supplier) => sum + Math.max(supplier.balance, 0), 0);

  return (
    <div className="cd-page" style={{ maxWidth: 1240 }}>
      <div className="cd-stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="cd-stat"><div className="cd-stat__label">Total owed to suppliers</div><div className="cd-stat__value num">{formatRupees(totalOwed)}</div></div>
        <div className="cd-stat"><div className="cd-stat__label">Suppliers</div><div className="cd-stat__value num">{suppliers.filter((supplier) => supplier.isActive).length}</div></div>
      </div>
      <Panel
        title="Suppliers"
        description="Click a supplier to see the full statement and make a payment."
        actions={can('supplier.manage') ? <Button variant="primary" onClick={() => setEditing('new')}>Add supplier</Button> : undefined}
      >
        <div className="cd-toolbar" style={{ padding: 'var(--space-3) 0' }}>
          <input className="cd-input" style={{ width: 280 }} placeholder="Search name, phone, city" value={query} onChange={(event) => setQuery(event.target.value)} />
          <label className="cd-checkbox"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /><span>Show inactive</span></label>
        </div>
        {shown.length === 0 ? (
          <div className="cd-empty">{suppliers.length === 0 ? 'No suppliers yet.' : 'Nothing matches.'}</div>
        ) : (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr><th>Supplier</th><th>Phone</th><th>City</th><th>Last purchase</th><th className="num">Balance</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {shown.map((supplier) => (
                  <tr key={supplier.id} className="cd-row-click" onClick={() => setViewing(supplier.id)}>
                    <td style={{ fontWeight: 600 }}>
                      {supplier.name} {!supplier.isActive ? <Badge>Inactive</Badge> : null}
                    </td>
                    <td>{supplier.phone || '—'}</td>
                    <td>{supplier.city || '—'}</td>
                    <td>{supplier.lastPurchaseDate ?? '—'}</td>
                    <td className="num">
                      {supplier.balance === 0 ? <Badge tone="success">Settled</Badge> : supplier.balance > 0 ? formatRupees(supplier.balance) : <span title="Advance">{formatRupees(supplier.balance)}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }} onClick={(event) => event.stopPropagation()}>
                      {can('supplier.manage') ? <Button variant="ghost" onClick={() => setEditing(supplier)}>Edit</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {editing ? <SupplierDialog supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void load()} /> : null}
      {viewing !== null ? <StatementDialog supplierId={viewing} onClose={() => setViewing(null)} onChanged={() => void load()} /> : null}
    </div>
  );
}
