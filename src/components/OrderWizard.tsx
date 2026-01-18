import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle, FileText, MapPin, Package, ShieldCheck, User } from 'lucide-react';
import {
  PRICING_TABLE,
  getFulfillmentDaysForRoute,
  getOfficialCityPriceForAddress,
  getPricingRow,
  type ServiceType,
  type VehicleType,
} from '../pricing/pricingTable';
import { computeTotals, makeLocalOrderId, upsertLocalOrder, updateLocalOrderPaymentStatus } from '../orders/localOrders';
import { createOrderWithInitialEvent, getAccessToken } from '../orders/supabaseOrders';
import { supabase } from '../lib/supabaseClient';

type WizardStep = 'quote' | 'info' | 'addresses' | 'docs' | 'disclosures' | 'payment' | 'confirmation';

interface OrderWizardProps {
  onBack: () => void;
  onGoToOrders: () => void;
}

const STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: 'quote', label: 'Quote' },
  { id: 'info', label: 'Info' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'docs', label: 'Docs' },
  { id: 'disclosures', label: 'Disclosures' },
  { id: 'payment', label: 'Payment' },
  { id: 'confirmation', label: 'Confirmation' },
];

const DRAFT_STORAGE_KEY = 'ed_order_wizard_draft_v1';

type OrderWizardDraft = {
  step: WizardStep;
  serviceType: ServiceType;
  routeArea: string;
  customer: { name: string; email: string; phone: string };
  dealer: { name: string; email: string; phone: string };
  pickupAddress: string;
  dropoffAddress: string;
  docs: Array<{ id: string; name: string; mime: string; size: number; kind: 'required' | 'optional' | 'unknown' }>;
  disclosuresAccepted: { timelines: boolean; payments: boolean; inTransit: boolean };
  paymentMethod: 'stripe_checkout';
  createdOrderId: string | null;
};

const loadDraft = (): OrderWizardDraft | null => {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as OrderWizardDraft;
  } catch {
    return null;
  }
};

const clearDraft = () => {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export default function OrderWizard({ onBack, onGoToOrders }: OrderWizardProps) {
  const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';

  const extractionUrl = (() => {
    const envUrl = String(import.meta.env.VITE_EXTRACTION_URL ?? '').trim();
    if (envUrl) return envUrl;
    const fnPath = '/.netlify/functions/extract-documents';
    if (import.meta.env.DEV) {
      const isNetlifyDev = String(window.location.port ?? '') === '8888';
      return isNetlifyDev ? fnPath : `http://localhost:8888${fnPath}`;
    }
    return fnPath;
  })();

  const [step, setStep] = useState<WizardStep>(() => loadDraft()?.step ?? 'quote');
  const [serviceType, setServiceType] = useState<ServiceType>(() => loadDraft()?.serviceType ?? 'pickup_one_way');
  const [vehicleType] = useState<VehicleType>('standard');
  const [routeArea, setRouteArea] = useState<string>(() => loadDraft()?.routeArea ?? '');

  const [customer, setCustomer] = useState(() => loadDraft()?.customer ?? { name: '', email: '', phone: '' });
  const [dealer, setDealer] = useState(() => loadDraft()?.dealer ?? { name: '', email: '', phone: '' });

  const [pickupAddress, setPickupAddress] = useState(() => loadDraft()?.pickupAddress ?? '');
  const [dropoffAddress, setDropoffAddress] = useState(() => loadDraft()?.dropoffAddress ?? '');

  const [docs, setDocs] = useState<
    Array<{ id: string; name: string; mime: string; size: number; kind: 'required' | 'optional' | 'unknown' }>
  >(() => loadDraft()?.docs ?? []);

  const [extractFile, setExtractFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const [disclosuresAccepted, setDisclosuresAccepted] = useState(
    () => loadDraft()?.disclosuresAccepted ?? { timelines: false, payments: false, inTransit: false }
  );
  const [paymentMethod, setPaymentMethod] = useState<'stripe_checkout'>(() => loadDraft()?.paymentMethod ?? 'stripe_checkout');

  const [createdOrderId, setCreatedOrderId] = useState<string | null>(() => loadDraft()?.createdOrderId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [payLoading, setPayLoading] = useState(false);

  useEffect(() => {
    try {
      const draft: OrderWizardDraft = {
        step,
        serviceType,
        routeArea,
        customer,
        dealer,
        pickupAddress,
        dropoffAddress,
        docs,
        disclosuresAccepted,
        paymentMethod,
        createdOrderId,
      };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // ignore
    }
  }, [
    step,
    serviceType,
    routeArea,
    customer,
    dealer,
    pickupAddress,
    dropoffAddress,
    docs,
    disclosuresAccepted,
    paymentMethod,
    createdOrderId,
  ]);

  const fileToBase64 = (file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result ?? '');
        const comma = res.indexOf(',');
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  };

  const extractAndAutofill = async () => {
    if (!extractFile) {
      setExtractError('Please select a document to extract.');
      return;
    }
    if (isExtracting) return;

    setExtractError(null);
    setIsExtracting(true);

    try {
      const base64 = await fileToBase64(extractFile);
      const res = await fetch(extractionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            {
              name: extractFile.name,
              type: extractFile.type,
              size: extractFile.size,
              base64,
            },
          ],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Extraction failed (${res.status})`);
      }

      const data = (await res.json().catch(() => null)) as unknown;
      const firstOutput = Array.isArray(data)
        ? (() => {
            const first = data[0] as unknown;
            if (!first || typeof first !== 'object') return null;
            return (first as Record<string, unknown>)?.output ?? null;
          })()
        : null;
      const extracted = firstOutput ?? data;
      const extractedObj = extracted && typeof extracted === 'object' ? (extracted as Record<string, unknown>) : null;

      const pickupLoc = extractedObj?.pickup_location;
      const pickupObj = pickupLoc && typeof pickupLoc === 'object' ? (pickupLoc as Record<string, unknown>) : null;
      const pickupAlt = extractedObj?.pickup;
      const pickupAltObj = pickupAlt && typeof pickupAlt === 'object' ? (pickupAlt as Record<string, unknown>) : null;

      const dropLoc = extractedObj?.dropoff_location;
      const dropObj = dropLoc && typeof dropLoc === 'object' ? (dropLoc as Record<string, unknown>) : null;
      const dropAlt = extractedObj?.dropoff;
      const dropAltObj = dropAlt && typeof dropAlt === 'object' ? (dropAlt as Record<string, unknown>) : null;

      const serviceVal = extractedObj?.service;
      const serviceObj = serviceVal && typeof serviceVal === 'object' ? (serviceVal as Record<string, unknown>) : null;

      const pickupAddr = String(pickupObj?.address ?? pickupAltObj?.address ?? extractedObj?.pickup_address ?? '').trim();
      const dropoffAddr = String(dropObj?.address ?? dropAltObj?.address ?? extractedObj?.dropoff_address ?? '').trim();
      const svcRaw = String(serviceObj?.service_type ?? extractedObj?.service_type ?? '').trim();

      if (pickupAddr) setPickupAddress(pickupAddr);
      if (dropoffAddr) setDropoffAddress(dropoffAddr);
      if (svcRaw === 'delivery_one_way' || svcRaw === 'pickup_one_way') setServiceType(svcRaw as ServiceType);

      const official = getOfficialCityPriceForAddress(dropoffAddr || pickupAddr);
      if (official?.city) setRouteArea(official.city);

      setDocs((prev) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const nextDoc = {
          id,
          name: extractFile.name,
          mime: extractFile.type,
          size: extractFile.size,
          kind: 'unknown' as const,
        };
        return [nextDoc, ...prev];
      });
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed');
    } finally {
      setIsExtracting(false);
    }
  };

  const routeOptions = useMemo(() => PRICING_TABLE.map((r) => r.route), []);

  const quoteSubtotal = useMemo(() => {
    const row = getPricingRow(routeArea, vehicleType);
    const retail = Number(row?.retail_price ?? 0);
    return Number.isFinite(retail) ? retail : 0;
  }, [routeArea, vehicleType]);

  const totals = useMemo(() => computeTotals(quoteSubtotal, routeArea), [quoteSubtotal, routeArea]);

  const fulfillment = useMemo(() => getFulfillmentDaysForRoute(routeArea), [routeArea]);

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const goNext = () => {
    setError(null);

    if (step === 'quote') {
      if (!routeArea.trim()) {
        setError('Please select a destination (pricing city) to continue.');
        return;
      }
      setStep('info');
      return;
    }

    if (step === 'info') {
      if (!customer.name.trim() || !customer.email.trim()) {
        setError('Please enter your name and email to continue.');
        return;
      }
      setStep('addresses');
      return;
    }

    if (step === 'addresses') {
      if (!pickupAddress.trim() || !dropoffAddress.trim()) {
        setError('Please enter both pickup and drop-off addresses.');
        return;
      }
      setStep('docs');
      return;
    }

    if (step === 'docs') {
      const requiredCount = docs.filter((d) => d.kind === 'required').length;
      if (requiredCount < 2) {
        setError('Please upload and mark both required documents (Vehicle Release Form and Work Order) to continue.');
        return;
      }
      setStep('disclosures');
      return;
    }

    if (step === 'disclosures') {
      const accepted = disclosuresAccepted.timelines && disclosuresAccepted.payments && disclosuresAccepted.inTransit;
      if (!accepted) {
        setError('Please accept all disclosures to continue.');
        return;
      }
      setStep('payment');
      return;
    }

    if (step === 'payment') {
      if (paymentMethod !== 'stripe_checkout') {
        setError('Please select a payment method.');
        return;
      }
      const orderCode = makeLocalOrderId();

      if (isLocalDev) {
        const now = new Date().toISOString();
        upsertLocalOrder({
          id: orderCode,
          created_at: now,
          updated_at: now,
          service_type: serviceType,
          vehicle_type: vehicleType,
          route_area: routeArea,
          fulfillment_days_min: fulfillment.days_min,
          fulfillment_days_max: fulfillment.days_max,
          totals,
          customer,
          dealer,
          documents: docs.map((d) => ({
            id: d.id,
            name: d.name,
            mime: d.mime,
            size: d.size,
            kind: d.kind,
          })),
          status: 'Scheduled',
          status_events: [{ status: 'Scheduled', at: now, note: 'Order created' }],
          payment_status: 'unpaid',
        });

        clearDraft();
        setCreatedOrderId(orderCode);
        setStep('confirmation');
        return;
      }

      if (!supabase) {
        setError('Service is currently unavailable. Please try again later.');
        return;
      }

      createOrderWithInitialEvent({
        order_code: orderCode,
        customer_name: customer.name.trim(),
        customer_email: customer.email.trim(),
        route_area: routeArea,
        service_type: serviceType,
        vehicle_type: vehicleType,
        price_before_tax: totals.subtotal,
        currency: 'CAD',
      })
        .then(() => {
          clearDraft();
          setCreatedOrderId(orderCode);
          setStep('confirmation');
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Failed to create order');
        });
      return;
    }
  };

  const startCheckoutForOrder = async (orderCode: string) => {
    setPayLoading(true);
    setError(null);
    try {
      if (isLocalDev) {
        updateLocalOrderPaymentStatus(orderCode, 'paid', 'Payment received');
        onGoToOrders();
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
        body: JSON.stringify({ order_code: orderCode, access_token: token }),
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
      setError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setPayLoading(false);
    }
  };

  const goBackStep = () => {
    setError(null);

    if (step === 'quote') {
      onBack();
      return;
    }

    if (step === 'info') return setStep('quote');
    if (step === 'addresses') return setStep('info');
    if (step === 'docs') return setStep('addresses');
    if (step === 'disclosures') return setStep('docs');
    if (step === 'payment') return setStep('disclosures');
    if (step === 'confirmation') return setStep('payment');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={goBackStep}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div>
            <div className="text-lg sm:text-xl font-bold text-gray-900">New Order</div>
            <div className="text-xs sm:text-sm text-gray-600">Step {stepIndex + 1} of {STEPS.length}</div>
          </div>
        </div>

        <div className="mt-4 rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <div className="flex flex-wrap gap-2">
              {STEPS.map((s) => {
                const active = s.id === step;
                const done = STEPS.findIndex((x) => x.id === s.id) < stepIndex;
                return (
                  <div
                    key={s.id}
                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold border ${
                      active
                        ? 'bg-cyan-50 border-cyan-200 text-cyan-800'
                        : done
                          ? 'bg-green-50 border-green-200 text-green-800'
                          : 'bg-gray-50 border-gray-200 text-gray-600'
                    }`}
                  >
                    {done ? <CheckCircle className="h-4 w-4" /> : null}
                    {s.label}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-4 sm:p-6">
            {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

            {step === 'quote' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <Package className="h-4 w-4" />
                  Quote
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Service type</div>
                    <select
                      value={serviceType}
                      onChange={(e) => setServiceType(e.target.value as ServiceType)}
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="pickup_one_way">Pickup (one-way)</option>
                      <option value="delivery_one_way">Delivery (one-way)</option>
                    </select>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Destination (pricing city)</div>
                    <select
                      value={routeArea}
                      onChange={(e) => setRouteArea(e.target.value)}
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="">Select a destination</option>
                      {routeOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Price (before tax)</div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl bg-white border border-gray-200 p-3">
                      <div className="text-xs text-gray-500">Price (before tax)</div>
                      <div className="mt-1 font-bold text-gray-900">${totals.subtotal}</div>
                      <div className="text-xs text-gray-500">Note: + applicable tax.</div>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-gray-600">
                    Estimated delivery time: {routeArea.toLowerCase().includes('montreal') ? 'as fast as 1–2 business days' : 'usually 3–8 business days'}
                    .
                  </div>
                  <div className="mt-1 text-xs text-gray-500">Vehicle type: {vehicleType}</div>
                </div>
              </div>
            )}

            {step === 'info' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <User className="h-4 w-4" />
                  Customer & dealer info
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Customer name *</div>
                    <input
                      value={customer.name}
                      onChange={(e) => setCustomer((p) => ({ ...p, name: e.target.value }))}
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                      placeholder="Full name"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Customer email *</div>
                    <input
                      value={customer.email}
                      onChange={(e) => setCustomer((p) => ({ ...p, email: e.target.value }))}
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                      placeholder="name@email.com"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Customer phone</div>
                    <input
                      value={customer.phone}
                      onChange={(e) => setCustomer((p) => ({ ...p, phone: e.target.value }))}
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                      placeholder="(optional)"
                    />
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Dealer (optional)</div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs font-medium text-gray-600 mb-2">Dealer name</div>
                      <input
                        value={dealer.name}
                        onChange={(e) => setDealer((p) => ({ ...p, name: e.target.value }))}
                        className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        placeholder="(optional)"
                      />
                    </div>
                    <div>
                      <div className="text-xs font-medium text-gray-600 mb-2">Dealer email</div>
                      <input
                        value={dealer.email}
                        onChange={(e) => setDealer((p) => ({ ...p, email: e.target.value }))}
                        className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        placeholder="(optional)"
                      />
                    </div>
                    <div>
                      <div className="text-xs font-medium text-gray-600 mb-2">Dealer phone</div>
                      <input
                        value={dealer.phone}
                        onChange={(e) => setDealer((p) => ({ ...p, phone: e.target.value }))}
                        className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        placeholder="(optional)"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {step === 'addresses' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <MapPin className="h-4 w-4" />
                  Addresses
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Pickup address *</div>
                    <textarea
                      value={pickupAddress}
                      onChange={(e) => setPickupAddress(e.target.value)}
                      className="w-full min-h-[90px] rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                      placeholder="Full pickup address"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-600 mb-2">Drop-off address *</div>
                    <textarea
                      value={dropoffAddress}
                      onChange={(e) => setDropoffAddress(e.target.value)}
                      className="w-full min-h-[90px] rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                      placeholder="Full drop-off address"
                    />
                  </div>
                </div>
              </div>
            )}

            {step === 'docs' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <FileText className="h-4 w-4" />
                  Documents
                </div>

                <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                  <div className="p-4 border-b border-gray-100">
                    <div className="text-sm font-semibold text-gray-900">Extract & Autofill (optional)</div>
                    <div className="text-xs text-gray-600">Upload a document to auto-fill addresses and destination.</div>
                  </div>
                  <div className="p-4 space-y-3">
                    <input
                      type="file"
                      onChange={(e) => setExtractFile((e.target.files?.[0] as File | undefined) ?? null)}
                      className="block w-full text-sm"
                    />
                    {extractError && <div className="text-sm text-red-700">{extractError}</div>}
                    <button
                      type="button"
                      onClick={extractAndAutofill}
                      disabled={isExtracting || !extractFile}
                      className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60"
                    >
                      {isExtracting ? 'Extracting...' : 'Extract & Autofill'}
                    </button>
                  </div>
                </div>

                <input
                  type="file"
                  multiple
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
                    const invalid = files.find((f) => {
                      const name = String(f.name ?? '').toLowerCase();
                      return !allowed.some((ext) => name.endsWith(ext));
                    });
                    if (invalid) {
                      setError('Unsupported file type. Please upload PDF, JPG, or PNG.');
                      e.target.value = '';
                      return;
                    }
                    const mapped = files.map((f) => ({
                      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      name: f.name,
                      mime: f.type,
                      size: f.size,
                      kind: 'unknown' as const,
                    }));
                    setDocs((prev) => [...mapped, ...prev]);
                    e.target.value = '';
                  }}
                  className="block w-full text-sm"
                />

                <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                  <div className="p-4 border-b border-gray-100">
                    <div className="text-sm font-semibold text-gray-900">Uploaded</div>
                    <div className="text-xs text-gray-600">You can classify each document for partner/backend mapping later.</div>
                  </div>
                  <div className="p-4 space-y-2">
                    {docs.length === 0 ? (
                      <div className="text-sm text-gray-600">No documents uploaded.</div>
                    ) : (
                      docs.map((d) => (
                        <div key={d.id} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div className="text-sm font-semibold text-gray-900 truncate">{d.name}</div>
                            <div className="flex items-center gap-2">
                              <select
                                value={d.kind}
                                onChange={(e) => {
                                  const kind = e.target.value as 'required' | 'optional' | 'unknown';
                                  setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, kind } : x)));
                                }}
                                className="rounded-xl border border-gray-300 bg-white px-2 py-1.5 text-xs"
                              >
                                <option value="unknown">Unknown</option>
                                <option value="required">Required</option>
                                <option value="optional">Optional</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => setDocs((prev) => prev.filter((x) => x.id !== d.id))}
                                className="rounded-xl border border-gray-300 bg-white px-2 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-gray-600">{d.mime || 'unknown'} • {d.size} bytes</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {step === 'disclosures' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <ShieldCheck className="h-4 w-4" />
                  Disclosures
                </div>

                <div className="space-y-3">
                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={disclosuresAccepted.timelines}
                      onChange={(e) => setDisclosuresAccepted((p) => ({ ...p, timelines: e.target.checked }))}
                      className="mt-1 h-4 w-4"
                    />
                    <div className="text-sm text-gray-700">Timelines are estimates (weather, routing, and scheduling may affect delivery).</div>
                  </label>

                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={disclosuresAccepted.payments}
                      onChange={(e) => setDisclosuresAccepted((p) => ({ ...p, payments: e.target.checked }))}
                      className="mt-1 h-4 w-4"
                    />
                    <div className="text-sm text-gray-700">Customers remain responsible for vehicle payments during transit.</div>
                  </label>

                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={disclosuresAccepted.inTransit}
                      onChange={(e) => setDisclosuresAccepted((p) => ({ ...p, inTransit: e.target.checked }))}
                      className="mt-1 h-4 w-4"
                    />
                    <div className="text-sm text-gray-700">Once picked up, the vehicle is considered “in transit.”</div>
                  </label>
                </div>
              </div>
            )}

            {step === 'payment' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <Package className="h-4 w-4" />
                  Payment
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Amount due</div>
                  <div className="mt-2 text-3xl font-bold text-gray-900">${totals.total}</div>
                  <div className="mt-1 text-xs text-gray-600">Payable now (includes tax).</div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <div className="rounded-xl bg-white border border-gray-200 p-3">
                      <div className="text-xs text-gray-500">Subtotal (before tax)</div>
                      <div className="mt-1 font-semibold text-gray-900">${totals.subtotal}</div>
                    </div>
                    <div className="rounded-xl bg-white border border-gray-200 p-3">
                      <div className="text-xs text-gray-500">Tax {totals.tax_note ? `(${totals.tax_note})` : ''}</div>
                      <div className="mt-1 font-semibold text-gray-900">${totals.tax}</div>
                      <div className="text-xs text-gray-500">Rate: {(totals.tax_rate * 100).toFixed(3)}%</div>
                    </div>
                    <div className="rounded-xl bg-white border border-gray-200 p-3">
                      <div className="text-xs text-gray-500">Total</div>
                      <div className="mt-1 font-bold text-gray-900">${totals.total}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-white p-4">
                  <div className="text-sm font-semibold text-gray-900">Payment method</div>
                  <label className="mt-3 flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <input
                      type="radio"
                      checked={paymentMethod === 'stripe_checkout'}
                      onChange={() => setPaymentMethod('stripe_checkout')}
                      className="mt-1 h-4 w-4"
                    />
                    <div>
                      <div className="text-sm font-semibold text-gray-900">Stripe Checkout</div>
                      <div className="text-sm text-gray-700">Secure checkout powered by Stripe (full charge).</div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {step === 'confirmation' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <CheckCircle className="h-4 w-4" />
                  Confirmation
                </div>

                <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
                  <div className="text-sm font-semibold text-green-900">Order created</div>
                  <div className="mt-1 text-sm text-green-800">Order ID: {createdOrderId ?? '-'}</div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-white p-4">
                  <div className="text-sm font-semibold text-gray-900">Summary</div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Destination (pricing city)</div>
                      <div className="mt-1 font-semibold text-gray-900">{routeArea || '-'}</div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Service type</div>
                      <div className="mt-1 font-semibold text-gray-900">{serviceType === 'delivery_one_way' ? 'Delivery (one-way)' : 'Pickup (one-way)'}</div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Subtotal (before tax)</div>
                      <div className="mt-1 font-semibold text-gray-900">${totals.subtotal}</div>
                      <div className="mt-1 text-xs text-gray-600">Tax note: {totals.tax_note}</div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Current status</div>
                      <div className="mt-1 font-semibold text-gray-900">Scheduled</div>
                      <div className="mt-1 text-xs text-gray-600">Payment: {isLocalDev ? 'Paid' : 'Unpaid'}</div>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Fulfillment</div>
                      <div className="mt-1 font-semibold text-gray-900">
                        {fulfillment.days_min}–{fulfillment.days_max} business days
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    type="button"
                    disabled={!createdOrderId || payLoading}
                    onClick={() => {
                      if (!createdOrderId) return;
                      void startCheckoutForOrder(createdOrderId);
                    }}
                    className="inline-flex justify-center items-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60"
                  >
                    {payLoading ? 'Redirecting…' : 'Pay now'}
                  </button>
                  <button
                    type="button"
                    onClick={onGoToOrders}
                    className="inline-flex justify-center items-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                  >
                    Go to Orders
                    <ArrowRight className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearDraft();
                      setStep('quote');
                      setCreatedOrderId(null);
                      setError(null);
                      setCustomer({ name: '', email: '', phone: '' });
                      setDealer({ name: '', email: '', phone: '' });
                      setPickupAddress('');
                      setDropoffAddress('');
                      setDocs([]);
                      setDisclosuresAccepted({ timelines: false, payments: false, inTransit: false });
                      setPaymentMethod('stripe_checkout');
                    }}
                    className="inline-flex justify-center items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                  >
                    Create another
                  </button>
                </div>
              </div>
            )}
          </div>

          {step !== 'confirmation' && (
            <div className="border-t border-gray-100 bg-white p-4">
              <div className="flex flex-col sm:flex-row sm:justify-end gap-3">
                <button
                  type="button"
                  onClick={goBackStep}
                  className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex justify-center items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                >
                  Next
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
