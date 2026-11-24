import type { PurchaseDetail } from '@nexodesk/shared';
import type { CatalogService } from '../services/catalog';
import type { PurchasingService } from '../services/purchasing';
import type { SessionManager } from '../services/session';
import type { IpcRouter } from './router';

export interface InventoryHandlerDependencies {
  catalog: CatalogService;
  purchasing: PurchasingService;
  session: SessionManager;
}

/** Hides unit costs from users who may not see cost prices. */
function withoutCosts(detail: PurchaseDetail): PurchaseDetail {
  return {
    ...detail,
    subtotal: 0,
    discount: 0,
    total: 0,
    paid: 0,
    lines: detail.lines.map((line) => ({ ...line, unitCost: 0, lineTotal: 0 })),
  };
}

export function registerInventoryHandlers(router: IpcRouter, deps: InventoryHandlerDependencies): void {
  const { catalog, purchasing, session } = deps;
  const actor = () => session.actor();
  const showCost = () => session.current()?.permissions.includes('cost.view') ?? false;

  router.register('catalog:brands', () => catalog.brands());
  router.register('catalog:createBrand', (input) => ({ id: catalog.createBrand(input, actor()) }));
  router.register('catalog:createModel', (input) => ({ id: catalog.createModel(input, actor()) }));
  router.register('catalog:variants', ({ query, includeInactive }) =>
    catalog.variants({ ...(query !== undefined ? { query } : {}), includeInactive: includeInactive ?? false, showCost: showCost() }),
  );
  router.register('catalog:createVariant', (input) => ({ id: catalog.createVariant(input, actor()) }));
  router.register('catalog:updateVariant', (input) => {
    catalog.updateVariant(input, actor());
    return null;
  });
  router.register('catalog:items', ({ query, includeInactive }) =>
    catalog.items({ ...(query !== undefined ? { query } : {}), includeInactive: includeInactive ?? false, showCost: showCost() }),
  );
  router.register('catalog:createItem', (input) => ({ id: catalog.createItem(input, actor()) }));
  router.register('catalog:updateItem', (input) => {
    catalog.updateItem(input, actor());
    return null;
  });

  router.register('stock:devices', ({ variantId }) => catalog.devicesInStock(variantId, showCost()));
  router.register('stock:lookupImei', ({ imei }) => catalog.lookupImei(imei, showCost()));

  router.register('accounts:list', () => purchasing.accounts());

  router.register('suppliers:list', ({ includeInactive }) => purchasing.suppliers({ includeInactive: includeInactive ?? false }));
  router.register('suppliers:create', (input) => ({ id: purchasing.createSupplier(input, actor()) }));
  router.register('suppliers:update', (input) => {
    purchasing.updateSupplier(input, actor());
    return null;
  });
  router.register('suppliers:statement', ({ supplierId }) => purchasing.statement(supplierId));
  router.register('suppliers:pay', (input) => purchasing.paySupplier(input, actor()));

  router.register('purchases:list', ({ query, limit }) => purchasing.purchases({ ...(query !== undefined ? { query } : {}), limit }));
  router.register('purchases:get', ({ id }) => {
    const detail = purchasing.purchase(id);
    return showCost() ? detail : withoutCosts(detail);
  });
  router.register('purchases:checkImeis', ({ imeis }) => purchasing.checkImeis(imeis));
  router.register('purchases:create', (input) => purchasing.createPurchase(input, actor()));
  router.register('purchaseReturns:list', ({ limit }) => purchasing.returns(limit));
  router.register('purchaseReturns:create', (input) => purchasing.createReturn(input, actor()));
}
