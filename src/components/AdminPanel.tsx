import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Pencil, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { computeTotals, listLocalOrders, updateLocalOrderStatus, type LocalOrder, type OrderStatus } from '../orders/localOrders';
import {
  deleteOrderAsStaff,
  getOrderEventsForStaffOrder,
  listStaffOrders,
  updateOrderFormDataAsStaff,
  updateOrderStatusAsStaff,
  type DbOrderStatus,
  type DbPaymentStatus,
  type StaffOrderRow,
} from '../orders/supabaseOrders';
import { supabase } from '../lib/supabaseClient';

interface AdminPanelProps {
  onBack: () => void;
  embedded?: boolean;
  role?: 'admin' | 'employee';
}

const STATUSES: OrderStatus[] = ['Scheduled', 'Picked Up', 'In Transit', 'Delayed', 'Out for Delivery', 'Delivered'];

const escapeCsv = (value: unknown) => {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

type WorkOrderFields = {
  pickup_name: string;
  pickup_phone: string;
  pickup_address: string;
  dropoff_name: string;
  dropoff_phone: string;
  dropoff_address: string;
  vehicle: string;
  vin: string;
  transaction_id: string;
  release_form_number: string;
  arrival_date: string;
};

const readObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const readStr = (v: unknown) => (typeof v === 'string' ? v : String(v ?? '')).trim();

const readJsonObj = (v: unknown): Record<string, unknown> | null => {
  const obj = readObj(v);
  if (obj) return obj;
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return readObj(parsed);
  } catch {
    return null;
  }
};

const getWorkOrderFields = (order: LocalOrder): WorkOrderFields => {
  const form = readJsonObj(order.form_data);
  const vehicle = readObj(form?.vehicle);
  const pickup = readObj(form?.pickup_location);
  const dropoff = readObj(form?.dropoff_location);
  const txn = readObj(form?.transaction);

  const year = readStr(vehicle?.year);
  const make = readStr(vehicle?.make);
  const model = readStr(vehicle?.model);
  const vehicleLabel = [year, make, model].filter(Boolean).join(' ').trim();

  return {
    pickup_name: readStr(pickup?.name),
    pickup_phone: readStr(pickup?.phone),
    pickup_address: readStr(pickup?.address),
    dropoff_name: readStr(dropoff?.name),
    dropoff_phone: readStr(dropoff?.phone),
    dropoff_address: readStr(dropoff?.address),
    vehicle: vehicleLabel,
    vin: readStr(vehicle?.vin),
    transaction_id: readStr(txn?.transaction_id ?? (form as Record<string, unknown>)?.transaction_id),
    release_form_number: readStr(txn?.release_form_number ?? (form as Record<string, unknown>)?.release_form_number),
    arrival_date: readStr(txn?.arrival_date ?? (form as Record<string, unknown>)?.arrival_date),
  };
};

type PaymentFilter = DbPaymentStatus | 'all';

type EditableFields = {
  pickup_name: string;
  pickup_phone: string;
  pickup_address: string;
  dropoff_name: string;
  dropoff_phone: string;
  dropoff_address: string;
  vin: string;
  transaction_id: string;
  release_form_number: string;
  arrival_date: string;
};

export default function AdminPanel({ onBack, embedded = false, role = 'admin' }: AdminPanelProps) {
  const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';
  const isEmployee = role === 'employee';

  type AdminOrder = LocalOrder & { db_id?: string };
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all');
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('paid');

  const [isEditing, setIsEditing] = useState(false);
  const [editFields, setEditFields] = useState<EditableFields>({
    pickup_name: '',
    pickup_phone: '',
    pickup_address: '',
    dropoff_name: '',
    dropoff_phone: '',
    dropoff_address: '',
    vin: '',
    transaction_id: '',
    release_form_number: '',
    arrival_date: '',
  });

  const [nextStatus, setNextStatus] = useState<OrderStatus>('Scheduled');
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const getStaffAccessToken = useCallback(async (): Promise<string | null> => {
    if (!supabase) return null;
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session?.access_token ?? null;
    } catch {
      return null;
    }
  }, []);

  const reload = useCallback(() => {
    if (isLocalDev) {
      try {
        setOrders(listLocalOrders());
      } catch {
        setOrders([]);
      }
      return;
    }

    if (!supabase) {
      setOrders([]);
      return;
    }

    listStaffOrders()
      .then((rows) => {
        const mapped: AdminOrder[] = (rows as StaffOrderRow[]).map((r) => {
          const routeArea = String(r.route_area ?? '').trim();
          const subtotal = Number(r.price_before_tax ?? 0);
          const totals = computeTotals(subtotal, routeArea);
          const docsRaw = r.documents as unknown;
          const docs = Array.isArray(docsRaw)
            ? (docsRaw as unknown[])
                .map((d) => (d && typeof d === 'object' ? (d as Record<string, unknown>) : null))
                .filter(Boolean)
                .map((d) => ({
                  id: String(d?.id ?? ''),
                  name: String(d?.name ?? ''),
                  mime: String(d?.mime ?? ''),
                  size: Number(d?.size ?? 0),
                  kind: (String(d?.kind ?? 'unknown') as 'required' | 'optional' | 'unknown') || 'unknown',
                  storage:
                    d?.storage && typeof d.storage === 'object'
                      ? {
                          bucket: String((d.storage as Record<string, unknown>)?.bucket ?? ''),
                          path: String((d.storage as Record<string, unknown>)?.path ?? ''),
                        }
                      : undefined,
                }))
            : [];

          return {
            db_id: r.id,
            id: r.order_code,
            created_at: r.created_at,
            updated_at: r.updated_at,
            service_type: (r.service_type === 'delivery_one_way' ? 'delivery_one_way' : 'pickup_one_way') as LocalOrder['service_type'],
            vehicle_type: 'standard',
            route_area: routeArea,
            fulfillment_days_min: 0,
            fulfillment_days_max: 0,
            totals,
            documents: docs,
            form_data: r.form_data,
            status: r.status as OrderStatus,
            status_events: [],
            payment_status: r.payment_status,
          };
        });
        setOrders(mapped);
      })
      .catch(() => {
        setOrders([]);
      });
  }, [isLocalDev]);

  const openStoredDocument = useCallback(
    async (docId: string) => {
      if (isLocalDev) return;
      if (!supabase) return;
      const id = String(selectedId ?? '').trim();
      if (!id) return;
      const order = orders.find((o) => o.id === id) as AdminOrder | undefined;
      const dbId = String(order?.db_id ?? '').trim();
      if (!dbId) return;

      const token = await getStaffAccessToken();
      if (!token) {
        setActionError('Not authenticated');
        return;
      }

      setActionError(null);
      try {
        const res = await fetch('/.netlify/functions/get-order-document-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token, order_id: dbId, doc_id: docId }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || 'Failed to load document');
        }
        const json = (await res.json().catch(() => null)) as { url?: unknown } | null;
        const url = String(json?.url ?? '').trim();
        if (!url) throw new Error('Missing document URL');
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Failed to open document');
      }
    },
    [getStaffAccessToken, isLocalDev, orders, selectedId]
  );

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedId) return;
    const selected = orders.find((o) => o.id === selectedId);
    if (!selected) return;
    setNextStatus(selected.status);
  }, [orders, selectedId]);

  useEffect(() => {
    const id = String(selectedId ?? '').trim();
    if (!id) return;
    const selected = orders.find((o) => o.id === id) ?? null;
    if (!selected) return;

    const wo = getWorkOrderFields(selected);
    setEditFields({
      pickup_name: wo.pickup_name,
      pickup_phone: wo.pickup_phone,
      pickup_address: wo.pickup_address,
      dropoff_name: wo.dropoff_name,
      dropoff_phone: wo.dropoff_phone,
      dropoff_address: wo.dropoff_address,
      vin: wo.vin,
      transaction_id: wo.transaction_id,
      release_form_number: wo.release_form_number,
      arrival_date: wo.arrival_date,
    });
  }, [orders, selectedId]);

  useEffect(() => {
    const id = String(selectedId ?? '').trim();
    if (!id) return;
    if (isLocalDev) return;
    if (!supabase) return;
    const selected = orders.find((o) => o.id === id) as AdminOrder | undefined;
    const dbId = String(selected?.db_id ?? '').trim();
    if (!dbId) return;

    let active = true;
    void getOrderEventsForStaffOrder(dbId)
      .then((rows) => {
        if (!active) return;
        const mapped = rows.map((ev) => ({ status: ev.status as OrderStatus, at: ev.at, note: ev.note ?? undefined }));
        setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status_events: mapped } : o)));
      })
      .catch(() => {
        // ignore
      });

    return () => {
      active = false;
    };
  }, [isLocalDev, orders, selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders
      .filter((o) => (statusFilter === 'all' ? true : o.status === statusFilter))
      .filter((o) => {
        if (paymentFilter === 'all') return true;
        return (o.payment_status ?? 'unpaid') === paymentFilter;
      })
      .filter((o) => {
        if (!q) return true;
        const wo = getWorkOrderFields(o);
        const hay = [
          o.id,
          o.route_area,
          wo.pickup_address,
          wo.dropoff_address,
          wo.vehicle,
          wo.vin,
          wo.transaction_id,
          wo.release_form_number,
          wo.pickup_name,
          wo.pickup_phone,
          wo.dropoff_name,
          wo.dropoff_phone,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }, [orders, paymentFilter, search, statusFilter]);

  const selectedOrder = useMemo(() => {
    const id = String(selectedId ?? '').trim();
    if (!id) return null;
    return orders.find((o) => o.id === id) ?? null;
  }, [orders, selectedId]);

  const exportCsv = () => {
    const rows = filtered;
    const header = [
      'order_id',
      'status',
      'payment_status',
      'route_area',
      'service_type',
      'pickup_address',
      'dropoff_address',
      'vehicle',
      'vin',
      'transaction_id',
      'release_form_number',
      'arrival_date',
      'subtotal',
      'tax',
      'total',
      'tax_note',
      'created_at',
      'updated_at',
    ];

    const lines = [header.join(',')];
    for (const o of rows) {
      const wo = getWorkOrderFields(o);
      const data = [
        o.id,
        o.status,
        o.payment_status ?? 'unpaid',
        o.route_area,
        o.service_type,
        wo.pickup_address,
        wo.dropoff_address,
        wo.vehicle,
        wo.vin,
        wo.transaction_id,
        wo.release_form_number,
        wo.arrival_date,
        o.totals?.subtotal ?? 0,
        o.totals?.tax ?? 0,
        o.totals?.total ?? 0,
        o.totals?.tax_note ?? '',
        o.created_at,
        o.updated_at,
      ];
      lines.push(data.map(escapeCsv).join(','));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `easydrive-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const applyStatusUpdate = () => {
    setActionError(null);
    if (!selectedOrder) return;
    const trimmed = note.trim();

    if (isLocalDev) {
      const next = updateLocalOrderStatus(selectedOrder.id, nextStatus, trimmed || undefined);
      if (!next) {
        setActionError('Failed to update order.');
        return;
      }
      setNote('');
      reload();
      return;
    }

    const dbId = String((selectedOrder as AdminOrder).db_id ?? '').trim();
    if (!dbId) {
      setActionError('Failed to update order.');
      return;
    }

    void updateOrderStatusAsStaff(dbId, nextStatus as DbOrderStatus, trimmed || null)
      .then(() => {
        setNote('');
        reload();
      })
      .catch((e) => {
        setActionError(e instanceof Error ? e.message : 'Failed to update order.');
      });
  };

  const saveEdits = async () => {
    setActionError(null);
    if (isLocalDev) {
      setActionError('Editing is not available in local development mode.');
      return;
    }
    if (!selectedOrder) return;
    const dbId = String((selectedOrder as AdminOrder).db_id ?? '').trim();
    if (!dbId) {
      setActionError('Failed to update order.');
      return;
    }

    const base = readObj(selectedOrder.form_data) ?? {};
    const next = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;

    const pickup = (readObj(next.pickup_location) ?? {}) as Record<string, unknown>;
    pickup.name = editFields.pickup_name;
    pickup.phone = editFields.pickup_phone;
    pickup.address = editFields.pickup_address;
    next.pickup_location = pickup;

    const dropoff = (readObj(next.dropoff_location) ?? {}) as Record<string, unknown>;
    dropoff.name = editFields.dropoff_name;
    dropoff.phone = editFields.dropoff_phone;
    dropoff.address = editFields.dropoff_address;
    next.dropoff_location = dropoff;

    const vehicle = (readObj(next.vehicle) ?? {}) as Record<string, unknown>;
    vehicle.vin = editFields.vin;
    next.vehicle = vehicle;

    const txn = (readObj(next.transaction) ?? {}) as Record<string, unknown>;
    txn.transaction_id = editFields.transaction_id;
    txn.release_form_number = editFields.release_form_number;
    txn.arrival_date = editFields.arrival_date;
    next.transaction = txn;

    try {
      await updateOrderFormDataAsStaff(dbId, next);
      setIsEditing(false);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update order.');
    }
  };

  const deleteSelectedOrder = async () => {
    setActionError(null);
    if (!selectedOrder) return;
    if (isLocalDev) {
      setActionError('Delete is not available in local development mode.');
      return;
    }
    const dbId = String((selectedOrder as AdminOrder).db_id ?? '').trim();
    if (!dbId) {
      setActionError('Failed to delete order.');
      return;
    }

    const ok = window.confirm(`Delete order ${selectedOrder.id}? This cannot be undone.`);
    if (!ok) return;

    try {
      await deleteOrderAsStaff(dbId);
      setSelectedId(null);
      setIsEditing(false);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to delete order.');
    }
  };

  return (
    <div className={embedded ? 'bg-gray-50' : 'min-h-screen bg-gray-50'}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        {!embedded ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gray-900 text-white">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="text-lg sm:text-xl font-bold text-gray-900">Admin</div>
                <div className="text-xs sm:text-sm text-gray-600">Work orders</div>
              </div>
            </div>
          </div>
        ) : null}

        <div className={embedded ? 'grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6' : 'mt-5 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6'}>
          <div className="lg:col-span-1">
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-gray-900">Work orders</div>
                  {!isEmployee ? (
                    <button
                      type="button"
                      onClick={exportCsv}
                      className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 transition-colors"
                    >
                      <Download className="h-4 w-4" />
                      Export CSV
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2">
                    <Search className="h-4 w-4 text-gray-500" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by ID, pickup, dropoff, vehicle, VIN..."
                      className="w-full text-sm outline-none"
                    />
                  </div>

                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as OrderStatus | 'all')}
                    className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="all">All statuses</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>

                  <select
                    value={paymentFilter}
                    onChange={(e) => setPaymentFilter(e.target.value as PaymentFilter)}
                    className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="paid">Paid only</option>
                    <option value="all">All payments</option>
                    <option value="unpaid">Unpaid</option>
                    <option value="pending">Pending</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>

                <div className="mt-3 text-xs text-gray-500">Showing {filtered.length} orders</div>
              </div>

              <div className="p-3">
                {filtered.length === 0 ? (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">No orders.</div>
                ) : (
                  <div className="space-y-2 max-h-[calc(100vh-18rem)] overflow-auto">
                    {filtered.map((o) => {
                      const active = o.id === selectedId;
                      const wo = getWorkOrderFields(o);
                      const pickupLabel = wo.pickup_address || wo.pickup_name;
                      const dropoffLabel = wo.dropoff_address || wo.dropoff_name;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setSelectedId(o.id)}
                          className={`w-full text-left rounded-xl border px-3 py-3 transition-colors ${
                            active ? 'border-cyan-300 bg-cyan-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-gray-900 truncate">{o.id}</div>
                            <div className="flex items-center gap-2">
                              <div className="text-[11px] font-semibold text-gray-600">{o.status}</div>
                              <div
                                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                                  (o.payment_status ?? 'unpaid') === 'paid'
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : (o.payment_status ?? 'unpaid') === 'pending'
                                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                                      : (o.payment_status ?? 'unpaid') === 'failed'
                                        ? 'border-red-200 bg-red-50 text-red-700'
                                        : 'border-gray-200 bg-gray-50 text-gray-700'
                                }`}
                              >
                                {(o.payment_status ?? 'unpaid').toUpperCase()}
                              </div>
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-gray-600 truncate">{pickupLabel && dropoffLabel ? `${pickupLabel} → ${dropoffLabel}` : o.route_area}</div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-600">
                            <div className="truncate">{wo.vehicle || o.route_area}</div>
                            <div>{new Date(o.updated_at).toLocaleString()}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-100">
                <div className="text-sm font-semibold text-gray-900">Work order details</div>
                <div className="text-xs text-gray-600">Pickup / dropoff + update status + timeline notes</div>
              </div>

              {!selectedOrder ? (
                <div className="p-4">
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">Select an order to manage.</div>
                </div>
              ) : (
                <div className="p-4 space-y-4">
                  {(() => {
                    const wo = getWorkOrderFields(selectedOrder);
                    return (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Pickup</div>
                          {isEditing ? (
                            <>
                              <input
                                value={editFields.pickup_address}
                                onChange={(e) => setEditFields((p) => ({ ...p, pickup_address: e.target.value }))}
                                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                placeholder="Pickup address"
                              />
                              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <input
                                  value={editFields.pickup_name}
                                  onChange={(e) => setEditFields((p) => ({ ...p, pickup_name: e.target.value }))}
                                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                  placeholder="Pickup name"
                                />
                                <input
                                  value={editFields.pickup_phone}
                                  onChange={(e) => setEditFields((p) => ({ ...p, pickup_phone: e.target.value }))}
                                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                  placeholder="Pickup phone"
                                />
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="mt-1 text-sm font-semibold text-gray-900">{wo.pickup_address || '-'}</div>
                              <div className="mt-1 text-xs text-gray-600">{[wo.pickup_name, wo.pickup_phone].filter(Boolean).join(' • ') || ' '}</div>
                            </>
                          )}
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Drop-off</div>
                          {isEditing ? (
                            <>
                              <input
                                value={editFields.dropoff_address}
                                onChange={(e) => setEditFields((p) => ({ ...p, dropoff_address: e.target.value }))}
                                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                placeholder="Drop-off address"
                              />
                              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <input
                                  value={editFields.dropoff_name}
                                  onChange={(e) => setEditFields((p) => ({ ...p, dropoff_name: e.target.value }))}
                                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                  placeholder="Drop-off name"
                                />
                                <input
                                  value={editFields.dropoff_phone}
                                  onChange={(e) => setEditFields((p) => ({ ...p, dropoff_phone: e.target.value }))}
                                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                  placeholder="Drop-off phone"
                                />
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="mt-1 text-sm font-semibold text-gray-900">{wo.dropoff_address || '-'}</div>
                              <div className="mt-1 text-xs text-gray-600">{[wo.dropoff_name, wo.dropoff_phone].filter(Boolean).join(' • ') || ' '}</div>
                            </>
                          )}
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Vehicle</div>
                          <div className="mt-1 text-sm font-semibold text-gray-900">{wo.vehicle || '-'}</div>
                          {isEditing ? (
                            <div className="mt-2">
                              <input
                                value={editFields.vin}
                                onChange={(e) => setEditFields((p) => ({ ...p, vin: e.target.value }))}
                                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                placeholder="VIN"
                              />
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-gray-600">VIN: {wo.vin || '-'}</div>
                          )}
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Identifiers</div>
                          {isEditing ? (
                            <div className="mt-2 space-y-2">
                              <input
                                value={editFields.transaction_id}
                                onChange={(e) => setEditFields((p) => ({ ...p, transaction_id: e.target.value }))}
                                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                placeholder="Transaction ID"
                              />
                              <input
                                value={editFields.release_form_number}
                                onChange={(e) => setEditFields((p) => ({ ...p, release_form_number: e.target.value }))}
                                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                placeholder="Release Form #"
                              />
                              <input
                                value={editFields.arrival_date}
                                onChange={(e) => setEditFields((p) => ({ ...p, arrival_date: e.target.value }))}
                                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm"
                                placeholder="Arrival date"
                              />
                            </div>
                          ) : (
                            <>
                              <div className="mt-1 text-xs text-gray-700">Transaction ID: {wo.transaction_id || '-'}</div>
                              <div className="mt-1 text-xs text-gray-700">Release Form #: {wo.release_form_number || '-'}</div>
                              <div className="mt-1 text-xs text-gray-700">Arrival Date: {wo.arrival_date || '-'}</div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {!isEmployee ? (
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-4">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">Actions</div>
                        <div className="text-xs text-gray-600">Edit details or delete this order.</div>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setIsEditing(false)}
                              className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={saveEdits}
                              className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                            >
                              Save
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setIsEditing(true)}
                              className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                            >
                              <Pencil className="h-4 w-4" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={deleteSelectedOrder}
                              className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ) : null}

                  <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                    <div className="p-4 border-b border-gray-100">
                      <div className="text-sm font-semibold text-gray-900">Documents</div>
                      <div className="text-xs text-gray-600">Required docs help drivers confirm release/work order exists.</div>
                    </div>
                    <div className="p-4">
                      {selectedOrder.documents?.length ? (
                        <div className="space-y-2">
                          {selectedOrder.documents.map((d) => (
                            <div
                              key={d.id}
                              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-gray-900 truncate">{d.name}</div>
                                <div className="text-xs text-gray-600 truncate">{d.mime}</div>
                              </div>

                              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                                {!isLocalDev && d.storage?.bucket && d.storage?.path ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void openStoredDocument(d.id);
                                    }}
                                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                                  >
                                    <Download className="h-4 w-4" />
                                    View
                                  </button>
                                ) : null}
                                <div className="text-xs font-semibold text-gray-700">{d.kind}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">No documents uploaded.</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                    <div className="p-4 border-b border-gray-100">
                      <div className="text-sm font-semibold text-gray-900">Update status</div>
                      <div className="text-xs text-gray-600">Adds a timeline event with timestamp.</div>
                    </div>
                    <div className="p-4 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <select
                          value={nextStatus}
                          onChange={(e) => setNextStatus(e.target.value as OrderStatus)}
                          className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={applyStatusUpdate}
                          className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                        >
                          Apply
                        </button>
                      </div>

                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="w-full min-h-[90px] rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        placeholder="Optional note (shows in customer tracking timeline)"
                      />

                      {actionError ? <div className="text-sm text-red-700">{actionError}</div> : null}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                    <div className="p-4 border-b border-gray-100">
                      <div className="text-sm font-semibold text-gray-900">Timeline</div>
                      <div className="text-xs text-gray-600">Most recent first</div>
                    </div>
                    <div className="p-4 space-y-2">
                      {(selectedOrder.status_events ?? []).length === 0 ? (
                        <div className="text-sm text-gray-600">No events yet.</div>
                      ) : (
                        (selectedOrder.status_events ?? []).map((ev, idx) => (
                          <div key={`${ev.at}-${idx}`} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                              <div className="text-sm font-semibold text-gray-900">{ev.status}</div>
                              <div className="text-xs text-gray-600">{new Date(ev.at).toLocaleString()}</div>
                            </div>
                            {ev.note ? <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap">{ev.note}</div> : null}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
