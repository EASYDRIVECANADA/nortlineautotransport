import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { listMyOrders, getOrderEventsForMyOrder, getAccessToken, type DbOrderEventRow, type DbOrderRow } from '../orders/supabaseOrders';
import { supabase } from '../lib/supabaseClient';
import { getLocalOrderById, listLocalOrders, updateLocalOrderPaymentStatus } from '../orders/localOrders';

interface LocalOrdersProps {
  onBack: () => void;
  embed?: boolean; // when true, do not render the internal top back/header section
}

export default function LocalOrders({ onBack, embed = false }: LocalOrdersProps) {
  const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';

  const [searchId, setSearchId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<
    Array<Pick<DbOrderRow, 'id' | 'order_code' | 'status' | 'payment_status' | 'created_at' | 'updated_at'>>
  >([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const [events, setEvents] = useState<DbOrderEventRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    if (isLocalDev) {
      setOrdersLoading(false);
      setOrdersError(null);
      try {
        const local = listLocalOrders();
        const mapped = local.map((o) => ({
            id: o.id,
            order_code: o.id,
            status: o.status,
            payment_status: (o.payment_status ?? 'unpaid') as DbOrderRow['payment_status'],
            created_at: o.created_at,
            updated_at: o.updated_at,
          }));
        mapped.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        setOrders(mapped);
      } catch {
        setOrders([]);
      }
      return;
    }

    if (!supabase) {
      setOrders([]);
      setOrdersLoading(false);
      setOrdersError('Service is currently unavailable. Please try again later.');
      return;
    }

    let active = true;
    setOrdersLoading(true);
    setOrdersError(null);
    listMyOrders()
      .then((rows) => {
        if (!active) return;
        setOrders(rows);
        // default-select newest (rows already ordered desc by created_at in listMyOrders)
        // selection will only happen if user hasn't selected one yet
        setSelectedId((prev) => (prev ? prev : rows[0]?.id ?? null));
      })
      .catch((err) => {
        if (!active) return;
        setOrdersError(err instanceof Error ? err.message : 'Failed to load orders');
      })
      .finally(() => {
        if (!active) return;
        setOrdersLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isLocalDev]);

  // When orders list changes and nothing is selected yet, select the most recent
  useEffect(() => {
    if (!selectedId && orders.length > 0) {
      setSelectedId(orders[0].id);
    }
  }, [orders, selectedId]);

  const selectedOrder = useMemo(() => {
    const id = String(selectedId ?? '').trim();
    if (!id) return null;
    return orders.find((o) => o.id === id) ?? null;
  }, [orders, selectedId]);

  const openOrder = (id: string) => {
    setSelectedId(id);
  };

  const searched = useMemo(() => {
    const q = String(searchId ?? '').trim();
    if (!q) return null;
    return orders.find((o) => o.order_code === q) ?? null;
  }, [orders, searchId]);

  useEffect(() => {
    const id = String(selectedId ?? '').trim();
    if (!id) {
      setEvents([]);
      setEventsError(null);
      setEventsLoading(false);
      return;
    }

     if (isLocalDev) {
      setEventsLoading(false);
      setEventsError(null);
      try {
        const local = getLocalOrderById(id);
        const evs = Array.isArray(local?.status_events) ? local?.status_events : [];
        setEvents(
          evs.map((ev) => ({
            status: ev.status,
            at: ev.at,
            note: typeof ev.note === 'string' ? ev.note : null,
          }))
        );
      } catch {
        setEvents([]);
      }
      return;
    }

    if (!supabase) {
      setEvents([]);
      setEventsLoading(false);
      setEventsError('Service is currently unavailable. Please try again later.');
      return;
    }

    let active = true;
    setEventsLoading(true);
    setEventsError(null);
    getOrderEventsForMyOrder(id)
      .then((rows) => {
        if (!active) return;
        setEvents(rows);
      })
      .catch((err) => {
        if (!active) return;
        setEventsError(err instanceof Error ? err.message : 'Failed to load timeline');
        setEvents([]);
      })
      .finally(() => {
        if (!active) return;
        setEventsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isLocalDev, selectedId]);

  const startPayment = async () => {
    if (!selectedOrder) return;
    setPayLoading(true);
    setPayError(null);
    try {
      if (isLocalDev) {
        updateLocalOrderPaymentStatus(selectedOrder.order_code, 'paid', 'Payment received');
        try {
          const local = listLocalOrders();
          setOrders(
            local.map((o) => ({
              id: o.id,
              order_code: o.id,
              status: o.status,
              payment_status: (o.payment_status ?? 'unpaid') as DbOrderRow['payment_status'],
              created_at: o.created_at,
              updated_at: o.updated_at,
            }))
          );
        } catch {
          // ignore
        }
        try {
          const updated = getLocalOrderById(selectedOrder.order_code);
          const evs = Array.isArray(updated?.status_events) ? updated?.status_events : [];
          setEvents(
            evs.map((ev) => ({
              status: ev.status,
              at: ev.at,
              note: typeof ev.note === 'string' ? ev.note : null,
            }))
          );
        } catch {
          // ignore
        }
        return;
      }

      if (!supabase) {
        throw new Error('Payments are currently unavailable. Please try again later.');
      }

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/.netlify/functions/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_code: selectedOrder.order_code, access_token: token }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Failed to start checkout');
      }
      const json = (await res.json().catch(() => null)) as { url?: unknown } | null;
      const url = String(json?.url ?? '').trim();
      if (!url) throw new Error('Missing checkout url');
      window.location.href = url;
    } catch (err) {
      setPayError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setPayLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        {embed ? (
          <div className="mb-2">
            <div className="text-lg sm:text-xl font-bold text-gray-900">Tracking</div>
            <div className="text-xs sm:text-sm text-gray-600">Track your order status.</div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div>
              <div className="text-lg sm:text-xl font-bold text-gray-900">Tracking</div>
              <div className="text-xs sm:text-sm text-gray-600">Track your order status.</div>
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="lg:col-span-1">
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-100">
                <div className="text-sm font-semibold text-gray-900">Find an order</div>
                <div className="mt-3 flex flex-col sm:flex-row gap-2">
                  <input
                    value={searchId}
                    onChange={(e) => setSearchId(e.target.value)}
                    placeholder="Enter Order ID (e.g. EDC-YYYYMMDD-XXXXXX)"
                    className="w-full sm:flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const found = searched;
                      if (found) openOrder(found.id);
                    }}
                    className="w-full sm:w-auto rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                  >
                    Open
                  </button>
                </div>
                {searchId.trim() && !searched && <div className="mt-2 text-xs text-gray-500">No order found.</div>}
              </div>

              <div className="p-4">
                <div className="text-sm font-semibold text-gray-900">Recent orders</div>
                <div className="mt-3 space-y-2">
                  {ordersLoading ? (
                    <div className="text-sm text-gray-600">Loading…</div>
                  ) : ordersError ? (
                    <div className="text-sm text-gray-600">{ordersError}</div>
                  ) : orders.length === 0 ? (
                    <div className="text-sm text-gray-600">No orders yet.</div>
                  ) : (
                    orders.slice(0, 25).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => openOrder(o.id)}
                        className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                          selectedId === o.id ? 'border-cyan-400 bg-cyan-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-gray-900 truncate">{o.order_code}</div>
                          <div className="text-xs font-semibold text-gray-700">{o.status}</div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-100">
                <div className="text-sm font-semibold text-gray-900">Tracking / Order Status</div>
                <div className="text-xs text-gray-600">View status timeline.</div>
              </div>

              {!selectedOrder ? (
                <div className="p-6 text-sm text-gray-600">Select an order from the list to view details.</div>
              ) : (
                <div className="p-4 sm:p-6 space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-xs font-medium text-gray-500">Order ID</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900 break-all">{selectedOrder.order_code}</div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-xs font-medium text-gray-500">Status</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">{selectedOrder.status}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-gray-200 bg-white p-4 sm:col-span-3">
                      <div className="text-xs font-medium text-gray-500">Last update</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">
                        {events?.[0]?.at ?? selectedOrder.updated_at ?? selectedOrder.created_at}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-4">
                    <div className="text-sm font-semibold text-gray-900">Notes</div>
                    <div className="mt-1 text-sm text-gray-800">{events?.[0]?.note ?? '-'}</div>
                  </div>

                  {selectedOrder.payment_status !== 'paid' && (
                    <div className="rounded-2xl border border-gray-200 bg-white p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">Payment</div>
                          <div className="text-xs text-gray-600">Status: {selectedOrder.payment_status}</div>
                          {payError && <div className="mt-1 text-xs text-red-600">{payError}</div>}
                        </div>
                        <button
                          type="button"
                          disabled={payLoading}
                          onClick={startPayment}
                          className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60"
                        >
                          {payLoading ? 'Redirecting…' : 'Pay now'}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="rounded-2xl border border-gray-200 bg-white p-4">
                    <div className="text-sm font-semibold text-gray-900">Status timeline</div>
                    <div className="mt-3 space-y-2">
                      {eventsLoading ? (
                        <div className="text-sm text-gray-600">Loading…</div>
                      ) : eventsError ? (
                        <div className="text-sm text-gray-600">{eventsError}</div>
                      ) : events.length === 0 ? (
                        <div className="text-sm text-gray-600">No events.</div>
                      ) : (
                        events.map((ev, idx) => (
                          <div key={`${ev.at}-${idx}`} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm font-semibold text-gray-900">{ev.status}</div>
                              <div className="text-xs text-gray-500">{ev.at}</div>
                            </div>
                            {ev.note && <div className="mt-1 text-sm text-gray-700">{ev.note}</div>}
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
