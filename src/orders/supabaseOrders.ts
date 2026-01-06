import { requireSupabase } from '../lib/supabaseClient';

export type DbOrderStatus = 'Scheduled' | 'Picked Up' | 'In Transit' | 'Delayed' | 'Out for Delivery' | 'Delivered';
export type DbPaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed';

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
  currency: string;
  status: DbOrderStatus;
  payment_status: DbPaymentStatus;
  form_data?: unknown;
  documents?: unknown;
  created_at: string;
  updated_at: string;
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
  | 'currency'
  | 'form_data'
  | 'documents'
  | 'created_at'
  | 'updated_at'
>;

export const listStaffOrders = async () => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_code, route_area, service_type, vehicle_type, status, payment_status, price_before_tax, currency, form_data, documents, created_at, updated_at')
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

export const listMyOrders = async () => {
  const supabase = requireSupabase();
  const user = await getCurrentUser();
  if (!user?.id) return [];
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_code, status, payment_status, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (Array.isArray(data) ? data : []) as Array<Pick<DbOrderRow, 'id' | 'order_code' | 'status' | 'payment_status' | 'created_at' | 'updated_at'>>;
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
