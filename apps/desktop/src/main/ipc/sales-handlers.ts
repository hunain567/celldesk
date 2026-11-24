import type { SalesService } from '../services/sales';
import type { SessionManager } from '../services/session';
import type { IpcRouter } from './router';

export interface SalesHandlerDependencies {
  sales: SalesService;
  session: SessionManager;
}

export function registerSalesHandlers(router: IpcRouter, deps: SalesHandlerDependencies): void {
  const { sales, session } = deps;
  const actor = () => session.actor();
  const has = (permission: string) => session.current()?.permissions.includes(permission as never) ?? false;

  router.register('customers:list', ({ query, limit }) => sales.customers({ ...(query !== undefined ? { query } : {}), limit }));
  router.register('customers:create', (input) => ({ id: sales.createCustomer(input, actor()) }));

  router.register('pos:lookup', ({ code }) => sales.lookup(code));
  router.register('sales:list', ({ query, limit }) => sales.sales({ ...(query !== undefined ? { query } : {}), limit }));
  router.register('sales:get', ({ id }) => sales.sale(id, has('cost.view')));
  router.register('sales:create', (input) => sales.createSale(input, actor(), { canSellBelowMinimum: has('sale.belowMinimum') }));
  router.register('saleReturns:list', ({ limit }) => sales.returns(limit));
  router.register('saleReturns:create', (input) => sales.createReturn(input, actor()));
}
