import { requireSupabase } from '../lib/supabaseClient';

export type DbOrderStatus = 'Scheduled' | 'Picked Up' | 'In Transit' | 'Delayed' | 'Out for Delivery' | 'Delivered';
export type DbPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed';
export type DbOrderStage = 'draft' | 'in_negotiation' | 'pending_payment' | 'order_dispatched' | 'order_completed';

export type CreateOrderInput = {
  order_code: string;
  customer_name?: string;
  customer_email?: string;
  route_area?: string;
  service_type?: string;
  vehicle_type?: string;
  price_before_tax: number;
  currency?: 'CAD';
  form_data?: unknown;
  documents?: unknown;
};

export type DbOrderRow = {
  id: string;
  order_code: string;
  user_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  route_area: string | null;
  service_type: string | null;
  vehicle_type: string | null;
  price_before_tax: number;
  final_price_before_tax?: number | null;
  currency: string;
  status: DbOrderStatus;
  payment_status: DbPaymentStatus;
  order_stage?: DbOrderStage;
  form_data?: unknown;
  documents?: unknown;
  created_at: string;
  updated_at: string;
};

export type DbOfferStatus = 'pending' | 'approved' | 'declined';

export type DbOrderOfferRow = {
  id: string;
  order_id: string;
  user_id: string;
  offer_amount: number;
  notes: string | null;
  status: DbOfferStatus;
  admin_note: string | null;
  created_at: string;
  reviewed_at: string | null;
};

export type DbOrderEventRow = {
  status: DbOrderStatus;
  note: string | null;
  at: string;
};

export const getAccessToken = async (): Promise<string | null> => {
  const supabase = requireSupabase();
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
};

export const getCurrentUser = async () => {
  const supabase = requireSupabase();
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
};

export const createOrderWithInitialEvent = async (input: CreateOrderInput) => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  const now = new Date().toISOString();

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      ...input,
      user_id: user.id,
      currency: input.currency ?? 'CAD',
      status: 'Scheduled',
      payment_status: 'unpaid',
      order_stage: 'pending_payment',
      updated_at: now,
    })
    .select('*')
    .single();

  if (orderErr) throw orderErr;

  const { error: evErr } = await supabase.from('order_events').insert({
    order_id: order.id,
    status: 'Scheduled',
    note: 'Order created',
    at: now,
  });

  if (evErr) throw evErr;

  return order as DbOrderRow;
};

export type CreateSavedQuoteInput = {
  order_code: string;
  route_area?: string;
  service_type?: string;
  vehicle_type?: string;
  price_before_tax: number;
  currency?: 'CAD';
  form_data?: unknown;
  documents?: unknown;
};

export const createSavedQuoteOrder = async (input: CreateSavedQuoteInput) => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  const now = new Date().toISOString();

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      ...input,
      user_id: user.id,
      currency: input.currency ?? 'CAD',
      status: 'Scheduled',
      payment_status: 'unpaid',
      order_stage: 'draft',
      updated_at: now,
    })
    .select('*')
    .single();

  if (orderErr) throw orderErr;

  const { error: evErr } = await supabase.from('order_events').insert({
    order_id: order.id,
    status: 'Scheduled',
    note: 'Quote saved',
    at: now,
  });

  if (evErr) throw evErr;

  return order as DbOrderRow;
};

export type StaffOrderRow = Pick<
  DbOrderRow,
  | 'id'
  | 'order_code'
  | 'route_area'
  | 'service_type'
  | 'vehicle_type'
  | 'status'
  | 'payment_status'
  | 'price_before_tax'
  | 'final_price_before_tax'
  | 'currency'
  | 'order_stage'
  | 'form_data'
  | 'documents'
  | 'created_at'
  | 'updated_at'
>;

export const listStaffOrders = async () => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, order_code, route_area, service_type, vehicle_type, status, payment_status, price_before_tax, final_price_before_tax, currency, order_stage, form_data, documents, created_at, updated_at'
    )
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as StaffOrderRow[];
};

export const updateOrderStatusAsStaff = async (orderId: string, status: DbOrderStatus, note?: string | null) => {
  const supabase = requireSupabase();
  const at = new Date().toISOString();

  const { error: updateErr } = await supabase.from('orders').update({ status, updated_at: at }).eq('id', orderId);
  if (updateErr) throw updateErr;

  const { error: evErr } = await supabase.from('order_events').insert({
    order_id: orderId,
    status,
    note: note ?? null,
    at,
  });
  if (evErr) throw evErr;

  return { at };
};

export const getOrderEventsForStaffOrder = async (orderId: string) => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('order_events')
    .select('status, note, at')
    .eq('order_id', orderId)
    .order('at', { ascending: false });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as DbOrderEventRow[];
};

export const updateOrderFormDataAsStaff = async (orderId: string, formData: unknown) => {
  const supabase = requireSupabase();
  const at = new Date().toISOString();
  const { error } = await supabase.from('orders').update({ form_data: formData as never, updated_at: at }).eq('id', orderId);
  if (error) throw error;
  return { at };
};

export const deleteOrderAsStaff = async (orderId: string) => {
  const supabase = requireSupabase();
  const { error } = await supabase.from('orders').delete().eq('id', orderId);
  if (error) throw error;
};

export const listMyOrders = async () => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user?.id) return [];
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_code, status, payment_status, order_stage, price_before_tax, final_price_before_tax, route_area, form_data, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as Array<
    Pick<
      DbOrderRow,
      'id' | 'order_code' | 'status' | 'payment_status' | 'order_stage' | 'price_before_tax' | 'final_price_before_tax' | 'route_area' | 'form_data' | 'created_at' | 'updated_at'
    >
  >;
};

export const getMyPendingOfferForOrder = async (orderId: string) => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user?.id) return null;

  const { data, error } = await supabase
    .from('order_offers')
    .select('id, order_id, user_id, offer_amount, notes, status, admin_note, created_at, reviewed_at')
    .eq('order_id', orderId)
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) throw error;
  return (data as DbOrderOfferRow | null) ?? null;
};

export const getMyLatestOfferForOrder = async (orderId: string) => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user?.id) return null;

  const { data, error } = await supabase
    .from('order_offers')
    .select('id, order_id, user_id, offer_amount, notes, status, admin_note, created_at, reviewed_at')
    .eq('order_id', orderId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as DbOrderOfferRow | null) ?? null;
};

export const createOfferForOrder = async (orderId: string, offerAmount: number, notes?: string) => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user?.id) throw new Error('Not authenticated');

  const amount = Number(offerAmount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid offer amount');

  const { data, error } = await supabase
    .from('order_offers')
    .insert({
      order_id: orderId,
      user_id: user.id,
      offer_amount: amount,
      notes: String(notes ?? '').trim() || null,
      status: 'pending',
    })
    .select('id, order_id, user_id, offer_amount, notes, status, admin_note, created_at, reviewed_at')
    .single();

  if (error) throw error;

  try {
    const at = new Date().toISOString();
    await supabase
      .from('orders')
      .update({ order_stage: 'in_negotiation', updated_at: at })
      .eq('id', orderId);
  } catch {
    // ignore (offer submission can still succeed even if order stage update is blocked by RLS)
  }
  return data as DbOrderOfferRow;
};

export type StaffOfferRow = DbOrderOfferRow & {
  orders?: {
    order_code?: string | null;
    route_area?: string | null;
    price_before_tax?: number | null;
    final_price_before_tax?: number | null;
    order_stage?: DbOrderStage | null;
  } | null;
};

export const listPendingOffersAsStaff = async () => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('order_offers')
    .select('id, order_id, user_id, offer_amount, notes, status, admin_note, created_at, reviewed_at, orders(order_code, route_area, price_before_tax, final_price_before_tax, order_stage)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as StaffOfferRow[];
};

export const updateOfferAsStaff = async (offerId: string, nextStatus: DbOfferStatus, adminNote?: string | null) => {
  const supabase = requireSupabase();
  const at = new Date().toISOString();
  const payload: Record<string, unknown> = {
    status: nextStatus,
    admin_note: String(adminNote ?? '').trim() || null,
    reviewed_at: at,
  };
  const { error } = await supabase.from('order_offers').update(payload).eq('id', offerId);
  if (error) throw error;
  return { at };
};

export const getOrderEventsForMyOrder = async (orderId: string) => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('order_events')
    .select('status, note, at')
    .eq('order_id', orderId)
    .order('at', { ascending: false });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as DbOrderEventRow[];
};

 export const updateOrderStageAsStaff = async (orderId: string, orderStage: DbOrderStage) => {
  const supabase = requireSupabase();
  const at = new Date().toISOString();
  const { error } = await supabase
    .from('orders')
    .update({ order_stage: orderStage, updated_at: at })
    .eq('id', orderId);
  if (error) throw error;
  return { at };
 };

 export const updateOrderFinalPriceAsStaff = async (orderId: string, finalPriceBeforeTax: number | null) => {
  const supabase = requireSupabase();
  const at = new Date().toISOString();
  const payload: Record<string, unknown> = {
    final_price_before_tax: finalPriceBeforeTax,
    updated_at: at,
  };
  const { error } = await supabase.from('orders').update(payload).eq('id', orderId);
  if (error) throw error;
  return { at };
 };

 export const updateOrderPricingAndStageAsStaff = async (
  orderId: string,
  input: { final_price_before_tax?: number | null; order_stage?: DbOrderStage }
 ) => {
  const supabase = requireSupabase();
  const at = new Date().toISOString();
  const payload: Record<string, unknown> = { updated_at: at };
  if (Object.prototype.hasOwnProperty.call(input, 'final_price_before_tax')) {
    payload.final_price_before_tax = input.final_price_before_tax ?? null;
  }
  if (input.order_stage) {
    payload.order_stage = input.order_stage;
  }
  const { error } = await supabase.from('orders').update(payload).eq('id', orderId);
  if (error) throw error;
  return { at };
 };
