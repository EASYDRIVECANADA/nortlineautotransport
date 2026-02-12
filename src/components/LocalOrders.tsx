import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  createOfferForOrder,
  getMyPendingOfferForOrder,
  getMyLatestOfferForOrder,
  listMyOrders,
  getOrderEventsForMyOrder,
  getAccessToken,
  type DbOrderEventRow,
  type DbOrderRow,
  type DbOrderStage,
} from '../orders/supabaseOrders';
import { supabase } from '../lib/supabaseClient';
import {
  createLocalOfferForOrder,
  getLocalLatestOfferForOrder,
  getLocalPendingOfferForOrder,
  getLocalOrderById,
  listLocalOrders,
  updateLocalOrderPaymentStatus,
} from '../orders/localOrders';

interface LocalOrdersProps {
  onBack: () => void;
  embed?: boolean; // when true, do not render the internal top back/header section
}

export default function LocalOrders({ onBack, embed = false }: LocalOrdersProps) {
  const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';
  const OPEN_OFFER_ORDER_ID_KEY = 'ed_open_offer_order_id';

  const reloadOrders = useCallback(async () => {
    if (isLocalDev) {
      try {
        const local = listLocalOrders();
        const mapped = local.map((o) => ({
            id: o.id,
            order_code: o.id,
            status: o.status,
            payment_status: (o.payment_status ?? 'unpaid') as DbOrderRow['payment_status'],
            order_stage: (o.order_stage ?? 'pending_payment') as DbOrderStage,
            price_before_tax: Number((o as { price_before_tax?: unknown })?.price_before_tax ?? o?.totals?.subtotal ?? 0),
            final_price_before_tax: (o as { final_price_before_tax?: unknown })?.final_price_before_tax as number | null,
            route_area: String(o?.route_area ?? ''),
            created_at: o.created_at,
            updated_at: o.updated_at,
          }));
        mapped.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        setOrders(mapped);
        setOrdersError(null);
      } catch {
        setOrders([]);
      } finally {
        setOrdersLoading(false);
      }
      return;
    }

    if (!supabase) {
      setOrders([]);
      setOrdersLoading(false);
      setOrdersError('Service is currently unavailable. Please try again later.');
      return;
    }

    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const rows = await listMyOrders();
      setOrders(rows);
      setSelectedId((prev) => (prev ? prev : rows[0]?.id ?? null));
    } catch (err) {
      setOrdersError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setOrdersLoading(false);
    }
  }, [isLocalDev]);

  const [searchId, setSearchId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<
    Array<
      Pick<
        DbOrderRow,
        | 'id'
        | 'order_code'
        | 'status'
        | 'payment_status'
        | 'order_stage'
        | 'price_before_tax'
        | 'final_price_before_tax'
        | 'route_area'
        | 'created_at'
        | 'updated_at'
      >
    >
  >([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const [events, setEvents] = useState<DbOrderEventRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [offerOpen, setOfferOpen] = useState(false);
  const [offerAmount, setOfferAmount] = useState('');
  const [offerNotes, setOfferNotes] = useState('');
  const [offerLoading, setOfferLoading] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerSuccess, setOfferSuccess] = useState<string | null>(null);
  const [latestOffer, setLatestOffer] = useState<
    | {
        offer_amount: number;
        notes: string | null;
        status: 'pending' | 'approved' | 'declined';
        admin_note: string | null;
        created_at: string;
        reviewed_at: string | null;
      }
    | null
  >(null);
  const [latestOfferLoading, setLatestOfferLoading] = useState(false);

  useEffect(() => {
    void reloadOrders();
  }, [reloadOrders]);

  useEffect(() => {
    let targetId = '';
    try {
      targetId = String(localStorage.getItem(OPEN_OFFER_ORDER_ID_KEY) ?? '').trim();
    } catch {
      targetId = '';
    }
    if (!targetId) return;

    // only clear the flag after we see the order list, otherwise it can be lost
    if (orders.length === 0) return;
    if (!orders.some((o) => o.id === targetId)) return;

    setSelectedId(targetId);
    setOfferError(null);
    setOfferSuccess(null);
    setOfferAmount('');
    setOfferNotes('');
    setOfferOpen(true);
    try {
      localStorage.removeItem(OPEN_OFFER_ORDER_ID_KEY);
    } catch {
      // ignore
    }
  }, [orders, isLocalDev]);

  // When orders list changes and nothing is selected yet, select the most recent
  useEffect(() => {
    if (!selectedId && orders.length > 0) {
      setSelectedId(orders[0].id);
    }
  }, [orders, selectedId]);

  const stageBuckets = useMemo(() => {
    const normalizeStage = (s: unknown): DbOrderStage => {
      const v = String(s ?? '').trim();
      if (v === 'draft' || v === 'in_negotiation' || v === 'pending_payment' || v === 'order_dispatched' || v === 'order_completed') return v;
      return 'pending_payment';
    };
    const items = orders.map((o) => ({ ...o, order_stage: normalizeStage((o as { order_stage?: unknown }).order_stage) }));
    const byStage = (stage: DbOrderStage) => items.filter((o) => (o.order_stage ?? 'pending_payment') === stage);
    return {
      draft: byStage('draft'),
      in_negotiation: byStage('in_negotiation'),
      pending_payment: byStage('pending_payment'),
      order_dispatched: byStage('order_dispatched'),
      order_completed: byStage('order_completed'),
    };
  }, [orders]);

  const formatAmount = (row: (typeof orders)[number]) => {
    const finalRaw = Number((row as { final_price_before_tax?: unknown }).final_price_before_tax);
    const baseRaw = Number((row as { price_before_tax?: unknown }).price_before_tax);
    const v = Number.isFinite(finalRaw) && finalRaw > 0 ? finalRaw : baseRaw;
    return Number.isFinite(v) && v > 0 ? `$${v.toFixed(2)}` : '-';
  };

  const formatStageLabel = (stageRaw: unknown) => {
    const stage = String(stageRaw ?? '').trim();
    if (stage === 'draft') return 'Draft';
    if (stage === 'in_negotiation') return 'In negotiation';
    if (stage === 'pending_payment') return 'Pending payment';
    if (stage === 'order_dispatched') return 'Dispatched';
    if (stage === 'order_completed') return 'Completed';
    return 'Pending payment';
  };

  const stageBadgeClass = (stageRaw: unknown) => {
    const stage = String(stageRaw ?? '').trim();
    if (stage === 'draft') return 'bg-slate-100 text-slate-700 ring-slate-200';
    if (stage === 'in_negotiation') return 'bg-amber-50 text-amber-800 ring-amber-200';
    if (stage === 'pending_payment') return 'bg-blue-50 text-blue-800 ring-blue-200';
    if (stage === 'order_dispatched') return 'bg-cyan-50 text-cyan-800 ring-cyan-200';
    if (stage === 'order_completed') return 'bg-emerald-50 text-emerald-800 ring-emerald-200';
    return 'bg-blue-50 text-blue-800 ring-blue-200';
  };

  const openOffer = () => {
    setOfferError(null);
    setOfferSuccess(null);
    setOfferAmount('');
    setOfferNotes('');
    setOfferOpen(true);
  };

  const submitOffer = async () => {
    if (!selectedOrder) return;
    const amount = Number(offerAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setOfferError('Please enter a valid offer amount.');
      return;
    }
    setOfferLoading(true);
    setOfferError(null);
    setOfferSuccess(null);
    try {
      if (isLocalDev) {
        const pending = getLocalPendingOfferForOrder(selectedOrder.id);
        if (pending) {
          setOfferError('You already have a pending offer for this order. Please wait for review.');
          return;
        }
        createLocalOfferForOrder(selectedOrder.id, amount, offerNotes);
        setOfferSuccess('Offer submitted. You will see it under In Negotiation.');
        setOfferOpen(false);
        await reloadOrders();
        return;
      }

      if (!supabase) {
        setOfferError('Service is currently unavailable. Please try again later.');
        return;
      }

      const pending = await getMyPendingOfferForOrder(selectedOrder.id);
      if (pending) {
        setOfferError('You already have a pending offer for this order. Please wait for admin review.');
        return;
      }
      await createOfferForOrder(selectedOrder.id, amount, offerNotes);
      setOfferSuccess('Offer submitted. You will see it under In Negotiation.');
      setOfferOpen(false);
      const rows = await listMyOrders();
      setOrders(rows);
    } catch (e) {
      setOfferError(e instanceof Error ? e.message : 'Failed to submit offer');
    } finally {
      setOfferLoading(false);
    }
  };

  const selectedOrder = useMemo(() => {
    const id = String(selectedId ?? '').trim();
    if (!id) return null;
    return orders.find((o) => o.id === id) ?? null;
  }, [orders, selectedId]);

  useEffect(() => {
    if (isLocalDev) {
      if (!selectedOrder) {
        setLatestOffer(null);
        setLatestOfferLoading(false);
        return;
      }

      setLatestOfferLoading(true);
      try {
        const row = getLocalLatestOfferForOrder(selectedOrder.id);
        if (!row) {
          setLatestOffer(null);
          return;
        }
        setLatestOffer({
          offer_amount: Number(row.offer_amount),
          notes: row.notes ?? null,
          status: row.status,
          admin_note: row.admin_note ?? null,
          created_at: row.created_at,
          reviewed_at: row.reviewed_at ?? null,
        });
      } catch {
        setLatestOffer(null);
      } finally {
        setLatestOfferLoading(false);
      }
      return;
    }
    if (!selectedOrder) {
      setLatestOffer(null);
      setLatestOfferLoading(false);
      return;
    }
    let active = true;
    setLatestOfferLoading(true);
    getMyLatestOfferForOrder(selectedOrder.id)
      .then((row) => {
        if (!active) return;
        if (!row) {
          setLatestOffer(null);
          return;
        }
        setLatestOffer({
          offer_amount: Number(row.offer_amount),
          notes: row.notes ?? null,
          status: row.status,
          admin_note: row.admin_note ?? null,
          created_at: row.created_at,
          reviewed_at: row.reviewed_at ?? null,
        });
      })
      .catch(() => {
        if (!active) return;
        setLatestOffer(null);
      })
      .finally(() => {
        if (!active) return;
        setLatestOfferLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedOrder, isLocalDev]);

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
    const stage = String((selectedOrder as { order_stage?: unknown }).order_stage ?? '').trim();
    if (stage && stage !== 'pending_payment') {
      setPayError('This order is not ready for payment yet.');
      return;
    }
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
              order_stage: (o.order_stage ?? 'pending_payment') as DbOrderStage,
              price_before_tax: Number((o as { price_before_tax?: unknown })?.price_before_tax ?? o?.totals?.subtotal ?? 0),
              final_price_before_tax: (o as { final_price_before_tax?: unknown })?.final_price_before_tax as number | null,
              route_area: String(o?.route_area ?? ''),
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

        {!ordersLoading && !ordersError && orders.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-900">No orders yet</div>
            <div className="mt-1 text-xs text-gray-600">
              If you just saved a quote, it will appear here under “Draft Orders”. If you’re signed out, please sign in again.
            </div>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => void reloadOrders()}
                className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
        ) : null}

        {ordersError ? (
          <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-900">Couldn’t load orders</div>
            <div className="mt-1 text-xs text-gray-600">{ordersError}</div>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => void reloadOrders()}
                className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {offerOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOfferOpen(false);
            }}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
            <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
              <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100">
                <div className="text-base sm:text-lg font-semibold text-gray-900">Make an Offer</div>
                <div className="mt-1 text-xs sm:text-sm text-gray-600">Enter an amount and optional notes. Admin will review.</div>
              </div>
              <div className="px-4 sm:px-6 py-4 sm:py-5 space-y-4">
                {offerError ? <div className="text-sm font-medium text-red-600">{offerError}</div> : null}
                {offerSuccess ? <div className="text-sm font-medium text-emerald-700">{offerSuccess}</div> : null}
                <div>
                  <label className="block text-sm font-semibold text-gray-900">Offer amount (CAD)</label>
                  <input
                    value={offerAmount}
                    onChange={(e) => setOfferAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="e.g. 599"
                    className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900">Notes (optional)</label>
                  <textarea
                    value={offerNotes}
                    onChange={(e) => setOfferNotes(e.target.value)}
                    rows={4}
                    placeholder="Tell us what price you want and why (discount, special situation, etc.)"
                    className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="border-t border-gray-200 bg-white p-4">
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setOfferOpen(false)}
                    className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={offerLoading}
                    onClick={() => void submitOffer()}
                    className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60"
                  >
                    {offerLoading ? 'Submitting…' : 'Submit offer'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-[minmax(320px,380px)_1fr] gap-4 sm:gap-6">
          <div>
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden flex flex-col max-h-[calc(100vh-9.5rem)]">
              <div className="p-4 border-b border-gray-100">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">Your orders</div>
                    <div className="mt-1 text-xs text-gray-600">Drafts, negotiation, payment, and delivery.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void reloadOrders()}
                    className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                  >
                    Refresh
                  </button>
                </div>

                {ordersLoading ? <div className="mt-2 text-sm text-gray-600">Loading…</div> : null}
                {ordersError ? <div className="mt-2 text-sm text-gray-600">{ordersError}</div> : null}

                <div className="mt-4">
                  <div className="text-xs font-semibold text-gray-700">Find an order</div>
                  <div className="mt-2 flex flex-col sm:flex-row gap-2">
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
                  {searchId.trim() && !searched ? <div className="mt-2 text-xs text-gray-500">No order found.</div> : null}
                </div>
              </div>

              <div className="p-4 flex-1 overflow-hidden flex flex-col">
                <div className="flex-1 overflow-auto pr-1 space-y-4">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold text-gray-600">Draft orders</div>
                      <div className="text-[11px] font-semibold text-gray-500">{stageBuckets.draft.length}</div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {stageBuckets.draft.length === 0 ? (
                        <div className="text-sm text-gray-600">No draft quotes.</div>
                      ) : (
                        stageBuckets.draft.slice(0, 20).map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => openOrder(o.id)}
                            className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
                              selectedId === o.id ? 'border-cyan-300 bg-cyan-50 shadow-sm' : 'border-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-gray-900 truncate">{o.order_code}</div>
                                <div className="mt-0.5 text-xs text-gray-600 truncate">
                                  {String((o as { route_area?: unknown }).route_area ?? '').trim() || '-'}
                                </div>
                              </div>
                              <div className="shrink-0 text-xs font-semibold text-gray-900">{formatAmount(o)}</div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold text-gray-600">In negotiation</div>
                      <div className="text-[11px] font-semibold text-gray-500">{stageBuckets.in_negotiation.length}</div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {stageBuckets.in_negotiation.length === 0 ? (
                        <div className="text-sm text-gray-600">No offers in review.</div>
                      ) : (
                        stageBuckets.in_negotiation.slice(0, 20).map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => openOrder(o.id)}
                            className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
                              selectedId === o.id ? 'border-cyan-300 bg-cyan-50 shadow-sm' : 'border-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-gray-900 truncate">{o.order_code}</div>
                                <div className="mt-0.5 text-xs text-gray-600 truncate">
                                  {String((o as { route_area?: unknown }).route_area ?? '').trim() || '-'}
                                </div>
                              </div>
                              <div className="shrink-0 text-xs font-semibold text-gray-900">{formatAmount(o)}</div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold text-gray-600">Pending payment</div>
                      <div className="text-[11px] font-semibold text-gray-500">{stageBuckets.pending_payment.length}</div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {stageBuckets.pending_payment.length === 0 ? (
                        <div className="text-sm text-gray-600">No pending payments.</div>
                      ) : (
                        stageBuckets.pending_payment.slice(0, 30).map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => openOrder(o.id)}
                            className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
                              selectedId === o.id ? 'border-cyan-300 bg-cyan-50 shadow-sm' : 'border-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-gray-900 truncate">{o.order_code}</div>
                                <div className="mt-0.5 text-xs text-gray-600 truncate">
                                  {String((o as { route_area?: unknown }).route_area ?? '').trim() || '-'}
                                </div>
                              </div>
                              <div className="shrink-0 text-xs font-semibold text-gray-900">{formatAmount(o)}</div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  {stageBuckets.order_dispatched.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-600">Dispatched</div>
                        <div className="text-[11px] font-semibold text-gray-500">{stageBuckets.order_dispatched.length}</div>
                      </div>
                      <div className="mt-2 space-y-2">
                        {stageBuckets.order_dispatched.slice(0, 20).map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => openOrder(o.id)}
                            className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                              selectedId === o.id ? 'border-cyan-300 bg-cyan-50 shadow-sm' : 'border-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm font-semibold text-gray-900 truncate">{o.order_code}</div>
                              <div className="text-xs font-semibold text-gray-700">{formatAmount(o)}</div>
                            </div>
                            <div className="mt-1 text-xs text-gray-600 truncate">{String((o as { route_area?: unknown }).route_area ?? '').trim() || '-'}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {stageBuckets.order_completed.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-600">Completed</div>
                        <div className="text-[11px] font-semibold text-gray-500">{stageBuckets.order_completed.length}</div>
                      </div>
                      <div className="mt-2 space-y-2">
                        {stageBuckets.order_completed.slice(0, 20).map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => openOrder(o.id)}
                            className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                              selectedId === o.id ? 'border-cyan-300 bg-cyan-50 shadow-sm' : 'border-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm font-semibold text-gray-900 truncate">{o.order_code}</div>
                              <div className="text-xs font-semibold text-gray-700">{formatAmount(o)}</div>
                            </div>
                            <div className="mt-1 text-xs text-gray-600 truncate">{String((o as { route_area?: unknown }).route_area ?? '').trim() || '-'}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="pt-4" />
              </div>
            </div>
          </div>

          <div>
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-100">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">Order details</div>
                    <div className="mt-1 text-xs text-gray-600">Timeline, offer status, and payment.</div>
                  </div>
                  {selectedOrder ? (
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${stageBadgeClass(
                          (selectedOrder as { order_stage?: unknown }).order_stage
                        )}`}
                      >
                        {formatStageLabel((selectedOrder as { order_stage?: unknown }).order_stage)}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-800 ring-1 ring-gray-200">
                        {selectedOrder.payment_status === 'paid' ? 'Paid' : selectedOrder.payment_status === 'pending' ? 'Payment pending' : 'Unpaid'}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>

              {!selectedOrder ? (
                <div className="p-6 text-sm text-gray-600">Select an order from the list to view details.</div>
              ) : (
                <div className="p-4 sm:p-6 space-y-5">
                  <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-gray-600">Order ID</div>
                        <div className="mt-1 text-sm sm:text-base font-bold text-gray-900 break-all">{selectedOrder.order_code}</div>
                        <div className="mt-1 text-xs text-gray-600">Route: {String((selectedOrder as { route_area?: unknown }).route_area ?? '').trim() || '-'}</div>
                      </div>
                      <div className="flex flex-col items-start sm:items-end gap-1">
                        <div className="text-xs font-semibold text-gray-600">Price (before tax)</div>
                        <div className="text-lg font-bold text-gray-900">{formatAmount(selectedOrder)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-xs font-medium text-gray-500">Shipping status</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">{selectedOrder.status}</div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-xs font-medium text-gray-500">Last update</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">{events?.[0]?.at ?? selectedOrder.updated_at ?? selectedOrder.created_at}</div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-4">
                    <div className="text-sm font-semibold text-gray-900">Notes</div>
                    <div className="mt-1 text-sm text-gray-800">{events?.[0]?.note ?? '-'}</div>
                  </div>

                  {!latestOfferLoading && latestOffer ? (
                    <div className="rounded-2xl border border-gray-200 bg-white p-4">
                      <div className="text-sm font-semibold text-gray-900">Your offer</div>
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs font-medium text-gray-500">Amount</div>
                          <div className="mt-1 font-semibold text-gray-900">${Number(latestOffer.offer_amount || 0).toFixed(2)}</div>
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs font-medium text-gray-500">Status</div>
                          <div className="mt-1 font-semibold text-gray-900">{latestOffer.status}</div>
                          {latestOffer.reviewed_at ? <div className="mt-1 text-xs text-gray-600">Reviewed: {latestOffer.reviewed_at}</div> : null}
                        </div>
                      </div>

                      {latestOffer.notes ? (
                        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs font-medium text-gray-500">Your notes</div>
                          <div className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{latestOffer.notes}</div>
                        </div>
                      ) : null}

                      {latestOffer.admin_note ? (
                        <div className="mt-3 rounded-xl border border-gray-200 bg-amber-50 p-3">
                          <div className="text-xs font-medium text-amber-900">Admin response</div>
                          <div className="mt-1 text-sm text-amber-900 whitespace-pre-wrap">{latestOffer.admin_note}</div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {String((selectedOrder as { order_stage?: unknown }).order_stage ?? '') === 'draft' && (
                    <div className="rounded-2xl border border-gray-200 bg-white p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">Negotiation</div>
                          <div className="text-xs text-gray-600">Request a manual price adjustment.</div>
                        </div>
                        <button
                          type="button"
                          onClick={openOffer}
                          className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                        >
                          Make an Offer
                        </button>
                      </div>
                    </div>
                  )}

                  {String((selectedOrder as { order_stage?: unknown }).order_stage ?? '') === 'in_negotiation' && (
                    <div className="rounded-2xl border border-gray-200 bg-white p-4">
                      <div className="text-sm font-semibold text-gray-900">Offer submitted</div>
                      <div className="mt-1 text-xs text-gray-600">Your offer is under review. You’ll be able to pay once approved.</div>
                    </div>
                  )}

                  {String((selectedOrder as { order_stage?: unknown }).order_stage ?? '') === 'pending_payment' && selectedOrder.payment_status !== 'paid' && (
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
