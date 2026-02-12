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

export type LocalOrderStage = 'draft' | 'in_negotiation' | 'pending_payment' | 'order_dispatched' | 'order_completed';

export type LocalOrderDocument = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'required' | 'optional' | 'unknown';
  storage?: {
    bucket: string;
    path: string;
  };
};

export type LocalOrder = {
  id: string;
  created_at: string;
  updated_at: string;
  order_stage?: LocalOrderStage;
  service_type: 'pickup_one_way' | 'delivery_one_way';
  vehicle_type: 'standard';
  route_area: string;
  fulfillment_days_min: number;
  fulfillment_days_max: number;
  price_before_tax?: number;
  final_price_before_tax?: number | null;
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
const OFFERS_STORAGE_KEY = 'ed_local_order_offers_v1';

export type LocalOrderOfferStatus = 'pending' | 'approved' | 'declined';

export type LocalOrderOffer = {
  id: string;
  order_id: string;
  offer_amount: number;
  notes: string | null;
  status: LocalOrderOfferStatus;
  admin_note: string | null;
  created_at: string;
  reviewed_at: string | null;
};

export type LocalStaffOfferRow = LocalOrderOffer & {
  user_id: string;
  orders?: {
    order_code?: string | null;
    route_area?: string | null;
    price_before_tax?: number | null;
    final_price_before_tax?: number | null;
    order_stage?: LocalOrderStage | null;
  } | null;
};

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

const readLocalOffers = (): LocalOrderOffer[] => {
  try {
    const raw = localStorage.getItem(OFFERS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const r = it as Record<string, unknown>;
        const id = String(r.id ?? '').trim();
        const order_id = String(r.order_id ?? '').trim();
        const offer_amount = Number(r.offer_amount);
        const notes = typeof r.notes === 'string' ? r.notes : null;
        const statusRaw = String(r.status ?? '').trim();
        const status: LocalOrderOfferStatus = statusRaw === 'approved' || statusRaw === 'declined' || statusRaw === 'pending' ? (statusRaw as LocalOrderOfferStatus) : 'pending';
        const admin_note = typeof r.admin_note === 'string' ? r.admin_note : null;
        const created_at = String(r.created_at ?? '').trim() || new Date().toISOString();
        const reviewed_at = typeof r.reviewed_at === 'string' ? r.reviewed_at : null;
        if (!id || !order_id || !Number.isFinite(offer_amount) || offer_amount <= 0) return null;
        return { id, order_id, offer_amount, notes, status, admin_note, created_at, reviewed_at } satisfies LocalOrderOffer;
      })
      .filter(Boolean) as LocalOrderOffer[];
  } catch {
    return [];
  }
};

const writeLocalOffers = (offers: LocalOrderOffer[]) => {
  try {
    localStorage.setItem(OFFERS_STORAGE_KEY, JSON.stringify(offers));
  } catch {
    // ignore
  }
};

export const getLocalPendingOfferForOrder = (orderId: string): LocalOrderOffer | null => {
  const id = String(orderId ?? '').trim();
  if (!id) return null;
  const all = readLocalOffers();
  return all.find((o) => o.order_id === id && o.status === 'pending') ?? null;
};

export const getLocalLatestOfferForOrder = (orderId: string): LocalOrderOffer | null => {
  const id = String(orderId ?? '').trim();
  if (!id) return null;
  const all = readLocalOffers().filter((o) => o.order_id === id);
  if (all.length === 0) return null;
  all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return all[0] ?? null;
};

export const createLocalOfferForOrder = (orderId: string, offerAmount: number, notes?: string): LocalOrderOffer => {
  const id = String(orderId ?? '').trim();
  const amount = Number(offerAmount);
  if (!id) throw new Error('Missing order id');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid offer amount');

  const pending = getLocalPendingOfferForOrder(id);
  if (pending) throw new Error('You already have a pending offer for this order.');

  const now = new Date().toISOString();
  const offer: LocalOrderOffer = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    order_id: id,
    offer_amount: amount,
    notes: String(notes ?? '').trim() || null,
    status: 'pending',
    admin_note: null,
    created_at: now,
    reviewed_at: null,
  };

  const existing = readLocalOffers();
  writeLocalOffers([offer, ...existing]);

  const order = getLocalOrderById(id);
  if (order) {
    const next: LocalOrder = { ...order, order_stage: 'in_negotiation', updated_at: now };
    upsertLocalOrder(next);
  }

  return offer;
};

export const listLocalPendingOffersAsStaff = (): LocalStaffOfferRow[] => {
  const offers = readLocalOffers().filter((o) => o.status === 'pending');
  const orders = listLocalOrders();
  const byId = new Map(orders.map((o) => [o.id, o] as const));
  return offers
    .map((o) => {
      const ord = byId.get(o.order_id) ?? null;
      return {
        ...o,
        user_id: 'local',
        orders: ord
          ? {
              order_code: ord.id,
              route_area: ord.route_area,
              price_before_tax: typeof ord.price_before_tax === 'number' ? ord.price_before_tax : ord.totals?.subtotal ?? null,
              final_price_before_tax: typeof ord.final_price_before_tax === 'number' ? ord.final_price_before_tax : null,
              order_stage: ord.order_stage ?? null,
            }
          : null,
      } satisfies LocalStaffOfferRow;
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
};

export const resolveLocalOfferAsStaff = (
  offerId: string,
  action: 'approved' | 'declined',
  adminNote?: string | null
): { at: string } => {
  const id = String(offerId ?? '').trim();
  if (!id) throw new Error('Missing offer id');
  const all = readLocalOffers();
  const idx = all.findIndex((o) => o.id === id);
  if (idx < 0) throw new Error('Offer not found');

  const at = new Date().toISOString();
  const existing = all[idx];
  const updated: LocalOrderOffer = {
    ...existing,
    status: action === 'approved' ? 'approved' : 'declined',
    admin_note: String(adminNote ?? '').trim() || null,
    reviewed_at: at,
  };
  const nextOffers = [...all];
  nextOffers[idx] = updated;
  writeLocalOffers(nextOffers);

  const ord = getLocalOrderById(existing.order_id);
  if (ord) {
    const nextOrder: LocalOrder = {
      ...ord,
      updated_at: at,
      order_stage: action === 'approved' ? 'pending_payment' : 'draft',
      final_price_before_tax: action === 'approved' ? Number(existing.offer_amount) : null,
      status_events: [
        {
          status: ord.status,
          at,
          note: action === 'approved' ? 'Offer approved (local)' : 'Offer declined (local)',
        },
        ...(ord.status_events ?? []),
      ],
    };
    upsertLocalOrder(nextOrder);
  }

  return { at };
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

export const createLocalDraftOrderFromQuote = (input: {
  route_area: string;
  service_type: LocalOrder['service_type'];
  vehicle_type: LocalOrder['vehicle_type'];
  price_before_tax: number;
  form_data?: unknown;
  documents?: LocalOrderDocument[] | null;
}) => {
  const now = new Date().toISOString();
  const orderId = makeLocalOrderId();
  const routeArea = String(input.route_area ?? '').trim();
  const subtotalRaw = Number(input.price_before_tax);
  const subtotal = Number.isFinite(subtotalRaw) && subtotalRaw >= 0 ? subtotalRaw : 0;
  const totals = computeTotals(subtotal, routeArea);

  const order: LocalOrder = {
    id: orderId,
    created_at: now,
    updated_at: now,
    order_stage: 'draft',
    service_type: input.service_type,
    vehicle_type: input.vehicle_type,
    route_area: routeArea,
    fulfillment_days_min: 0,
    fulfillment_days_max: 0,
    price_before_tax: subtotal,
    final_price_before_tax: null,
    totals,
    form_data: input.form_data ?? null,
    documents: Array.isArray(input.documents) ? input.documents : [],
    status: 'Scheduled',
    status_events: [{ status: 'Scheduled', at: now, note: 'Quote saved (local)' }],
    payment_status: 'unpaid',
  };

  upsertLocalOrder(order);
  return order;
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
