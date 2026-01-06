export type OrderStatus =
  | 'Scheduled'
  | 'Picked Up'
  | 'In Transit'
  | 'Delayed'
  | 'Out for Delivery'
  | 'Delivered';

export type OrderStatusEvent = {
  status: OrderStatus;
  at: string;
  note?: string;
};

export type OrderParty = {
  name?: string;
  email?: string;
  phone?: string;
};

export type OrderTotals = {
  currency: 'CAD';
  subtotal: number;
  tax_rate: number;
  tax: number;
  total: number;
  tax_note: string;
};

export type LocalPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed';

export type LocalOrderDocument = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'required' | 'optional' | 'unknown';
};

export type LocalOrder = {
  id: string;
  created_at: string;
  updated_at: string;
  service_type: 'pickup_one_way' | 'delivery_one_way';
  vehicle_type: 'standard';
  route_area: string;
  fulfillment_days_min: number;
  fulfillment_days_max: number;
  totals: OrderTotals;
  customer?: OrderParty;
  dealer?: OrderParty;
  form_data?: unknown;
  documents: LocalOrderDocument[];
  receipt_text?: string;
  status: OrderStatus;
  status_events: OrderStatusEvent[];
  notes?: string;
  payment_status?: LocalPaymentStatus;
};

const STORAGE_KEY = 'ed_local_orders_v1';

const normalizeTotals = (totals: OrderTotals | null | undefined): OrderTotals | null => {
  if (!totals) return null;
  const sub = Number(totals.subtotal);
  const safeSubtotal = Number.isFinite(sub) && sub >= 0 ? sub : 0;
  const tr = Number((totals as { tax_rate?: unknown })?.tax_rate);
  const safeTaxRate = Number.isFinite(tr) && tr >= 0 ? tr : 0;
  const tx = Number((totals as { tax?: unknown })?.tax);
  const computedTax = Math.round(safeSubtotal * safeTaxRate * 100) / 100;
  const safeTax = Number.isFinite(tx) && tx >= 0 ? tx : computedTax;
  const tot = Number((totals as { total?: unknown })?.total);
  const computedTotal = Math.round((safeSubtotal + safeTax) * 100) / 100;
  const safeTotal = Number.isFinite(tot) && tot >= 0 ? tot : computedTotal;
  const note = String((totals as { tax_note?: unknown })?.tax_note ?? '').trim();
  return {
    currency: 'CAD',
    subtotal: safeSubtotal,
    tax_rate: safeTaxRate,
    tax: safeTax,
    total: safeTotal,
    tax_note: note,
  };
};

export const listLocalOrders = (): LocalOrder[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    const orders = parsed as LocalOrder[];
    return orders.map((o) => {
      const normalizedTotals = normalizeTotals(o?.totals);
      if (!normalizedTotals) return o;

      const ps = String((o as { payment_status?: unknown })?.payment_status ?? '').trim().toLowerCase();
      const normalizedPaymentStatus: LocalPaymentStatus =
        ps === 'paid' || ps === 'pending' || ps === 'failed' || ps === 'unpaid' ? (ps as LocalPaymentStatus) : 'unpaid';

      const changed =
        o.totals.tax_rate !== 0 ||
        o.totals.tax !== 0 ||
        o.totals.total !== o.totals.subtotal ||
        String(o.totals.tax_note ?? '').trim() !== '';

      const missingPaymentStatus = typeof (o as { payment_status?: unknown })?.payment_status === 'undefined';
      if (changed || missingPaymentStatus) {
        return { ...o, totals: normalizedTotals, payment_status: normalizedPaymentStatus };
      }
      return o;
    });
  } catch {
    return [];
  }
};

export const getLocalOrderById = (id: string): LocalOrder | null => {
  const orderId = String(id ?? '').trim();
  if (!orderId) return null;
  const all = listLocalOrders();
  return all.find((o) => o.id === orderId) ?? null;
};

const writeLocalOrders = (orders: LocalOrder[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  } catch {
    // ignore
  }
};

export const upsertLocalOrder = (order: LocalOrder) => {
  const all = listLocalOrders();
  const idx = all.findIndex((o) => o.id === order.id);
  const next = [...all];
  if (idx >= 0) next[idx] = order;
  else next.unshift(order);
  writeLocalOrders(next);
};

export const updateLocalOrderStatus = (id: string, status: OrderStatus, note?: string) => {
  const existing = getLocalOrderById(id);
  if (!existing) return null;
  const at = new Date().toISOString();
  const next: LocalOrder = {
    ...existing,
    updated_at: at,
    status,
    status_events: [{ status, at, note }, ...(existing.status_events ?? [])],
  };
  upsertLocalOrder(next);
  return next;
};

export const updateLocalOrderPaymentStatus = (id: string, payment_status: LocalPaymentStatus, note?: string) => {
  const existing = getLocalOrderById(id);
  if (!existing) return null;
  const at = new Date().toISOString();
  const next: LocalOrder = {
    ...existing,
    updated_at: at,
    payment_status,
    status_events: [{ status: existing.status, at, note }, ...(existing.status_events ?? [])],
  };
  upsertLocalOrder(next);
  return next;
};

export const deleteLocalOrder = (id: string) => {
  const orderId = String(id ?? '').trim();
  if (!orderId) return;
  const all = listLocalOrders();
  writeLocalOrders(all.filter((o) => o.id !== orderId));
};

export const makeLocalOrderId = () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `EDC-${yyyy}${mm}${dd}-${rand}`;
};

export const computeTotals = (subtotal: number, routeArea: string): OrderTotals => {
  const sub = Number(subtotal);
  const safeSubtotalRaw = Number.isFinite(sub) && sub >= 0 ? sub : 0;
  const safeSubtotal = Math.round(safeSubtotalRaw * 100) / 100;
  const r = String(routeArea ?? '').trim().toLowerCase();
  const isQc = r.includes('montreal') || r.includes('quebec');
  const tax_rate = isQc ? 0.14975 : 0.13;
  const tax_note = isQc ? 'QC (GST+QST)' : 'ON (HST)';
  const tax = Math.round(safeSubtotal * tax_rate * 100) / 100;
  const total = Math.round((safeSubtotal + tax) * 100) / 100;
  return {
    currency: 'CAD',
    subtotal: safeSubtotal,
    tax_rate,
    tax,
    total,
    tax_note,
  };
};
