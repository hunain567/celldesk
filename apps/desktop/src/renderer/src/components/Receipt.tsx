import type { ReceiptPaper, SaleDetail, ShopProfile } from '@nexodesk/shared';
import { CONDITION_LABELS, formatRupees, PTA_LABELS, WARRANTY_LABELS } from '@nexodesk/shared';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { call, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Dialog } from './dialog';
import { Banner, Button, Segmented } from './ui';

function warrantyText(line: SaleDetail['lines'][number]): string | null {
  if (line.kind !== 'device' || !line.warrantyType) return null;
  if (line.warrantyType === 'none') return 'No warranty';
  return `${WARRANTY_LABELS[line.warrantyType]} warranty, ${line.warrantyMonths} months`;
}

/** The printed receipt. The same markup is used for the preview and for printing. */
export function Receipt({ sale, shop, paper, reprint }: { sale: SaleDetail; shop: ShopProfile | null; paper: ReceiptPaper; reprint: boolean }) {
  const row = (label: string, value: string, strong = false) => (
    <div className={`cd-receipt__row${strong ? ' cd-receipt__row--strong' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
  const due = sale.due;
  return (
    <div className={`cd-receipt cd-receipt--${paper}`}>
      <div className="cd-receipt__shop">
        <strong>{shop?.shopName ?? 'Shop'}</strong>
        {shop?.address || shop?.city ? <div>{[shop.address, shop.city].filter(Boolean).join(', ')}</div> : null}
        {shop?.phone ? <div>{shop.phone}</div> : null}
      </div>
      <div className="cd-receipt__title">{reprint ? 'Sale receipt (copy)' : 'Sale receipt'}</div>
      {row('Receipt', sale.number)}
      {row('Date', formatDateTime(sale.createdAt))}
      {row('Served by', sale.createdBy)}
      {sale.customerName ? row('Customer', sale.customerPhone ? `${sale.customerName}, ${sale.customerPhone}` : sale.customerName) : null}
      <div className="cd-receipt__rule" />
      {sale.lines.map((line) => (
        <div key={line.id} className="cd-receipt__line">
          <div className="cd-receipt__desc">{line.description}</div>
          {line.imei1 ? <div className="cd-receipt__meta">IMEI {line.imei1}{line.imei2 ? ` / ${line.imei2}` : ''}</div> : null}
          {line.kind === 'device' && line.condition && line.ptaStatus ? (
            <div className="cd-receipt__meta">{CONDITION_LABELS[line.condition]} · {PTA_LABELS[line.ptaStatus]}</div>
          ) : null}
          {warrantyText(line) ? <div className="cd-receipt__meta">{warrantyText(line)}</div> : null}
          {row(`${line.quantity} × ${formatRupees(line.unitPrice)}`, formatRupees(line.lineTotal))}
        </div>
      ))}
      <div className="cd-receipt__rule" />
      {sale.discount > 0 ? row('Subtotal', formatRupees(sale.subtotal)) : null}
      {sale.discount > 0 ? row('Discount', `-${formatRupees(sale.discount)}`) : null}
      {row('Total', formatRupees(sale.total), true)}
      {sale.exchangeCredit > 0 ? row(`Exchange (${sale.exchangeReturnNumber ?? ''})`, `-${formatRupees(sale.exchangeCredit)}`) : null}
      {sale.payments.map((payment, index) => (
        <div key={index}>{row(`Paid, ${payment.accountName}${payment.reference ? ` (${payment.reference})` : ''}`, formatRupees(payment.amount))}</div>
      ))}
      {sale.exchangeRefund > 0 ? row('Refunded to customer', formatRupees(sale.exchangeRefund)) : null}
      {due > 0 ? row('Balance on account', formatRupees(due), true) : null}
      {shop?.receiptFooter ? <div className="cd-receipt__footer">{shop.receiptFooter}</div> : null}
      <div className="cd-receipt__footer">Thank you for shopping with us.</div>
    </div>
  );
}

/** Shows a sale's receipt with print and paper choice. */
export function ReceiptDialog({
  saleId,
  reprint,
  onClose,
  extraAction,
}: {
  saleId: number;
  reprint: boolean;
  onClose: () => void;
  extraAction?: { label: string; onClick: () => void };
}) {
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [shop, setShop] = useState<ShopProfile | null>(null);
  const [paper, setPaper] = useState<ReceiptPaper>('80mm');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([call('sales:get', { id: saleId }), call('shop:get'), call('settings:get', { key: 'pos.receiptPaper' })])
      .then(([nextSale, nextShop, nextPaper]) => {
        setSale(nextSale);
        setShop(nextShop);
        setPaper(nextPaper as ReceiptPaper);
      })
      .catch((loadError) => setError(errorMessage(loadError)));
  }, [saleId]);

  function choosePaper(next: ReceiptPaper) {
    setPaper(next);
    void call('settings:set', { key: 'pos.receiptPaper', value: next });
  }

  return (
    <Dialog
      title={sale ? `Receipt ${sale.number}` : 'Receipt'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {extraAction ? <Button onClick={extraAction.onClick}>{extraAction.label}</Button> : null}
          <Button variant="primary" disabled={!sale} onClick={() => window.print()}>
            Print
          </Button>
        </>
      }
    >
      {error ? <Banner tone="danger" title="The receipt could not be loaded">{error}</Banner> : null}
      <Segmented
        label="Paper"
        value={paper}
        onChange={choosePaper}
        options={[
          { value: '80mm', label: 'Receipt printer (80 mm)' },
          { value: 'a4', label: 'A4 page' },
        ]}
      />
      {sale ? (
        <div className="cd-receipt-preview">
          <Receipt sale={sale} shop={shop} paper={paper} reprint={reprint} />
        </div>
      ) : (
        <div className="cd-center">
          <span className="cd-spinner" aria-label="Loading" />
        </div>
      )}
      {sale
        ? createPortal(
            <div className="cd-print-area">
              <style>{`@page { size: ${paper === '80mm' ? '80mm auto' : 'A4'}; margin: ${paper === '80mm' ? '3mm' : '15mm'}; }`}</style>
              <Receipt sale={sale} shop={shop} paper={paper} reprint={reprint} />
            </div>,
            document.body,
          )
        : null}
    </Dialog>
  );
}
