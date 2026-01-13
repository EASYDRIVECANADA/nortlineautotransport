import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Upload, FileText, X, CheckCircle, Navigation } from 'lucide-react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L, { type LeafletMouseEvent } from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import {
  SERVICE_AREAS,
  SERVICE_AREA_GEOCODE_QUERY,
  getFulfillmentDaysForRoute,
  getOfficialCityPriceForAddress,
  getOfficialCityPriceForServiceArea,
  type ServiceType,
  type VehicleType,
} from '../pricing/pricingTable';
import { computeTotals, makeLocalOrderId, upsertLocalOrder, updateLocalOrderPaymentStatus } from '../orders/localOrders';
import { createOrderWithInitialEvent, getAccessToken } from '../orders/supabaseOrders';
import { supabase } from '../lib/supabaseClient';

interface UploadedFile {
  id: string;
  name: string;
  size: string;
  type: string;
  file: File;
  docType: 'release_form' | 'work_order' | 'bill_of_sale' | 'photo' | 'notes' | 'other' | 'unknown';
}

interface FileUploadSectionProps {
  hideHeader?: boolean;
  onContinueToSignIn?: () => void;
  persistState?: boolean;
}

const sanitizeDigits = (v: string) => v.replace(/[^0-9]/g, '');
const sanitizeDigitsDash = (v: string) => v.replace(/[^0-9-]/g, '');
const sanitizePhone = (v: string) => v.replace(/[^0-9+()\-\s]/g, '');
const sanitizeDateLike = (v: string) => v.replace(/[^0-9/-]/g, '');
const sanitizeNoDigits = (v: string) => v.replace(/[0-9]/g, '');
const sanitizeLettersSpaces = (v: string) => v.replace(/[^a-zA-Z\s'.-]/g, '');

const DRAFT_FILES_DB = 'ed_draft_files_db';
const DRAFT_FILES_STORE = 'draft_files';

const openDraftFilesDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DRAFT_FILES_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFT_FILES_STORE)) {
          db.createObjectStore(DRAFT_FILES_STORE, { keyPath: 'draftId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });

const putDraftFiles = async (draftId: string, files: File[]): Promise<void> => {
  const db = await openDraftFilesDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_FILES_STORE, 'readwrite');
    const store = tx.objectStore(DRAFT_FILES_STORE);
    const record = {
      draftId,
      files: files.map((f) => ({ name: f.name, type: f.type, lastModified: f.lastModified, blob: f })),
    };
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }).finally(() => {
    db.close();
  });
};

const getDraftFiles = async (draftId: string): Promise<File[] | null> => {
  const db = await openDraftFilesDb();
  try {
    const record = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(DRAFT_FILES_STORE, 'readonly');
      const store = tx.objectStore(DRAFT_FILES_STORE);
      const req = store.get(draftId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    if (!isRecord(record)) return null;
    const filesRaw = record.files;
    if (!Array.isArray(filesRaw)) return null;
    return filesRaw
      .map((f) => {
        if (!isRecord(f)) return null;
        const blob = f.blob;
        if (!(blob instanceof Blob)) return null;
        const name = typeof f.name === 'string' ? f.name : 'document';
        const type = typeof f.type === 'string' ? f.type : 'application/octet-stream';
        const lastModified = typeof f.lastModified === 'number' ? f.lastModified : Date.now();
        try {
          return new File([blob], name, { type, lastModified });
        } catch {
          return null;
        }
      })
      .filter(Boolean) as File[];
  } finally {
    db.close();
  }
};

const deleteDraftFiles = async (draftId: string): Promise<void> => {
  const db = await openDraftFilesDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_FILES_STORE, 'readwrite');
    const store = tx.objectStore(DRAFT_FILES_STORE);
    const req = store.delete(draftId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }).finally(() => {
    db.close();
  });
};

type AddressBreakdown = {
  street: string;
  number: string;
  city: string;
  province: string;
  postal_code: string;
  country: string;
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

const emptyAddressBreakdown = (): AddressBreakdown => ({
  street: '',
  number: '',
  city: '',
  province: '',
  postal_code: '',
  country: 'Canada',
});

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const looksLikeStreetAddress = (value: string) => /\d/.test(String(value ?? ''));

const normalizePostalCode = (value: string) => {
  const raw = normalizeWhitespace(String(value ?? '').toUpperCase());
  if (!raw) return '';
  const compact = raw.replace(/[^A-Z0-9]/g, '');
  if (compact.length === 6) return `${compact.slice(0, 3)} ${compact.slice(3)}`;
  return raw;
};

const buildAddressFromBreakdown = (b: AddressBreakdown) => {
  const line1 = normalizeWhitespace(`${b.number} ${b.street}`.trim());
  const city = normalizeWhitespace(b.city);
  const prov = normalizeWhitespace(b.province);
  const postal = normalizePostalCode(b.postal_code);
  const country = normalizeWhitespace(b.country);

  const parts: string[] = [];
  if (line1) parts.push(line1);
  if (city) parts.push(city);
  const provPostal = normalizeWhitespace(`${prov} ${postal}`.trim());
  if (provPostal) parts.push(provPostal);
  if (country) parts.push(country);
  return parts.join(', ');
};

const normalizeCountry = (value: string) => {
  const raw = normalizeWhitespace(String(value ?? ''));
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (upper === 'CA' || upper === 'CAN' || upper === 'CANADA') return 'Canada';
  if (upper === 'US' || upper === 'USA' || upper === 'UNITED STATES' || upper === 'UNITED STATES OF AMERICA') return 'USA';
  return raw;
};

const CAN_PROVINCE_CODES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

const extractProvincePostalFromLine = (line: string): { province: string; postal_code: string; remainder: string } => {
  const s = normalizeWhitespace(line);
  if (!s) return { province: '', postal_code: '', remainder: '' };

  const postalMatch = s.match(/([A-Z]\d[A-Z])\s*([\d][A-Z]\d)/i);
  const postal = postalMatch ? `${postalMatch[1].toUpperCase()} ${postalMatch[2].toUpperCase()}` : '';
  const withoutPostal = normalizeWhitespace(s.replace(/([A-Z]\d[A-Z])\s*([\d][A-Z]\d)/i, '').trim());

  const tokens = withoutPostal.split(' ').filter(Boolean);
  let province = '';
  let remainder = '';

  if (tokens.length) {
    const last = String(tokens[tokens.length - 1] ?? '').toUpperCase();
    if (CAN_PROVINCE_CODES.has(last)) {
      province = last;
      remainder = normalizeWhitespace(tokens.slice(0, -1).join(' '));
    } else {
      const first = String(tokens[0] ?? '').toUpperCase();
      if (CAN_PROVINCE_CODES.has(first)) {
        province = first;
        remainder = normalizeWhitespace(tokens.slice(1).join(' '));
      } else {
        province = normalizeWhitespace(withoutPostal);
        remainder = '';
      }
    }
  }

  return { province, postal_code: postal, remainder };
};

const normalizeProvinceCountry = (provinceRaw: string, countryRaw: string) => {
  let province = normalizeWhitespace(provinceRaw);
  let country = normalizeCountry(countryRaw);

  const provUpper = province.toUpperCase();
  if (provUpper === 'CA' && !country) {
    country = 'Canada';
    province = '';
  } else if (provUpper === 'CA' && country === 'Canada') {
    province = '';
  }

  if (province && !CAN_PROVINCE_CODES.has(provUpper) && provUpper.length === 2 && country === 'Canada') {
    // If it's a 2-letter code but not a Canadian province, don't force it into province.
    province = '';
  }

  return { province, country: country || 'Canada' };
};

const parseAddressToBreakdown = (address: string): AddressBreakdown => {
  const base = emptyAddressBreakdown();
  const raw = normalizeWhitespace(address);
  if (!raw) return base;

  const parts = raw
    .split(',')
    .map((p) => normalizeWhitespace(p))
    .filter(Boolean);

  let country = '';
  if (parts.length) {
    const last = parts[parts.length - 1] ?? '';
    const normalized = normalizeCountry(last);
    if (normalized === 'Canada' || normalized === 'USA') {
      country = normalized;
      parts.pop();
    }
  }

  let provPostal = parts.length ? parts[parts.length - 1] : '';
  let city = parts.length >= 2 ? parts[parts.length - 2] : '';
  let line1 = parts.length >= 3 ? parts[parts.length - 3] : parts[0] ?? '';

  if (parts.length === 2) {
    // Could be "line1, city province postal" or "line1, province postal".
    line1 = parts[0] ?? '';
    const second = parts[1] ?? '';
    const inferred = extractProvincePostalFromLine(second);
    if (inferred.province || inferred.postal_code) {
      provPostal = normalizeWhitespace(`${inferred.province} ${inferred.postal_code}`.trim());
      city = inferred.remainder;
    } else {
      city = '';
      provPostal = second;
    }
  }

  if (parts.length === 1) {
    line1 = parts[0] ?? '';
    city = '';
    provPostal = '';
  }

  const provPostalExtracted = extractProvincePostalFromLine(provPostal);
  const postal = provPostalExtracted.postal_code;
  let province = provPostalExtracted.province;
  if (province && province.length === 2) province = province.toUpperCase();

  const line = normalizeWhitespace(line1);
  let number = '';
  let street = '';
  const startsWithNumber = line.match(/^([0-9A-Z-]+)\s+(.*)$/i);
  const endsWithNumber = line.match(/^(.*)\s+([0-9A-Z-]+)$/i);
  if (startsWithNumber && /^[0-9]/.test(startsWithNumber[1])) {
    number = startsWithNumber[1];
    street = startsWithNumber[2];
  } else if (endsWithNumber && /^[0-9]/.test(endsWithNumber[2])) {
    street = endsWithNumber[1];
    number = endsWithNumber[2];
  } else {
    street = line;
  }

  const normalized = normalizeProvinceCountry(province, country);
  return {
    street: street,
    number: number,
    city: normalizeWhitespace(city || provPostalExtracted.remainder),
    province: normalized.province,
    postal_code: postal,
    country: normalized.country,
  };
};

const PENDING_RECEIPT_PREFIX = 'ed_pending_receipt_order_';

type ReceiptEntry = {
  id: string;
  createdAt: string;
  text: string;
};

type CheckoutDraft = {
  id: string;
  createdAt: string;
  formData: FormData;
  costData: CostData | null;
  docCount: number;
  draftSource?: 'bulk_upload' | 'manual';
  needsExtraction?: boolean;
};

type CostData = {
  distance: number;
  cost: number;
  duration?: number;
  route?: unknown;
  pricingCity?: string;
  pricingStatus?: 'official' | 'estimated';
};

type FormData = {
  service: {
    service_type: ServiceType;
    vehicle_type: VehicleType;
  };
  vehicle: {
    vin: string;
    year: string;
    make: string;
    model: string;
    transmission: string;
    odometer_km: string;
    exterior_color: string;
  };
  selling_dealership: {
    name: string;
    phone: string;
    address: string;
  };
  buying_dealership: {
    name: string;
    phone: string;
    contact_name: string;
  };
  pickup_location: {
    name: string;
    address: string;
    street: string;
    number: string;
    city: string;
    province: string;
    postal_code: string;
    country: string;
    phone: string;
  };
  dropoff_location: {
    name: string;
    phone: string;
    address: string;
    street: string;
    number: string;
    city: string;
    province: string;
    postal_code: string;
    country: string;
    lat: string;
    lng: string;
    service_area: string;
  };
  transaction: {
    transaction_id: string;
    release_form_number: string;
    release_date: string;
    arrival_date: string;
  };
  authorization: {
    released_by_name: string;
    released_to_name: string;
  };
  dealer_notes: string;
  costEstimate?: CostData | null;
  draft_source?: string;
  transaction_id?: string;
  release_form_number?: string;
  arrival_date?: string;
};

type FormSectionKey =
  | 'service'
  | 'vehicle'
  | 'selling_dealership'
  | 'buying_dealership'
  | 'pickup_location'
  | 'dropoff_location'
  | 'transaction'
  | 'authorization';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const readString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isRecord(value)) {
    const obj = value as Record<string, unknown>;
    return (
      readString(obj.value) ||
      readString(obj.text) ||
      readString(obj.raw) ||
      readString(obj.result) ||
      readString(obj.km) ||
      readString(obj.year) ||
      ''
    );
  }
  return '';
};
const readNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

const pickBestAddressCandidate = (...values: unknown[]): string => {
  const strings = values
    .map((v) => readString(v).trim())
    .filter(Boolean);
  const withDigits = strings.find((s) => looksLikeStreetAddress(s));
  return withDigits ?? strings[0] ?? '';
};

const pickFirstString = (...values: unknown[]): string => {
  for (const v of values) {
    const s = readString(v).trim();
    if (s) return s;
  }
  return '';
};

const normalizeLooseKey = (value: string): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const getLooseValue = (obj: Record<string, unknown> | null, ...keys: string[]): unknown => {
  if (!obj) return undefined;
  const wanted = keys.map(normalizeLooseKey);
  for (const existingKey of Object.keys(obj)) {
    const norm = normalizeLooseKey(existingKey);
    if (wanted.includes(norm)) return obj[existingKey];
  }
  return undefined;
};

const normalizeOdometerKm = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/([0-9][0-9,\s.]*)\s*km/i);
  const numeric = (match?.[1] ?? raw).replace(/[^0-9.]/g, '');
  return numeric;
};

const normalizeVehicleYear = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/(19\d{2}|20\d{2})/);
  return match?.[1] ?? raw;
};

const extractVehicleYearFromText = (text: string): string => {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/\bYear\b\s*[:-]?\s*(19\d{2}|20\d{2})/i);
  return match?.[1] ?? '';
};

const extractOdometerKmFromText = (text: string): string => {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/\bOdometer\b\s*[:-]?\s*([0-9][0-9,\s.]*)\s*km\b/i);
  const numeric = (match?.[1] ?? '').replace(/[^0-9.]/g, '');
  return numeric;
};

const extractWebhookOutput = (data: unknown): unknown => {
  const mergeWrapper = (wrapper: Record<string, unknown>): unknown => {
    const output = wrapper.output;
    if (!isRecord(output)) return output ?? null;
    const merged: Record<string, unknown> = { ...wrapper, ...(output as Record<string, unknown>) };
    delete merged.output;
    return merged;
  };

  if (Array.isArray(data)) {
    const first = data[0];
    if (isRecord(first)) return mergeWrapper(first);
    return null;
  }
  if (isRecord(data)) return mergeWrapper(data);
  return null;
};

const extractWebhookText = (data: unknown): string | null => {
  if (Array.isArray(data)) {
    const first = data[0];
    if (!isRecord(first)) return null;
    const maybe = first.output ?? first.text;
    const s = readString(maybe).trim();
    return s || null;
  }
  if (isRecord(data)) {
    const maybe = data.output ?? data.text;
    const s = readString(maybe).trim();
    return s || null;
  }
  const s = readString(data).trim();
  return s || null;
};

export default function FileUploadSection({ hideHeader = false, onContinueToSignIn, persistState = true }: FileUploadSectionProps) {
  const STORAGE_FORM = 'ed_extractedFormData';
  const STORAGE_MESSAGE = 'ed_submitMessage';
  const STORAGE_ERROR = 'ed_submitError';
  const STORAGE_DRAFTS = 'ed_checkout_drafts';
  const STORAGE_RECEIPTS_PENDING = 'ed_receipts_pending';
  const STORAGE_RECEIPTS_BY_USER_PREFIX = 'ed_receipts_by_user_';

  void hideHeader;

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userKey, setUserKey] = useState<string | null>(null);

  useEffect(() => {
    const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';

    const applyDevAuth = () => {
      const devAuthed = isLocalDev && localStorage.getItem('ed_dev_auth') === '1';
      if (devAuthed) {
        setIsLoggedIn(true);
        setUserKey('local-dev');
      }
      return devAuthed;
    };

    if (applyDevAuth()) {
      const onDevAuthChange = () => {
        applyDevAuth();
      };
      window.addEventListener('ed_dev_auth_change', onDevAuthChange);
      window.addEventListener('storage', onDevAuthChange);
      return () => {
        window.removeEventListener('ed_dev_auth_change', onDevAuthChange);
        window.removeEventListener('storage', onDevAuthChange);
      };
    }

    if (!supabase) {
      setIsLoggedIn(false);
      setUserKey(null);
      return;
    }

    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        const session = data?.session;
        const user = session?.user;
        setIsLoggedIn(Boolean(session));
        setUserKey(user?.id ?? user?.email ?? null);
      })
      .catch(() => {
        if (!active) return;
        setIsLoggedIn(false);
        setUserKey(null);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      setIsLoggedIn(Boolean(session));
      setUserKey(user?.id ?? user?.email ?? null);
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  const preventFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
  };

  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isManualFormOpen, setIsManualFormOpen] = useState(false);
  const [showCostEstimate, setShowCostEstimate] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [costData, setCostData] = useState<CostData | null>(null);
  const [showPaymentSuccess, setShowPaymentSuccess] = useState(false);
  const [paymentSuccessReceiptId, setPaymentSuccessReceiptId] = useState<string | null>(null);

  useEffect(() => {
    if (!showCheckout) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [showCheckout]);
  const [draftDocCount, setDraftDocCount] = useState<number | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [disclosuresAccepted, setDisclosuresAccepted] = useState({
    timelines: false,
    payments: false,
    inTransit: false,
  });
  const [submitMessage, setSubmitMessage] = useState<string | null>(() => {
    if (!persistState) return null;
    try {
      return localStorage.getItem(STORAGE_MESSAGE);
    } catch {
      return null;
    }
  });
  const [submitError, setSubmitError] = useState(() => {
    if (!persistState) return false;
    try {
      return localStorage.getItem(STORAGE_ERROR) === 'true';
    } catch {
      return false;
    }
  });
  const [isRouteRequiredOpen, setIsRouteRequiredOpen] = useState(false);
  const [isDropoffValidationOpen, setIsDropoffValidationOpen] = useState(false);
  const [dropoffValidationMissingFields, setDropoffValidationMissingFields] = useState<string[]>([]);
  const [formData, setFormData] = useState<FormData | null>(() => {
    if (!persistState) return null;
    try {
      const raw = localStorage.getItem(STORAGE_FORM);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return isRecord(parsed) ? (parsed as FormData) : null;
    } catch {
      return null;
    }
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const routeServiceAreaRef = useRef<HTMLSelectElement>(null);
  const suppressGeocodeRef = useRef(false);
  const lastServiceAreaGeocodeRef = useRef<string | null>(null);
  const [dealershipCoords, setDealershipCoords] = useState<{ lat: number; lng: number } | null>(null);

  const dropoffMarkerIcon = useMemo(
    () =>
      L.icon({
        iconRetinaUrl: markerIcon2x,
        iconUrl: markerIcon,
        shadowUrl: markerShadow,
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41],
      }),
    []
  );

  useEffect(() => {
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: markerIcon2x,
      iconUrl: markerIcon,
      shadowUrl: markerShadow,
    });
  }, []);

  const clearPersisted = () => {
    try {
      localStorage.removeItem(STORAGE_FORM);
      localStorage.removeItem(STORAGE_MESSAGE);
      localStorage.removeItem(STORAGE_ERROR);
    } catch {
      // ignore
    }
  };

  const persistReceipt = (text: string) => {
    const entry: ReceiptEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      text,
    };

    const storageKey = userKey ? `${STORAGE_RECEIPTS_BY_USER_PREFIX}${userKey}` : STORAGE_RECEIPTS_PENDING;

    try {
      const existingRaw = localStorage.getItem(storageKey);
      const existing = existingRaw ? (JSON.parse(existingRaw) as ReceiptEntry[]) : [];
      localStorage.setItem(storageKey, JSON.stringify([entry, ...existing]));
    } catch {
      // ignore
    }

    return entry.id;
  };

  const saveCurrentAsDraft = () => {
    if (!formData || !costData) return;
    const now = new Date().toISOString();
    const draftId = activeDraftId ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const draft: CheckoutDraft = {
      id: draftId,
      createdAt: now,
      formData: { ...formData, draft_source: String(formData?.draft_source ?? '').trim() || 'manual' },
      costData,
      docCount: draftDocCount ?? uploadedFiles.length,
      draftSource: 'manual',
    };
    try {
      const raw = localStorage.getItem(STORAGE_DRAFTS);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];

      if (activeDraftId) {
        const idx = existing.findIndex((d) => d && typeof d === 'object' && (d as CheckoutDraft).id === activeDraftId);
        if (idx >= 0) {
          const next = [...existing];
          next[idx] = draft;
          localStorage.setItem(STORAGE_DRAFTS, JSON.stringify(next));
        } else {
          localStorage.setItem(STORAGE_DRAFTS, JSON.stringify([draft, ...existing]));
        }
      } else {
        localStorage.setItem(STORAGE_DRAFTS, JSON.stringify([draft, ...existing]));
      }
    } catch {
      // ignore
    }

    try {
      window.dispatchEvent(new Event('ed_drafts_updated'));
    } catch {
      // ignore
    }

    setShowCheckout(false);
    setSubmitMessage('Saved to drafts. You can pay later from Drafts.');
    setSubmitError(false);
  };

  const saveDraftBeforeSignIn = useCallback(async () => {
    if (uploadedFiles.length === 0 && !formData && !costData) return;

    const draftId = activeDraftId ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const baseForm: FormData =
      formData ??
      ({
        service: { service_type: 'pickup_one_way', vehicle_type: 'standard' },
        vehicle: {
          vin: '',
          year: '',
          make: '',
          model: '',
          transmission: '',
          odometer_km: '',
          exterior_color: '',
        },
        selling_dealership: { name: '', phone: '', address: '' },
        buying_dealership: { name: '', phone: '', contact_name: '' },
        pickup_location: {
          name: '',
          address: '',
          ...emptyAddressBreakdown(),
          phone: '',
        },
        dropoff_location: {
          name: '',
          phone: '',
          address: '',
          ...emptyAddressBreakdown(),
          lat: '',
          lng: '',
          service_area: '',
        },
        transaction: { transaction_id: '', release_form_number: '', release_date: '', arrival_date: '' },
        authorization: { released_by_name: '', released_to_name: '' },
        dealer_notes: '',
      } satisfies FormData);

    const draft: CheckoutDraft = {
      id: draftId,
      createdAt: new Date().toISOString(),
      formData: { ...baseForm, draft_source: String(baseForm.draft_source ?? '').trim() || 'manual' },
      costData,
      docCount: draftDocCount ?? uploadedFiles.length,
      draftSource: 'manual',
      needsExtraction: !formData,
    };

    if (uploadedFiles.length > 0) {
      try {
        await putDraftFiles(
          draftId,
          uploadedFiles
            .map((f) => f?.file)
            .filter((f): f is File => Boolean(f))
        );
      } catch {
        // ignore
      }
    }

    try {
      const raw = localStorage.getItem(STORAGE_DRAFTS);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];
      const idx = existing.findIndex((d) => d && typeof d === 'object' && (d as CheckoutDraft).id === draftId);
      if (idx >= 0) {
        const next = [...existing];
        next[idx] = draft;
        localStorage.setItem(STORAGE_DRAFTS, JSON.stringify(next));
      } else {
        localStorage.setItem(STORAGE_DRAFTS, JSON.stringify([draft, ...existing]));
      }
    } catch {
      // ignore
    }

    try {
      window.dispatchEvent(new Event('ed_drafts_updated'));
    } catch {
      // ignore
    }

    setActiveDraftId(draftId);
    setDraftDocCount(draft.docCount);
  }, [activeDraftId, costData, draftDocCount, formData, uploadedFiles]);

  useEffect(() => {
    const onBeforeSignIn = (event: Event) => {
      const detail = (event as CustomEvent).detail as unknown;
      const resolve =
        detail && typeof detail === 'object' && (detail as Record<string, unknown>).resolve
          ? ((detail as Record<string, unknown>).resolve as unknown)
          : null;
      const done = typeof resolve === 'function' ? (resolve as () => void) : null;
      void saveDraftBeforeSignIn()
        .catch(() => undefined)
        .finally(() => {
          try {
            done?.();
          } catch {
            // ignore
          }
        });
    };

    window.addEventListener('ed_before_sign_in', onBeforeSignIn as EventListener);
    return () => {
      window.removeEventListener('ed_before_sign_in', onBeforeSignIn as EventListener);
    };
  }, [saveDraftBeforeSignIn]);

  useEffect(() => {
    const onResumeDraft = (event: Event) => {
      void (async () => {
        const detail = (event as CustomEvent).detail as unknown;
        if (!isRecord(detail)) return;
        const nextFormData = detail.formData;
        const nextCostData = detail.costData;
        const nextDocCount = detail.docCount;
        const nextDraftId = detail.id;
        if (!isRecord(nextFormData)) return;
        const draftId = typeof nextDraftId === 'string' ? nextDraftId : null;

        const needsExtraction = Boolean((detail as Record<string, unknown>)?.needsExtraction);

        setFormData(needsExtraction ? null : (nextFormData as FormData));

        const hasCost = !needsExtraction && isRecord(nextCostData);
        setCostData(hasCost ? (nextCostData as CostData) : null);
        setDraftDocCount(typeof nextDocCount === 'number' && Number.isFinite(nextDocCount) ? nextDocCount : null);
        setActiveDraftId(draftId);

        if (draftId) {
          try {
            const files = await getDraftFiles(draftId);
            if (files && files.length) {
              const restored: UploadedFile[] = files.map((file) => ({
                id: Math.random().toString(36).slice(2),
                name: file.name,
                size: formatFileSize(file.size),
                type: file.type || 'unknown',
                file,
                docType: 'unknown',
              }));
              setUploadedFiles(restored);
            } else {
              setUploadedFiles([]);
            }
          } catch {
            setUploadedFiles([]);
          }
        }

        setShowCheckout(false);
        setShowCostEstimate(false);
        setSubmitMessage(
          needsExtraction
            ? 'Draft loaded. Please click View Quote Now to process the release form.'
            : hasCost
              ? 'Draft loaded. Please review your quote and edit details if needed.'
              : 'Draft loaded. Please review details then click View Quote Now to get a quote.'
        );
        setSubmitError(false);
      })();
    };
    window.addEventListener('ed_resume_draft', onResumeDraft as EventListener);
    return () => {
      window.removeEventListener('ed_resume_draft', onResumeDraft as EventListener);
    };
  }, []);

  useEffect(() => {
    const onDraftDeleted = (event: Event) => {
      const detail = (event as CustomEvent).detail as unknown;
      const id = isRecord(detail) ? detail.id : null;
      if (typeof id !== 'string') return;
      void deleteDraftFiles(id).catch(() => undefined);
    };
    window.addEventListener('ed_draft_deleted', onDraftDeleted as EventListener);
    return () => {
      window.removeEventListener('ed_draft_deleted', onDraftDeleted as EventListener);
    };
  }, []);

  const geocodeAddress = async (address: string): Promise<{ lat: number; lng: number } | null> => {
    const q = address.trim();
    if (!q) return null;

    const parts = q.split(',').map((p) => p.trim()).filter(Boolean);
    const idxWithNumber = parts.findIndex((p) => /\d/.test(p));
    const normalizedQuery = idxWithNumber > 0 ? parts.slice(idxWithNumber).join(', ') : q;
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=pjson&maxLocations=1&outFields=*&singleLine=${encodeURIComponent(normalizedQuery)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ location?: { x?: number; y?: number } }>;
    };
    const candidate = data?.candidates?.[0];
    const lat = Number(candidate?.location?.y);
    const lng = Number(candidate?.location?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  };

  const reverseGeocode = async (lat: number, lng: number): Promise<string | null> => {
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=pjson&location=${encodeURIComponent(String(lng))}%2C${encodeURIComponent(String(lat))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: { Match_addr?: string; LongLabel?: string } };
    return data?.address?.LongLabel ?? data?.address?.Match_addr ?? null;
  };

  const encodePolyline = (coordinates: [number, number][]): string => {
    // Convert coordinates to lat,lng format and join with |
    // Note: coordinates come as [lng, lat] from routing APIs, need to flip to [lat, lng]
    return coordinates.map(coord => `${coord[1]},${coord[0]}`).join('|');
  };

  const calculateCostAndDistance = async (pickupLat: number, pickupLng: number, dropoffLat: number, dropoffLng: number): Promise<CostData | null> => {
    try {
      // Try to get road-based routing first using OSRM (Open Source Routing Machine)
      try {
        const routingUrl = `https://router.project-osrm.org/route/v1/driving/${pickupLng},${pickupLat};${dropoffLng},${dropoffLat}?overview=full&geometries=geojson`;
        const routeResponse = await fetch(routingUrl);
        
        if (routeResponse.ok) {
          const routeData = await routeResponse.json();
          const route = routeData?.routes?.[0];
          if (route) {
            const distanceKm = Math.round(route.distance / 1000);
            const durationMin = Math.round(route.duration / 60);
            const polyline = route?.geometry?.coordinates ? encodePolyline(route.geometry.coordinates) : undefined;
            
            const costPerKm = 2.50;
            const minimumCost = 150;
            const calculatedCost = Math.max(distanceKm * costPerKm, minimumCost);

            return {
              distance: distanceKm,
              cost: Math.round(calculatedCost),
              duration: durationMin,
              route: { geometry: route.geometry, polyline },
            };
          }
        }
      } catch {
        console.log('OSRM routing failed, trying alternative...');
        
        // Try MapBox routing as backup
        try {
          const mapboxUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${pickupLng},${pickupLat};${dropoffLng},${dropoffLat}?access_token=pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw&geometries=geojson`;
          const mapboxResponse = await fetch(mapboxUrl);
          
          if (mapboxResponse.ok) {
            const mapboxData = await mapboxResponse.json();
            const route = mapboxData?.routes?.[0];
            if (route) {
              const distanceKm = Math.round(route.distance / 1000);
              const durationMin = Math.round(route.duration / 60);
              const polyline = route?.geometry?.coordinates ? encodePolyline(route.geometry.coordinates) : undefined;
              
              const costPerKm = 2.50;
              const minimumCost = 150;
              const calculatedCost = Math.max(distanceKm * costPerKm, minimumCost);
              
              return {
                distance: distanceKm,
                cost: Math.round(calculatedCost),
                duration: durationMin,
                route: { geometry: route.geometry, polyline }
              };
            }
          }
        } catch {
          console.log('MapBox routing also failed, using straight-line distance');
        }
      }

      // Fallback to Haversine formula if routing fails
      const R = 6371; // Earth's radius in kilometers
      const dLat = (dropoffLat - pickupLat) * Math.PI / 180;
      const dLng = (dropoffLng - pickupLng) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(pickupLat * Math.PI / 180) * Math.cos(dropoffLat * Math.PI / 180) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c; // Distance in kilometers

      // Estimate duration (assuming average speed of 60 km/h)
      const averageSpeed = 60; // km/h
      const duration = Math.round((distance / averageSpeed) * 60); // minutes

      // Simple cost calculation: $2.50 per km with minimum $150
      const costPerKm = 2.50;
      const minimumCost = 150;
      const calculatedCost = Math.max(distance * costPerKm, minimumCost);

      return {
        distance: Math.round(distance),
        cost: Math.round(calculatedCost),
        duration: duration
      };
    } catch (error) {
      console.error('Error calculating cost:', error);
      return null;
    }
  };

  const dropoffCoords = useMemo(() => {
    const addr = String(formData?.dropoff_location?.address ?? '').trim();
    if (!addr) return null;
    const latRaw = String(formData?.dropoff_location?.lat ?? '').trim();
    const lngRaw = String(formData?.dropoff_location?.lng ?? '').trim();
    if (!latRaw || !lngRaw) return null;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat, lng };
  }, [formData?.dropoff_location?.address, formData?.dropoff_location?.lat, formData?.dropoff_location?.lng]);

  useEffect(() => {
    const addr = String(formData?.dropoff_location?.address ?? '').trim();
    if (addr) return;

    const lat = String(formData?.dropoff_location?.lat ?? '').trim();
    const lng = String(formData?.dropoff_location?.lng ?? '').trim();
    if (!lat && !lng) return;

    updateFormField('dropoff_location', 'lat', '');
    updateFormField('dropoff_location', 'lng', '');
  }, [formData?.dropoff_location?.address, formData?.dropoff_location?.lat, formData?.dropoff_location?.lng]);

  useEffect(() => {
    const pickupAddress = String(formData?.pickup_location?.address ?? '').trim();
    if (!pickupAddress) return;

    const timer = window.setTimeout(async () => {
      try {
        const result = await geocodeAddress(pickupAddress);
        if (!result) return;
        setDealershipCoords(result);
      } catch {
        // ignore
      }
    }, 500);

    return () => window.clearTimeout(timer);
  }, [formData?.pickup_location?.address]);

  useEffect(() => {
    const area = String(formData?.dropoff_location?.service_area ?? '').trim();
    if (!area) return;

    const latRaw = String(formData?.dropoff_location?.lat ?? '').trim();
    const lngRaw = String(formData?.dropoff_location?.lng ?? '').trim();
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    const hasValidCoords =
      latRaw !== '' &&
      lngRaw !== '' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180 &&
      !(lat === 0 && lng === 0);

    const prevArea = lastServiceAreaGeocodeRef.current;
    lastServiceAreaGeocodeRef.current = area;

    // On first render/load, don't override coordinates that were already extracted from the PDF.
    if (prevArea === null && hasValidCoords) return;

    // If nothing changed and coords are already valid, do nothing.
    if (prevArea === area && hasValidCoords) return;

    const query = (SERVICE_AREA_GEOCODE_QUERY as Record<string, string>)[area] ?? `${area}, Canada`;
    const existingAddress = String(formData?.dropoff_location?.address ?? '').trim();
    const timer = window.setTimeout(async () => {
      try {
        const result = await geocodeAddress(query);
        if (!result) return;

        updateFormField('dropoff_location', 'lat', String(result.lat));
        updateFormField('dropoff_location', 'lng', String(result.lng));

        // Don't write the service area label into address; address breakdown should stay a real address.
        if (!existingAddress) {
          suppressGeocodeRef.current = true;
        }
      } catch {
        // ignore
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    formData?.dropoff_location?.service_area,
    formData?.dropoff_location?.lat,
    formData?.dropoff_location?.lng,
    formData?.dropoff_location?.address,
  ]);

  useEffect(() => {
    const vt = String(formData?.service?.vehicle_type ?? 'standard');
    if (vt && vt !== 'standard') {
      updateFormField('service', 'vehicle_type', 'standard');
    }
  }, [formData?.service?.vehicle_type]);

  useEffect(() => {
    const address = String(formData?.dropoff_location?.address ?? '');
    if (!address.trim()) return;
    if (suppressGeocodeRef.current) {
      suppressGeocodeRef.current = false;
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const result = await geocodeAddress(address);
        if (!result) return;
        updateFormField('dropoff_location', 'lat', String(result.lat));
        updateFormField('dropoff_location', 'lng', String(result.lng));
      } catch {
        // ignore
      }
    }, 700);

    return () => window.clearTimeout(timer);
  }, [formData?.dropoff_location?.address]);

  const DropoffMapUpdater = ({ lat, lng }: { lat: number; lng: number }) => {
    const map = useMap();
    useEffect(() => {
      map.setView([lat, lng], Math.max(map.getZoom(), 13), { animate: true });
    }, [lat, lng, map]);
    return null;
  };

  const DropoffMapClickHandler = () => {
    useMapEvents({
      click: async (e: LeafletMouseEvent) => {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        updateFormField('dropoff_location', 'lat', String(lat));
        updateFormField('dropoff_location', 'lng', String(lng));

        try {
          const addr = await reverseGeocode(lat, lng);
          if (addr) {
            suppressGeocodeRef.current = true;
            handleDropoffAddressChange(addr);
          }
        } catch {
          // ignore
        }
      },
    });
    return null;
  };

  useEffect(() => {
    if (!persistState) return;
    try {
      if (formData) {
        localStorage.setItem(STORAGE_FORM, JSON.stringify(formData));
      } else {
        localStorage.removeItem(STORAGE_FORM);
      }

      if (submitMessage === null) {
        localStorage.removeItem(STORAGE_MESSAGE);
      } else {
        localStorage.setItem(STORAGE_MESSAGE, submitMessage);
      }

      localStorage.setItem(STORAGE_ERROR, submitError ? 'true' : 'false');
    } catch {
      // ignore
    }
  }, [formData, submitMessage, submitError, persistState]);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  const initFormData = (output: unknown): FormData | null => {
    if (!output || !isRecord(output)) return null;

    const outputObj = output as Record<string, unknown>;
    const rawExtractedText = pickFirstString(
      getLooseValue(outputObj, 'text', 'raw_text', 'rawtext', 'document_text', 'documenttext', 'ocr_text', 'ocrtext'),
      (outputObj as Record<string, unknown>).extracted_text,
      (outputObj as Record<string, unknown>).extractedText
    );

    const serviceObj = isRecord(output.service) ? output.service : null;
    const transactionObj = isRecord(output.transaction) ? output.transaction : null;
    const vehicleObj = isRecord(output.vehicle) ? output.vehicle : null;
    const sellingObj = isRecord(output.selling_dealership) ? output.selling_dealership : null;
    const buyingObj = isRecord(output.buying_dealership) ? output.buying_dealership : null;
    const buyingObj2 = isRecord((output as Record<string, unknown>).buyingDealership)
      ? ((output as Record<string, unknown>).buyingDealership as Record<string, unknown>)
      : null;
    const buyerDealershipObj = isRecord((output as Record<string, unknown>).buyer_dealership)
      ? ((output as Record<string, unknown>).buyer_dealership as Record<string, unknown>)
      : null;
    const buyerDealershipObj2 = isRecord((output as Record<string, unknown>).buyerDealership)
      ? ((output as Record<string, unknown>).buyerDealership as Record<string, unknown>)
      : null;
    const destinationDealershipObj = isRecord((output as Record<string, unknown>).destination_dealership)
      ? ((output as Record<string, unknown>).destination_dealership as Record<string, unknown>)
      : null;
    const destinationDealershipObj2 = isRecord((output as Record<string, unknown>).destinationDealership)
      ? ((output as Record<string, unknown>).destinationDealership as Record<string, unknown>)
      : null;
    const toDealershipObj = isRecord((output as Record<string, unknown>).to_dealership)
      ? ((output as Record<string, unknown>).to_dealership as Record<string, unknown>)
      : null;
    const toDealershipObj2 = isRecord((output as Record<string, unknown>).toDealership)
      ? ((output as Record<string, unknown>).toDealership as Record<string, unknown>)
      : null;
    const pickupObj = isRecord(output.pickup_location) ? output.pickup_location : null;
    const dropoffObj = isRecord(output.dropoff_location) ? output.dropoff_location : null;
    const dropOffAltObj = isRecord((output as Record<string, unknown>).drop_off_location)
      ? ((output as Record<string, unknown>).drop_off_location as Record<string, unknown>)
      : null;
    const dropoffAlt2Obj = isRecord(output.dropoff) ? output.dropoff : null;
    const deliveryObj = isRecord(output.delivery_location) ? output.delivery_location : null;
    const deliveryObj2 = isRecord((output as Record<string, unknown>).deliveryLocation)
      ? ((output as Record<string, unknown>).deliveryLocation as Record<string, unknown>)
      : null;
    const destinationObj = isRecord((output as Record<string, unknown>).destination)
      ? ((output as Record<string, unknown>).destination as Record<string, unknown>)
      : null;
    const authObj = isRecord(output.authorization) ? output.authorization : null;

    const extractedServiceTypeRaw = pickFirstString(
      output.service_type,
      (output as Record<string, unknown>).serviceType,
      serviceObj?.service_type,
      serviceObj?.serviceType,
      transactionObj?.service_type,
      transactionObj?.serviceType
    );
    const normalizedServiceType = extractedServiceTypeRaw.toLowerCase();
    const serviceType = /deliver/.test(normalizedServiceType) ? 'delivery_one_way' : 'pickup_one_way';

    const vehicleType = 'standard';

    const extractedDropoffAddress = pickFirstString(
      dropoffObj?.address,
      dropoffObj?.full_address,
      (typeof output.dropoff_location === 'string' ? output.dropoff_location : ''),
      dropOffAltObj?.address,
      dropOffAltObj?.full_address,
      (typeof (output as Record<string, unknown>).drop_off_location === 'string' ? (output as Record<string, unknown>).drop_off_location : ''),
      dropoffAlt2Obj?.address,
      (typeof output.dropoff === 'string' ? output.dropoff : ''),
      (output as Record<string, unknown>).dropoff_address,
      (output as Record<string, unknown>).dropoffAddress,
      deliveryObj?.address,
      (typeof output.delivery_location === 'string' ? output.delivery_location : ''),
      deliveryObj2?.address,
      (typeof (output as Record<string, unknown>).deliveryLocation === 'string' ? (output as Record<string, unknown>).deliveryLocation : ''),
      destinationObj?.address,
      (typeof (output as Record<string, unknown>).destination === 'string' ? (output as Record<string, unknown>).destination : ''),
      (output as Record<string, unknown>).destination_address,
      (output as Record<string, unknown>).destinationAddress,
      (output as Record<string, unknown>).delivery_address,
      (output as Record<string, unknown>).deliveryAddress
    );

    const extractedDropoffCity = pickFirstString(
      dropoffObj?.city,
      dropOffAltObj?.city,
      (output as Record<string, unknown>).dropoff_city,
      (output as Record<string, unknown>).dropoffCity,
      deliveryObj?.city,
      deliveryObj2?.city,
      (output as Record<string, unknown>).destination_city,
      (output as Record<string, unknown>).destinationCity,
      (output as Record<string, unknown>).delivery_city,
      (output as Record<string, unknown>).deliveryCity
    );

    const extractedDropoffName = pickFirstString(dropoffObj?.name, dropOffAltObj?.name, dropoffAlt2Obj?.name, deliveryObj?.name);
    const extractedDropoffPhone = pickFirstString(dropoffObj?.phone, dropOffAltObj?.phone, dropoffAlt2Obj?.phone, deliveryObj?.phone);
    const extractedDropoffLat =
      dropoffObj?.lat ?? dropOffAltObj?.lat ?? dropoffAlt2Obj?.lat ?? (output as Record<string, unknown>).dropoff_lat ?? (output as Record<string, unknown>).dropoffLat ?? deliveryObj?.lat;
    const extractedDropoffLng =
      dropoffObj?.lng ?? dropOffAltObj?.lng ?? dropoffAlt2Obj?.lng ?? (output as Record<string, unknown>).dropoff_lng ?? (output as Record<string, unknown>).dropoffLng ?? deliveryObj?.lng;

    const dropoffAddress = String(extractedDropoffAddress ?? '').trim() || String(extractedDropoffCity ?? '').trim();
    const dropoffName = extractedDropoffName;
    const dropoffPhone = extractedDropoffPhone;
    const dropoffLat = Number.isFinite(readNumber(extractedDropoffLat)) ? String(readNumber(extractedDropoffLat)) : '';
    const dropoffLng = Number.isFinite(readNumber(extractedDropoffLng)) ? String(readNumber(extractedDropoffLng)) : '';
    const inferredServiceArea =
      getOfficialCityPriceForAddress(`${dropoffAddress} ${String(dropoffName ?? '').trim()}`.trim())?.city ??
      getOfficialCityPriceForServiceArea(String(extractedDropoffCity ?? '').trim())?.city ??
      '';

    const vehicleVin = pickFirstString(vehicleObj?.vin, getLooseValue(outputObj, 'vin'));
    const vehicleYear =
      normalizeVehicleYear(
        pickFirstString(
          vehicleObj?.year,
          getLooseValue(vehicleObj, 'year', 'vehicle_year', 'vehicleyear'),
          getLooseValue(outputObj, 'year', 'vehicle_year', 'vehicleyear')
        )
      ) || extractVehicleYearFromText(rawExtractedText);
    const vehicleMake = pickFirstString(
      vehicleObj?.make,
      getLooseValue(outputObj, 'make', 'vehicle_make')
    );
    const vehicleModel = pickFirstString(
      vehicleObj?.model,
      getLooseValue(outputObj, 'model', 'vehicle_model')
    );
    const vehicleTransmission = pickFirstString(
      vehicleObj?.transmission,
      getLooseValue(outputObj, 'transmission', 'vehicle_transmission')
    );
    const vehicleOdometerRaw = pickFirstString(
      vehicleObj?.odometer_km,
      getLooseValue(vehicleObj, 'odometer_km', 'odometer', 'odometerkm', 'mileage', 'vehicle_odometer'),
      getLooseValue(outputObj, 'odometer_km', 'odometer', 'odometerkm', 'mileage', 'vehicle_odometer')
    );
    const vehicleOdometerKm = normalizeOdometerKm(vehicleOdometerRaw) || extractOdometerKmFromText(rawExtractedText);
    const vehicleExteriorColor = pickFirstString(
      vehicleObj?.exterior_color,
      getLooseValue(vehicleObj, 'exterior_color', 'color', 'exteriorcolor', 'vehicle_color'),
      getLooseValue(outputObj, 'exterior_color', 'color', 'exteriorcolor', 'vehicle_color')
    );

    const sellingName = pickFirstString(
      sellingObj?.name,
      getLooseValue(
        outputObj,
        'selling_dealership_name',
        'sellingdealershipname',
        'selling_dealership',
        'sellingdealership',
        'seller',
        'seller_name',
        'seller_dealer',
        'seller_dealer_name',
        'from_dealer',
        'from_dealer_name',
        'from_dealership',
        'from_dealership_name',
        'origin_dealer',
        'origin_dealer_name'
      ),
      getLooseValue(outputObj, 'pickup_location_name', 'pickuplocationname', 'pickup_name', 'pickupname'),
      pickupObj?.name
    );
    const sellingPhone = pickFirstString(
      sellingObj?.phone,
      getLooseValue(
        outputObj,
        'selling_dealership_phone',
        'sellingdealershipphone',
        'seller_phone',
        'sellerphone',
        'selling_phone',
        'from_dealer_phone',
        'fromdealershipphone',
        'origin_dealer_phone'
      ),
      getLooseValue(outputObj, 'pickup_location_phone', 'pickuplocationphone', 'pickup_phone', 'pickupphone'),
      pickupObj?.phone
    );
    const sellingAddress = pickFirstString(
      sellingObj?.address,
      getLooseValue(
        outputObj,
        'selling_dealership_address',
        'sellingdealershipaddress',
        'seller_address',
        'selleraddress',
        'from_dealer_address',
        'from_dealership_address',
        'origin_dealer_address'
      ),
      getLooseValue(outputObj, 'pickup_location_address', 'pickuplocationaddress', 'pickup_address', 'pickupaddress'),
      pickupObj?.address
    );

    const buyingName = pickFirstString(
      buyingObj?.name,
      buyingObj2?.name,
      buyerDealershipObj?.name,
      buyerDealershipObj2?.name,
      destinationDealershipObj?.name,
      destinationDealershipObj2?.name,
      toDealershipObj?.name,
      toDealershipObj2?.name,
      deliveryObj?.name,
      deliveryObj2?.name,
      destinationObj?.name,
      dropoffObj?.name,
      dropOffAltObj?.name,
      dropoffAlt2Obj?.name,
      getLooseValue(
        outputObj,
        'buying_dealership_name',
        'buyingdealershipname',
        'buying_dealership',
        'buyingdealership',
        'buyer_dealership_name',
        'buyerdealershipname',
        'buyer_dealership',
        'buyerdealership',
        'buyer',
        'buyer_name',
        'buyer_dealer',
        'buyer_dealer_name',
        'to_dealer',
        'to_dealer_name',
        'to_dealership',
        'to_dealership_name',
        'destination_dealer',
        'destination_dealer_name',
        'destination_dealership',
        'destination_dealership_name',
        'dealership_to',
        'dealershipto',
        'delivered_to',
        'deliveredto',
        'delivery_dealership',
        'deliverydealership'
      ),
      getLooseValue(outputObj, 'dropoff_location_name', 'dropofflocationname', 'dropoff_name', 'dropoffname', 'delivery_location_name', 'deliverylocationname'),
      dropoffObj?.name
    );
    const buyingPhone = pickFirstString(
      buyingObj?.phone,
      buyingObj2?.phone,
      buyerDealershipObj?.phone,
      buyerDealershipObj2?.phone,
      destinationDealershipObj?.phone,
      destinationDealershipObj2?.phone,
      toDealershipObj?.phone,
      toDealershipObj2?.phone,
      deliveryObj?.phone,
      deliveryObj2?.phone,
      destinationObj?.phone,
      dropoffObj?.phone,
      dropOffAltObj?.phone,
      dropoffAlt2Obj?.phone,
      getLooseValue(
        outputObj,
        'buying_dealership_phone',
        'buyingdealershipphone',
        'buyer_dealership_phone',
        'buyerdealershipphone',
        'buyer_phone',
        'buyerphone',
        'to_dealer_phone',
        'destination_dealer_phone',
        'destination_dealership_phone',
        'dealership_to_phone',
        'dealershiptophone',
        'delivery_dealership_phone',
        'deliverydealershipphone'
      ),
      getLooseValue(outputObj, 'dropoff_location_phone', 'dropofflocationphone', 'dropoff_phone', 'dropoffphone', 'delivery_location_phone', 'deliverylocationphone'),
      dropoffObj?.phone
    );
    const buyingContactName = pickFirstString(
      buyingObj?.contact_name,
      buyingObj2?.contact_name,
      buyerDealershipObj?.contact_name,
      buyerDealershipObj2?.contact_name,
      destinationDealershipObj?.contact_name,
      destinationDealershipObj2?.contact_name,
      toDealershipObj?.contact_name,
      toDealershipObj2?.contact_name,
      deliveryObj?.contact_name,
      deliveryObj2?.contact_name,
      destinationObj?.contact_name,
      getLooseValue(outputObj, 'contact_name', 'contactname', 'buyer_contact_name', 'buyercontactname', 'buyer_contact'),
      dropoffObj?.contact_name,
      dropoffObj?.contact
    );

    const pickupName = pickFirstString(pickupObj?.name, getLooseValue(outputObj, 'pickup_location_name', 'pickuplocationname', 'pickup_name', 'pickupname'));
    const pickupAddress = pickFirstString(pickupObj?.address, getLooseValue(outputObj, 'pickup_location_address', 'pickuplocationaddress', 'pickup_address', 'pickupaddress'));
    const pickupPhone = pickFirstString(
      pickupObj?.phone,
      getLooseValue(outputObj, 'pickup_location_phone', 'pickuplocationphone', 'pickup_phone', 'pickupphone'),
      sellingPhone
    );

    const transactionId = pickFirstString(transactionObj?.transaction_id, getLooseValue(outputObj, 'transaction_id', 'transactionid', 'transaction', 'transaction_number', 'transactionnumber'));
    const releaseFormNumber = pickFirstString(
      transactionObj?.release_form_number,
      getLooseValue(outputObj, 'release_form_number', 'releaseformnumber', 'release_form', 'releaseform', 'release_form_no', 'releaseformno')
    );
    const releaseDate = pickFirstString(transactionObj?.release_date, getLooseValue(outputObj, 'release_date', 'releasedate'));
    const arrivalDate = pickFirstString(transactionObj?.arrival_date, getLooseValue(outputObj, 'arrival_date', 'arrivaldate'));

    const releasedByName = pickFirstString(authObj?.released_by_name, getLooseValue(outputObj, 'released_by_name', 'releasedbyname', 'releasedby'));
    const releasedToName = pickFirstString(authObj?.released_to_name, getLooseValue(outputObj, 'released_to_name', 'releasedtoname', 'releasedto'));

    const pickupAddressForParsing = pickBestAddressCandidate(
      pickupObj?.full_address,
      pickupObj?.fullAddress,
      pickupAddress,
      sellingAddress
    );
    const parsedPickup = parseAddressToBreakdown(pickupAddressForParsing);
    const dropoffAddressForParsing = pickBestAddressCandidate(
      dropoffObj?.full_address,
      dropoffObj?.fullAddress,
      dropOffAltObj?.full_address,
      dropOffAltObj?.fullAddress,
      dropoffAddress
    );
    const parsedDropoff = parseAddressToBreakdown(dropoffAddressForParsing);

    const pickupCity = pickFirstString(pickupObj?.city, getLooseValue(outputObj, 'pickup_city', 'pickupCity'));
    const pickupProvince = pickFirstString(pickupObj?.province, pickupObj?.state, getLooseValue(outputObj, 'pickup_province', 'pickupProvince', 'pickup_state', 'pickupState'));
    const pickupPostal = pickFirstString(pickupObj?.postal_code, pickupObj?.postal, pickupObj?.zip, getLooseValue(outputObj, 'pickup_postal_code', 'pickupPostalCode', 'pickup_postal', 'pickupPostal'));
    const pickupCountry = pickFirstString(pickupObj?.country, getLooseValue(outputObj, 'pickup_country', 'pickupCountry'));

    const dropoffProvince = pickFirstString(dropoffObj?.province, dropoffObj?.state, dropOffAltObj?.province, dropOffAltObj?.state, getLooseValue(outputObj, 'dropoff_province', 'dropoffProvince', 'dropoff_state', 'dropoffState'));
    const dropoffPostal = pickFirstString(dropoffObj?.postal_code, dropoffObj?.postal, dropoffObj?.zip, dropOffAltObj?.postal_code, dropOffAltObj?.postal, dropOffAltObj?.zip, getLooseValue(outputObj, 'dropoff_postal_code', 'dropoffPostalCode', 'dropoff_postal', 'dropoffPostal'));
    const dropoffCountry = pickFirstString(dropoffObj?.country, dropOffAltObj?.country, getLooseValue(outputObj, 'dropoff_country', 'dropoffCountry'));

    const pickupNumber = pickFirstString(
      parsedPickup.number,
      pickupObj?.number,
      pickupObj?.street_number,
      getLooseValue(outputObj, 'pickup_number', 'pickupNumber')
    );
    const pickupStreet = pickFirstString(
      pickupObj?.street,
      pickupObj?.street_name,
      getLooseValue(outputObj, 'pickup_street', 'pickupStreet')
    );
    const pickupStreetFinal = pickupNumber ? pickFirstString(parsedPickup.street, pickupStreet) : pickupStreet;
    const pickupCityFinalRaw = pickFirstString(parsedPickup.city, pickupCity);
    const pickupPostalFinalRaw = normalizePostalCode(pickFirstString(parsedPickup.postal_code, pickupPostal));
    const pickupCountryFinalRaw = pickFirstString(parsedPickup.country, pickupCountry);
    const pickupProvPostalFromCity = extractProvincePostalFromLine(pickupCityFinalRaw);
    const pickupProvinceFinalRaw = pickFirstString(parsedPickup.province, pickupProvince, pickupProvPostalFromCity.province);
    const pickupPostalFinal = normalizePostalCode(pickFirstString(pickupPostalFinalRaw, pickupProvPostalFromCity.postal_code));
    const pickupCityFinal = pickupProvPostalFromCity.postal_code ? normalizeWhitespace(pickupProvPostalFromCity.remainder || parsedPickup.city) : normalizeWhitespace(pickupCityFinalRaw);
    const pickupCountryNormalized = normalizeProvinceCountry(pickupProvinceFinalRaw, pickupCountryFinalRaw);
    const pickupProvinceFinal = pickupCountryNormalized.province;
    const pickupCountryFinal = pickupCountryNormalized.country;
    const pickupAddressCandidate = String(pickupAddress ?? '').trim();
    const pickupAddressFinal =
      (looksLikeStreetAddress(pickupAddressCandidate) ? pickupAddressCandidate : '') ||
      buildAddressFromBreakdown({
        street: pickupStreetFinal,
        number: pickupNumber,
        city: pickupCityFinal,
        province: pickupProvinceFinal,
        postal_code: pickupPostalFinal,
        country: pickupCountryFinal,
      });

    const dropoffNumber = pickFirstString(
      parsedDropoff.number,
      dropoffObj?.number,
      dropoffObj?.street_number,
      dropOffAltObj?.number,
      dropOffAltObj?.street_number,
      getLooseValue(outputObj, 'dropoff_number', 'dropoffNumber')
    );
    const dropoffStreet = pickFirstString(
      dropoffObj?.street,
      dropoffObj?.street_name,
      dropOffAltObj?.street,
      dropOffAltObj?.street_name,
      getLooseValue(outputObj, 'dropoff_street', 'dropoffStreet')
    );
    const dropoffStreetFinal = dropoffNumber ? pickFirstString(parsedDropoff.street, dropoffStreet) : dropoffStreet;
    const dropoffCityFinalRaw = pickFirstString(parsedDropoff.city, extractedDropoffCity);
    const dropoffPostalFinalRaw = normalizePostalCode(pickFirstString(parsedDropoff.postal_code, dropoffPostal));
    const dropoffCountryFinalRaw = pickFirstString(parsedDropoff.country, dropoffCountry);
    const dropoffProvPostalFromCity = extractProvincePostalFromLine(dropoffCityFinalRaw);
    const dropoffProvinceFinalRaw = pickFirstString(parsedDropoff.province, dropoffProvince, dropoffProvPostalFromCity.province);
    const dropoffPostalFinal = normalizePostalCode(pickFirstString(dropoffPostalFinalRaw, dropoffProvPostalFromCity.postal_code));
    const dropoffCityFinal = dropoffProvPostalFromCity.postal_code ? normalizeWhitespace(dropoffProvPostalFromCity.remainder || parsedDropoff.city) : normalizeWhitespace(dropoffCityFinalRaw);
    const dropoffCountryNormalized = normalizeProvinceCountry(dropoffProvinceFinalRaw, dropoffCountryFinalRaw);
    const dropoffProvinceFinal = dropoffCountryNormalized.province;
    const dropoffCountryFinal = dropoffCountryNormalized.country;
    const dropoffAddressCandidate = String(dropoffAddress ?? '').trim();
    const dropoffAddressFinal =
      (looksLikeStreetAddress(dropoffAddressCandidate) ? dropoffAddressCandidate : '') ||
      buildAddressFromBreakdown({
        street: dropoffStreetFinal,
        number: dropoffNumber,
        city: dropoffCityFinal,
        province: dropoffProvinceFinal,
        postal_code: dropoffPostalFinal,
        country: dropoffCountryFinal,
      });

    return {
      service: {
        service_type: serviceType,
        vehicle_type: vehicleType,
      },
      vehicle: {
        vin: String(vehicleVin ?? ''),
        year: String(vehicleYear ?? ''),
        make: String(vehicleMake ?? ''),
        model: String(vehicleModel ?? ''),
        transmission: String(vehicleTransmission ?? ''),
        odometer_km: String(vehicleOdometerKm ?? ''),
        exterior_color: String(vehicleExteriorColor ?? ''),
      },
      selling_dealership: {
        name: String(sellingName ?? ''),
        phone: String(sellingPhone ?? ''),
        address: String(sellingAddress ?? ''),
      },
      buying_dealership: {
        name: String(buyingName ?? ''),
        phone: String(buyingPhone ?? ''),
        contact_name: String(buyingContactName ?? ''),
      },
      pickup_location: {
        name: String(pickupName ?? ''),
        address: pickupAddressFinal,
        street: pickupStreetFinal,
        number: pickupNumber,
        city: pickupCityFinal,
        province: pickupProvinceFinal,
        postal_code: pickupPostalFinal,
        country: pickupCountryFinal,
        phone: String(pickupPhone ?? ''),
      },
      dropoff_location: {
        name: dropoffName,
        phone: dropoffPhone,
        address: dropoffAddressFinal,
        street: dropoffStreetFinal,
        number: dropoffNumber,
        city: dropoffCityFinal,
        province: dropoffProvinceFinal,
        postal_code: dropoffPostalFinal,
        country: dropoffCountryFinal,
        lat: dropoffLat,
        lng: dropoffLng,
        service_area: inferredServiceArea,
      },
      transaction: {
        transaction_id: String(transactionId ?? ''),
        release_form_number: String(releaseFormNumber ?? ''),
        release_date: String(releaseDate ?? ''),
        arrival_date: String(arrivalDate ?? ''),
      },
      authorization: {
        released_by_name: String(releasedByName ?? ''),
        released_to_name: String(releasedToName ?? ''),
      },
      dealer_notes: pickFirstString(
        (output as Record<string, unknown>).dealer_notes,
        (output as Record<string, unknown>).pickup_instructions
      ),
    };
  };

  const createBlankFormData = () =>
    initFormData({
      service: { service_type: 'pickup_one_way', vehicle_type: 'standard' },
      vehicle: {},
      selling_dealership: {},
      buying_dealership: {},
      pickup_location: { ...emptyAddressBreakdown() },
      dropoff_location: { ...emptyAddressBreakdown(), lat: '', lng: '', service_area: '' },
      transaction: {},
      authorization: {},
      dealer_notes: '',
    });

  const closeManualForm = () => {
    setIsManualFormOpen(false);
    setFormData(null);
  };

  const renderFormDetails = () => {
    if (!formData) return null;

    return (
      <div className="mt-6 border border-gray-200 rounded-lg p-4 sm:p-6 bg-gray-50 text-gray-900 [&_input]:bg-white [&_input]:text-gray-900 [&_input]:placeholder:text-gray-400 [&_select]:bg-white [&_select]:text-gray-900 [&_textarea]:bg-white [&_textarea]:text-gray-900 [&_textarea]:placeholder:text-gray-400">
        <h4 className="text-base sm:text-lg font-semibold text-gray-800 mb-4">Extracted Details</h4>

        <div className="mb-6 pb-6 border-b border-gray-200">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Vehicle</h5>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">VIN</label>
              <input value={formData.vehicle.vin} onChange={(e) => updateFormField('vehicle', 'vin', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Year</label>
              <input
                value={formData.vehicle.year}
                onChange={(e) => updateFormField('vehicle', 'year', sanitizeDigits(e.target.value).slice(0, 4))}
                inputMode="numeric"
                pattern="[0-9]*"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Make</label>
              <input value={formData.vehicle.make} onChange={(e) => updateFormField('vehicle', 'make', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Model</label>
              <input value={formData.vehicle.model} onChange={(e) => updateFormField('vehicle', 'model', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Transmission</label>
              <input
                value={formData.vehicle.transmission}
                onChange={(e) => updateFormField('vehicle', 'transmission', sanitizeNoDigits(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Odometer (km)</label>
              <input
                value={formData.vehicle.odometer_km}
                onChange={(e) => updateFormField('vehicle', 'odometer_km', sanitizeDigits(e.target.value))}
                inputMode="numeric"
                pattern="[0-9]*"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Exterior Color</label>
              <input
                value={formData.vehicle.exterior_color}
                onChange={(e) => updateFormField('vehicle', 'exterior_color', sanitizeNoDigits(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        <div className="mb-6 pb-6 border-b border-gray-200">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Selling Dealership</h5>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input value={formData.selling_dealership.name} onChange={(e) => updateFormField('selling_dealership', 'name', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Phone</label>
              <input
                value={formData.selling_dealership.phone}
                onChange={(e) => updateFormField('selling_dealership', 'phone', sanitizePhone(e.target.value))}
                inputMode="tel"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Address</label>
              <input value={formData.selling_dealership.address} onChange={(e) => updateFormField('selling_dealership', 'address', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
          </div>
        </div>

        <div className="mb-6 pb-6 border-b border-gray-200">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Buying Dealership</h5>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input value={formData.buying_dealership.name} onChange={(e) => updateFormField('buying_dealership', 'name', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Phone</label>
              <input
                value={formData.buying_dealership.phone}
                onChange={(e) => updateFormField('buying_dealership', 'phone', sanitizePhone(e.target.value))}
                inputMode="tel"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Contact Name</label>
              <input
                value={formData.buying_dealership.contact_name}
                onChange={(e) => updateFormField('buying_dealership', 'contact_name', sanitizeNoDigits(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Service Details</h5>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Service Type</label>
              <select
                value={String(formData?.service?.service_type ?? 'pickup_one_way')}
                onChange={(e) => updateFormField('service', 'service_type', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
              >
                <option value="pickup_one_way">Pickup (one-way)</option>
                <option value="delivery_one_way">Delivery (one-way)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Vehicle Type</label>
              <input
                value="Standard passenger vehicle"
                readOnly
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-800"
              />
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Pickup Location</h5>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input value={formData.pickup_location.name} onChange={(e) => updateFormField('pickup_location', 'name', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Phone</label>
              <input
                value={formData.pickup_location.phone}
                onChange={(e) => updateFormField('pickup_location', 'phone', sanitizePhone(e.target.value))}
                inputMode="tel"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-700 mb-3">Address Breakdown</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Street</label>
                <input
                  value={String(formData.pickup_location.street ?? '')}
                  onChange={(e) => setPickupAddressFromBreakdown({ street: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="10e Avenue (10th Avenue)"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Number</label>
                <input
                  value={String(formData.pickup_location.number ?? '')}
                  onChange={(e) => setPickupAddressFromBreakdown({ number: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="8670"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">City</label>
                <input
                  value={String(formData.pickup_location.city ?? '')}
                  onChange={(e) => setPickupAddressFromBreakdown({ city: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Montréal"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Province</label>
                <input
                  value={String(formData.pickup_location.province ?? '')}
                  onChange={(e) => setPickupAddressFromBreakdown({ province: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Quebec (QC)"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Postal Code</label>
                <input
                  value={String(formData.pickup_location.postal_code ?? '')}
                  onChange={(e) => setPickupAddressFromBreakdown({ postal_code: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="H1Z 3B8"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Country</label>
                <input
                  value={String(formData.pickup_location.country ?? 'Canada')}
                  onChange={(e) => setPickupAddressFromBreakdown({ country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Canada"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Drop-off Location</h5>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input value={String(formData?.dropoff_location?.name ?? '')} onChange={(e) => updateFormField('dropoff_location', 'name', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Phone</label>
              <input
                value={String(formData?.dropoff_location?.phone ?? '')}
                onChange={(e) => updateFormField('dropoff_location', 'phone', sanitizePhone(e.target.value))}
                inputMode="tel"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Route / Service Area</label>
              <select
                ref={routeServiceAreaRef}
                value={String(formData?.dropoff_location?.service_area ?? '')}
                onChange={(e) => updateFormField('dropoff_location', 'service_area', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
              >
                <option value="">Select service area</option>
                {SERVICE_AREAS.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-700 mb-3">Address Breakdown</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Street</label>
                <input
                  value={String(formData.dropoff_location.street ?? '')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ street: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="10e Avenue (10th Avenue)"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Number</label>
                <input
                  value={String(formData.dropoff_location.number ?? '')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ number: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="8670"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">City</label>
                <input
                  value={String(formData.dropoff_location.city ?? '')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ city: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Montréal"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Province</label>
                <input
                  value={String(formData.dropoff_location.province ?? '')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ province: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Quebec (QC)"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Postal Code</label>
                <input
                  value={String(formData.dropoff_location.postal_code ?? '')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ postal_code: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="H1Z 3B8"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Country</label>
                <input
                  value={String(formData.dropoff_location.country ?? 'Canada')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Canada"
                />
              </div>
            </div>
          </div>

          <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden bg-white h-60 sm:h-80 relative z-0">
            <MapContainer
              center={dropoffCoords ? [dropoffCoords.lat, dropoffCoords.lng] : dealershipCoords ? [dealershipCoords.lat, dealershipCoords.lng] : [45.5017, -73.5673]}
              zoom={dropoffCoords || dealershipCoords ? 13 : 10}
              style={{ height: '100%', width: '100%', zIndex: 1 }}
            >
              <TileLayer
                attribution='Tiles &copy; Esri'
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              />
              <DropoffMapClickHandler />
              {(dropoffCoords || dealershipCoords) && (
                <>
                  <DropoffMapUpdater lat={(dropoffCoords ?? dealershipCoords)!.lat} lng={(dropoffCoords ?? dealershipCoords)!.lng} />
                  <Marker position={[(dropoffCoords ?? dealershipCoords)!.lat, (dropoffCoords ?? dealershipCoords)!.lng]} icon={dropoffMarkerIcon} />
                </>
              )}

            </MapContainer>
          </div>
        </div>

        <div className="mb-6">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Transaction</h5>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Transaction ID</label>
              <input
                value={formData.transaction.transaction_id}
                onChange={(e) => updateFormField('transaction', 'transaction_id', sanitizeDigitsDash(e.target.value))}
                inputMode="numeric"
                pattern="[0-9-]*"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Release Form #</label>
              <input value={formData.transaction.release_form_number} onChange={(e) => updateFormField('transaction', 'release_form_number', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Release Date</label>
              <input
                value={formData.transaction.release_date}
                onChange={(e) => updateFormField('transaction', 'release_date', sanitizeDateLike(e.target.value))}
                inputMode="numeric"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Arrival Date</label>
              <input
                value={formData.transaction.arrival_date}
                onChange={(e) => updateFormField('transaction', 'arrival_date', sanitizeDateLike(e.target.value))}
                inputMode="numeric"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Authorization</h5>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Released By Name</label>
              <input
                value={formData.authorization.released_by_name}
                onChange={(e) => updateFormField('authorization', 'released_by_name', sanitizeLettersSpaces(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Released To Name</label>
              <input
                value={formData.authorization.released_to_name}
                onChange={(e) => updateFormField('authorization', 'released_to_name', sanitizeLettersSpaces(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        <div>
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Dealer Notes</h5>
          <textarea
            value={formData.dealer_notes}
            onChange={(e) =>
              setFormData((prev) => {
                if (!prev) return prev;
                return { ...prev, dealer_notes: e.target.value };
              })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-lg min-h-[96px]"
          />
        </div>
      </div>
    );
  };

  const updateFormField = <S extends FormSectionKey>(section: S, key: keyof FormData[S] & string, value: string) => {
    setFormData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [section]: {
          ...((prev[section] as unknown as Record<string, unknown>) ?? {}),
          [key]: value,
        },
      } as FormData;
    });
  };

  const setPickupAddressFromBreakdown = (next: Partial<AddressBreakdown>) => {
    setFormData((prev) => {
      if (!prev) return prev;
      const current = prev.pickup_location;
      const merged: AddressBreakdown = {
        street: String(next.street ?? current.street ?? ''),
        number: String(next.number ?? current.number ?? ''),
        city: String(next.city ?? current.city ?? ''),
        province: String(next.province ?? current.province ?? ''),
        postal_code: normalizePostalCode(String(next.postal_code ?? current.postal_code ?? '')),
        country: String(next.country ?? current.country ?? 'Canada'),
      };
      const addr = buildAddressFromBreakdown(merged);
      return {
        ...prev,
        pickup_location: {
          ...prev.pickup_location,
          ...merged,
          address: addr,
        },
      } as FormData;
    });
  };

  const setDropoffAddressFromBreakdown = (next: Partial<AddressBreakdown>) => {
    setFormData((prev) => {
      if (!prev) return prev;
      const current = prev.dropoff_location;
      const merged: AddressBreakdown = {
        street: String(next.street ?? current.street ?? ''),
        number: String(next.number ?? current.number ?? ''),
        city: String(next.city ?? current.city ?? ''),
        province: String(next.province ?? current.province ?? ''),
        postal_code: normalizePostalCode(String(next.postal_code ?? current.postal_code ?? '')),
        country: String(next.country ?? current.country ?? 'Canada'),
      };
      const addr = buildAddressFromBreakdown(merged);
      return {
        ...prev,
        dropoff_location: {
          ...prev.dropoff_location,
          ...merged,
          address: addr,
        },
      } as FormData;
    });
  };

  const handleDropoffAddressChange = (value: string) => {
    const parsed = parseAddressToBreakdown(value);
    setFormData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        dropoff_location: {
          ...prev.dropoff_location,
          address: value,
          ...parsed,
        },
      } as FormData;
    });
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      handleFiles(e.target.files);
    }
  };

  const handleFiles = (files: FileList) => {
    const nextFiles = Array.from(files ?? []);
    if (nextFiles.length === 0) return;

    if (uploadedFiles.length + nextFiles.length > 5) {
      setSubmitMessage('You can upload up to 5 release forms at a time.');
      setSubmitError(true);
      return;
    }

    const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png'];
    const maxBytes = 10 * 1024 * 1024;

    const invalidType = nextFiles.find((f) => {
      const lowerName = String(f.name ?? '').toLowerCase();
      return !allowedExtensions.some((ext) => lowerName.endsWith(ext));
    });

    if (invalidType) {
      clearPersisted();
      setUploadedFiles([]);
      setFormData(null);
      setSubmitMessage('Unsupported file type. Please upload a PDF, JPG, or PNG.');
      setSubmitError(true);
      return;
    }

    const tooLarge = nextFiles.find((f) => f.size > maxBytes);
    if (tooLarge) {
      clearPersisted();
      setUploadedFiles([]);
      setFormData(null);
      setSubmitMessage('File is too large. Please upload a file under 10MB.');
      setSubmitError(true);
      return;
    }

    const mapped: UploadedFile[] = nextFiles.map((file) => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      size: formatFileSize(file.size),
      type: file.type || 'unknown',
      file,
      docType: 'unknown',
    }));

    clearPersisted();
    setSubmitMessage(null);
    setSubmitError(false);
    setFormData(null);
    setDraftDocCount(null);
    setActiveDraftId(null);
    setUploadedFiles((prev) => [...mapped, ...prev]);
  };

  const removeFile = (id: string) => {
    setUploadedFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const onButtonClick = () => {
    fileInputRef.current?.click();
  };

  const openRouteRequiredModal = () => {
    setSubmitMessage(null);
    setSubmitError(false);
    setIsRouteRequiredOpen(true);
  };

  const closeRouteRequiredModal = () => {
    setIsRouteRequiredOpen(false);
    window.setTimeout(() => {
      const el = routeServiceAreaRef.current;
      if (!el) return;
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
      } catch {
        // ignore
      }
    }, 0);
  };

  const closeDropoffValidationModal = () => {
    setIsDropoffValidationOpen(false);
  };

  const handleSubmitDocuments = async () => {
    if (isSubmitting) return;

    if (formData) {
      if (isManualFormOpen) setIsManualFormOpen(false);
      const dropoffStreet = String(formData.dropoff_location.street ?? '').trim();
      const dropoffNumber = String(formData.dropoff_location.number ?? '').trim();
      const dropoffCity = String(formData.dropoff_location.city ?? '').trim();
      const dropoffProvince = String(formData.dropoff_location.province ?? '').trim();
      const dropoffPostal = String(formData.dropoff_location.postal_code ?? '').trim();
      const dropoffCountry = String(formData.dropoff_location.country ?? '').trim();

      const missingFields: string[] = [];
      if (!dropoffStreet) missingFields.push('Street');
      if (!dropoffNumber) missingFields.push('Number');
      if (!dropoffCity) missingFields.push('City');
      if (!dropoffProvince) missingFields.push('Province');
      if (!dropoffPostal) missingFields.push('Postal Code');
      if (!dropoffCountry) missingFields.push('Country');

      const isDropoffBreakdownComplete =
        !!dropoffStreet &&
        !!dropoffNumber &&
        !!dropoffCity &&
        !!dropoffProvince &&
        !!dropoffPostal &&
        !!dropoffCountry;

      if (!isDropoffBreakdownComplete) {
        if (isManualFormOpen) setIsManualFormOpen(false);
        setDropoffValidationMissingFields(missingFields);
        setIsDropoffValidationOpen(true);
        return;
      }

      setShowCostEstimate(false);

      const pickupLat = Number(dealershipCoords?.lat);
      const pickupLng = Number(dealershipCoords?.lng);
      const dropoffLatRaw = String(formData?.dropoff_location?.lat ?? '').trim();
      const dropoffLngRaw = String(formData?.dropoff_location?.lng ?? '').trim();
      const dropoffLat = Number(dropoffLatRaw);
      const dropoffLng = Number(dropoffLngRaw);

      const pickupCity = String(formData?.pickup_location?.city ?? '').trim();
      const selectedServiceArea = String(formData?.dropoff_location?.service_area ?? '').trim();
      const pricingArea = selectedServiceArea || pickupCity;
      const pickupAddressBase = String(formData?.pickup_location?.address ?? '').trim();
      const pickupName = String(formData?.pickup_location?.name ?? '').trim();
      const pickupLookup = `${pickupAddressBase} ${pickupName} ${pickupCity}`.trim();

      const official =
        getOfficialCityPriceForServiceArea(pricingArea) ?? (pickupLookup ? getOfficialCityPriceForAddress(pickupLookup) : null);

      const hasValidDropoffCoords =
        dropoffLatRaw !== '' &&
        dropoffLngRaw !== '' &&
        Number.isFinite(dropoffLat) &&
        Number.isFinite(dropoffLng) &&
        dropoffLat >= -90 &&
        dropoffLat <= 90 &&
        dropoffLng >= -180 &&
        dropoffLng <= 180 &&
        !(dropoffLat === 0 && dropoffLng === 0);

      if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng) && hasValidDropoffCoords) {
        const estimate = await calculateCostAndDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
        if (estimate) {
          const nextCost = official
            ? { ...estimate, cost: official.total_price, pricingCity: official.city, pricingStatus: 'official' as const }
            : { ...estimate, pricingStatus: 'estimated' as const };
          setCostData(nextCost);
          if (isManualFormOpen) setIsManualFormOpen(false);
          setShowCostEstimate(true);
          return;
        }
      }

      if (official) {
        setCostData({ distance: 0, cost: official.total_price, pricingCity: official.city, pricingStatus: 'official' as const });
        if (isManualFormOpen) setIsManualFormOpen(false);
        setShowCostEstimate(true);
        return;
      }

      if (isManualFormOpen) setIsManualFormOpen(false);
      openRouteRequiredModal();
      return;
    }

    if (uploadedFiles.length === 0) {
      setSubmitMessage('Please select a file to extract.');
      setSubmitError(true);
      onButtonClick();
      return;
    }

    if (uploadedFiles.length > 5) {
      setSubmitMessage('You can upload up to 5 release forms at a time.');
      setSubmitError(true);
      return;
    }

    if (uploadedFiles.length > 1) {
      setIsSubmitting(true);
      setSubmitMessage(null);
      setSubmitError(false);
      setActiveDraftId(null);
      setDraftDocCount(null);

      if (!isLoggedIn) {
        const newDrafts: CheckoutDraft[] = [];
        let failed = 0;

        for (const f of uploadedFiles) {
          const draftId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const blank = createBlankFormData();
          if (!blank) {
            failed += 1;
            continue;
          }

          newDrafts.push({
            id: draftId,
            createdAt: new Date().toISOString(),
            formData: { ...blank, draft_source: 'bulk_upload' },
            costData: null,
            docCount: 1,
            draftSource: 'bulk_upload',
            needsExtraction: true,
          });

          try {
            await putDraftFiles(draftId, [f.file]);
          } catch {
            // ignore
          }
        }

        try {
          const raw = localStorage.getItem(STORAGE_DRAFTS);
          const parsed = raw ? (JSON.parse(raw) as unknown) : null;
          const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];
          if (newDrafts.length) {
            localStorage.setItem(STORAGE_DRAFTS, JSON.stringify([...newDrafts, ...existing]));
          }
        } catch {
          // ignore
        }

        try {
          window.dispatchEvent(new Event('ed_drafts_updated'));
        } catch {
          // ignore
        }

        setUploadedFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = '';

        if (newDrafts.length) {
          setSubmitMessage(
            `Saved ${newDrafts.length} draft order${newDrafts.length === 1 ? '' : 's'} for later. Please sign in and open Drafts to continue.${failed ? ` (${failed} failed).` : ''}`
          );
          setSubmitError(false);
        } else {
          setSubmitMessage('No drafts were created. Please check the files and try again.');
          setSubmitError(true);
        }

        onContinueToSignIn?.();
        setIsSubmitting(false);
        return;
      }

      const computeCostForExtracted = async (extracted: FormData): Promise<CostData | null> => {
        const dropoffLatStr = String(extracted?.dropoff_location?.lat ?? '').trim();
        const dropoffLngStr = String(extracted?.dropoff_location?.lng ?? '').trim();
        const dropoffLat = Number(dropoffLatStr);
        const dropoffLng = Number(dropoffLngStr);

        const pickupCity = String(extracted?.pickup_location?.city ?? '').trim();
        const selectedServiceArea = String(extracted?.dropoff_location?.service_area ?? '').trim();
        const pricingArea = selectedServiceArea || pickupCity;
        const pickupAddress = String(extracted?.pickup_location?.address ?? '').trim();
        const pickupName = String(extracted?.pickup_location?.name ?? '').trim();

        const pickupQuery = pickupAddress || pickupName;
        const pickupLookup = `${pickupQuery} ${pickupCity}`.trim();

        const official =
          getOfficialCityPriceForServiceArea(pricingArea) ?? (pickupLookup ? getOfficialCityPriceForAddress(pickupLookup) : null);

        const hasValidDropoffCoords =
          dropoffLatStr !== '' &&
          dropoffLngStr !== '' &&
          Number.isFinite(dropoffLat) &&
          Number.isFinite(dropoffLng) &&
          dropoffLat >= -90 &&
          dropoffLat <= 90 &&
          dropoffLng >= -180 &&
          dropoffLng <= 180 &&
          !(dropoffLat === 0 && dropoffLng === 0);

        const dropoffAddressBase = String(extracted?.dropoff_location?.address ?? '').trim();
        const dropoffName = String(extracted?.dropoff_location?.name ?? '').trim();
        const dropoffAddress = dropoffName ? `${dropoffAddressBase} ${dropoffName}`.trim() : dropoffAddressBase;

        const dropoffQuery = dropoffAddress || String(extracted?.dropoff_location?.name ?? '').trim();

        const pickupCoords = pickupQuery ? await geocodeAddress(pickupQuery).catch(() => null) : null;
        const resolvedDropoffCoords = hasValidDropoffCoords
          ? { lat: dropoffLat, lng: dropoffLng }
          : dropoffQuery
            ? await geocodeAddress(dropoffQuery).catch(() => null)
            : null;

        if (pickupCoords && resolvedDropoffCoords) {
          const estimate = await calculateCostAndDistance(
            pickupCoords.lat,
            pickupCoords.lng,
            resolvedDropoffCoords.lat,
            resolvedDropoffCoords.lng
          );
          if (estimate) {
            return official
              ? { ...estimate, cost: official.total_price, pricingCity: official.city, pricingStatus: 'official' as const }
              : { ...estimate, pricingStatus: 'estimated' as const };
          }
        }

        if (official) {
          return { distance: 0, cost: official.total_price, pricingCity: official.city, pricingStatus: 'official' as const };
        }

        return null;
      };

      const newDrafts: CheckoutDraft[] = [];
      let failed = 0;

      const totalCount = uploadedFiles.length;

      for (let index = 0; index < uploadedFiles.length; index += 1) {
        const f = uploadedFiles[index];
        setSubmitMessage(`Creating draft orders... (${index + 1} of ${totalCount})`);
        try {
          const filePayload = {
            name: f.name,
            type: f.type,
            size: f.file.size,
            base64: await fileToBase64(f.file),
          };

          const res = await fetch('https://primary-production-6722.up.railway.app/webhook/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: [filePayload] }),
          });

          if (!res.ok) {
            failed += 1;
            continue;
          }

          const data = await res.json().catch(() => null);
          const output = extractWebhookOutput(data);
          const extracted = initFormData(output);
          if (!extracted) {
            failed += 1;
            continue;
          }

          const draftId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
          let computedCost: CostData | null = null;
          try {
            computedCost = await computeCostForExtracted(extracted);
          } catch {
            computedCost = null;
          }

          const extractedWithSource: FormData = { ...extracted, draft_source: 'bulk_upload' };

          newDrafts.push({
            id: draftId,
            createdAt: new Date().toISOString(),
            formData: extractedWithSource,
            costData: computedCost,
            docCount: 1,
            draftSource: 'bulk_upload',
          });

          try {
            await putDraftFiles(draftId, [f.file]);
          } catch {
            // ignore
          }
        } catch {
          failed += 1;
        }
      }

      try {
        const raw = localStorage.getItem(STORAGE_DRAFTS);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];
        if (newDrafts.length) {
          localStorage.setItem(STORAGE_DRAFTS, JSON.stringify([...newDrafts, ...existing]));
        }
      } catch {
        // ignore
      }

      try {
        window.dispatchEvent(new Event('ed_drafts_updated'));
      } catch {
        // ignore
      }

      setUploadedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';

      if (newDrafts.length) {
        setSubmitMessage(
          `Created ${newDrafts.length} draft order${newDrafts.length === 1 ? '' : 's'}${failed ? ` (${failed} failed).` : '.'}`
        );
        setSubmitError(false);
      } else {
        setSubmitMessage('No drafts were created. Please check the files and try again.');
        setSubmitError(true);
      }

      setIsSubmitting(false);
      return;
    }

    setIsSubmitting(true);
    setSubmitMessage(null);
    setSubmitError(false);

    try {
      const filesWithBase64 = await Promise.all(
        uploadedFiles.map(async (f) => ({
          name: f.name,
          type: f.type,
          size: f.file.size,
          base64: await fileToBase64(f.file),
          docType: f.docType,
        }))
      );
      const files = filesWithBase64.map((f) => ({ name: f.name, type: f.type, size: f.size, base64: f.base64 }));

      const res = await fetch('https://primary-production-6722.up.railway.app/webhook/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Upload failed (${res.status})`);
      }

      const data = await res.json().catch(() => null);
      const output = extractWebhookOutput(data);
      const extracted = initFormData(output);
      setFormData(extracted);

      const pickupCity = String(extracted?.pickup_location?.city ?? '').trim();
      const selectedServiceArea = String(extracted?.dropoff_location?.service_area ?? '').trim();
      const pricingArea = selectedServiceArea || pickupCity;
      const pickupAddressBase = String(extracted?.pickup_location?.address ?? '').trim();
      const pickupName = String(extracted?.pickup_location?.name ?? '').trim();
      const pickupLookup = `${pickupAddressBase} ${pickupName} ${pickupCity}`.trim();

      const extractedOfficial =
        getOfficialCityPriceForServiceArea(pricingArea) ?? (pickupLookup ? getOfficialCityPriceForAddress(pickupLookup) : null);
      if (extractedOfficial) {
        setCostData({
          distance: 0,
          cost: extractedOfficial.total_price,
          pricingCity: extractedOfficial.city,
          pricingStatus: 'official' as const,
        });
        setShowCostEstimate(false);
        setSubmitMessage('Document extracted successfully. Please review the details then click View Quote Now.');
        setSubmitError(false);
        return;
      }

      setSubmitMessage('Document extracted successfully. Please review the details then click View Quote Now.');
      setSubmitError(false);
    } catch (err) {
      setSubmitMessage(err instanceof Error ? err.message : 'Upload failed');
      setSubmitError(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleProceedWithCost = async () => {
    setShowCostEstimate(false);

    if (!isLoggedIn) {
      setSubmitMessage('Please log in with Google to continue.');
      setSubmitError(true);
      await saveDraftBeforeSignIn();
      onContinueToSignIn?.();
      return;
    }

    setShowCheckout(true);
  };

  const handlePayNow = async () => {
    if (!formData) return;

    const accepted = disclosuresAccepted.timelines && disclosuresAccepted.payments && disclosuresAccepted.inTransit;
    if (!accepted) {
      setSubmitMessage('Please accept all disclosures to continue.');
      setSubmitError(true);
      return;
    }

    if (!isLoggedIn) {
      setSubmitMessage('Please log in with Google to continue.');
      setSubmitError(true);
      await saveDraftBeforeSignIn();
      onContinueToSignIn?.();
      return;
    }

    setIsSubmitting(true);
    setSubmitMessage(null);
    setSubmitError(false);

    try {
      const submittedAt = new Date().toISOString();
      const user = await (async () => {
        if (!supabase) return { name: '', email: '' };
        try {
          const { data } = await supabase.auth.getUser();
          const meta = (data?.user?.user_metadata ?? null) as unknown;
          const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
          return {
            name: String(metaObj?.name ?? '').trim(),
            email: String(data?.user?.email ?? '').trim(),
          };
        } catch {
          return { name: '', email: '' };
        }
      })();

      const filesWithBase64 = uploadedFiles.length
        ? await Promise.all(
            uploadedFiles.map(async (f) => ({
              name: f.name,
              type: f.type,
              size: f.file.size,
              base64: await fileToBase64(f.file),
              docType: f.docType,
            }))
          )
        : [];
      const files = filesWithBase64.map((f) => ({ name: f.name, type: f.type, size: f.size, base64: f.base64 }));

      let responseText: string | null = null;
      try {
        const webhookRes = await fetch('https://primary-production-6722.up.railway.app/webhook/Dox', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            submittedAt,
            user,
            userName: user.name || user.email || 'Account',
            files,
            formData: {
              ...formData,
              costEstimate: costData,
            },
          }),
        });

        if (webhookRes.ok) {
          const responseJson = await webhookRes.json().catch(() => null);
          responseText = extractWebhookText(responseJson);
        }
      } catch {
        // ignore
      }
      
      const fallbackReceipt = (() => {
        const now = new Date().toISOString();
        const pickupName = String(formData?.pickup_location?.name ?? '').trim();
        const pickupPhone = String(formData?.pickup_location?.phone ?? '').trim();
        const pickupAddress = String(formData?.pickup_location?.address ?? '').trim();
        const dropName = String(formData?.dropoff_location?.name ?? '').trim();
        const dropPhone = String(formData?.dropoff_location?.phone ?? '').trim();
        const dropAddress = String(formData?.dropoff_location?.address ?? '').trim();
        const txnId = String(formData?.transaction?.transaction_id ?? formData?.transaction_id ?? '').trim();
        const releaseForm = String(formData?.transaction?.release_form_number ?? formData?.release_form_number ?? '').trim();
        const arrivalDate = String(formData?.transaction?.arrival_date ?? formData?.arrival_date ?? '').trim();
        const userLabel = String(user?.name || user?.email || 'Account').trim();

        const fulfillment = (() => {
          const city = String(costData?.pricingCity ?? '').toLowerCase();
          return city.includes('montreal') ? 'As fast as 1–2 business days' : '3–8 business days';
        })();

        const lines: string[] = [];
        lines.push('Receipt');
        lines.push(`Created: ${now}`);
        lines.push(`Account: ${userLabel}`);
        lines.push('');
        if (costData) {
          lines.push(`Distance: ${costData.distance} km`);
          if (costData.pricingCity && costData.pricingStatus === 'official') {
            lines.push(`City: ${costData.pricingCity}`);
            lines.push(`Price (before tax): $${costData.cost}`);
            lines.push('Note: + applicable tax.');
          } else {
            lines.push(`Price (before tax): $${costData.cost}`);
            lines.push('Note: + applicable tax.');
          }
          lines.push(`Estimated delivery time: ${fulfillment}`);
          lines.push('');
        }
        lines.push('Pickup Location:');
        if (pickupName) lines.push(`Name: ${pickupName}`);
        if (pickupPhone) lines.push(`Phone: ${pickupPhone}`);
        if (pickupAddress) lines.push(`Address: ${pickupAddress}`);
        lines.push('');
        lines.push('Dropoff Location:');
        if (dropName) lines.push(`Name: ${dropName}`);
        if (dropPhone) lines.push(`Phone: ${dropPhone}`);
        if (dropAddress) lines.push(`Address: ${dropAddress}`);
        lines.push('');
        lines.push('Transaction:');
        if (txnId) lines.push(`Transaction ID: ${txnId}`);
        if (releaseForm) lines.push(`Release Form Number: ${releaseForm}`);
        if (arrivalDate) lines.push(`Arrival Date: ${arrivalDate}`);
        return lines.join('\n');
      })();

      const finalReceiptText = responseText ? responseText : fallbackReceipt;
      const normalizedReceipt = String(finalReceiptText).replace(/\r\n/g, '\n').trim();

      const routeArea = String(costData?.pricingCity ?? formData?.dropoff_location?.service_area ?? formData?.pickup_location?.city ?? '').trim();
      const subtotal = Number(costData?.cost ?? 0);
      const totals = computeTotals(subtotal, routeArea);
      const orderCode = makeLocalOrderId();
      const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';

      try {
        localStorage.setItem(`${PENDING_RECEIPT_PREFIX}${orderCode}`, normalizedReceipt);
      } catch {
        // ignore
      }

      if (isLocalDev) {
        const now = new Date().toISOString();
        const fulfillment = getFulfillmentDaysForRoute(routeArea);
        upsertLocalOrder({
          id: orderCode,
          created_at: now,
          updated_at: now,
          service_type: String(formData?.service?.service_type ?? 'pickup_one_way') === 'delivery_one_way' ? 'delivery_one_way' : 'pickup_one_way',
          vehicle_type: 'standard',
          route_area: routeArea,
          fulfillment_days_min: fulfillment.days_min,
          fulfillment_days_max: fulfillment.days_max,
          totals,
          customer: { name: user.name, email: user.email },
          form_data: { ...formData, costEstimate: costData },
          documents: uploadedFiles.map((f) => ({
            id: f.id,
            name: f.name,
            mime: f.type,
            size: f.file.size,
            kind: f.docType === 'release_form' || f.docType === 'work_order' ? 'required' : f.docType === 'unknown' ? 'unknown' : 'optional',
          })),
          status: 'Scheduled',
          status_events: [{ status: 'Scheduled', at: now, note: 'Order created' }],
          payment_status: 'unpaid',
        });
        updateLocalOrderPaymentStatus(orderCode, 'paid', 'Payment received');
        const receiptId = persistReceipt(normalizedReceipt);
        try {
          localStorage.removeItem(`${PENDING_RECEIPT_PREFIX}${orderCode}`);
        } catch {
          // ignore
        }

        setPaymentSuccessReceiptId(receiptId);
        setShowPaymentSuccess(true);

        setSubmitMessage('Payment successful.');
        setSubmitError(false);

        clearPersisted();
        setFormData(null);
        setUploadedFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
        setShowCheckout(false);
        return;
      }

      if (!supabase) {
        throw new Error('Payments are currently unavailable. Please try again later.');
      }

      await createOrderWithInitialEvent({
        order_code: orderCode,
        customer_name: user.name,
        customer_email: user.email,
        route_area: routeArea,
        service_type: String(formData?.service?.service_type ?? 'pickup_one_way'),
        vehicle_type: 'standard',
        price_before_tax: totals.subtotal,
        currency: 'CAD',
      });

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');

      if (filesWithBase64.length) {
        const uploadRes = await fetch('/.netlify/functions/upload-order-documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_code: orderCode, access_token: token, files: filesWithBase64 }),
        });

        if (!uploadRes.ok) {
          const text = await uploadRes.text().catch(() => '');
          throw new Error(text || 'Failed to save uploaded documents');
        }
      }

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

      setSubmitMessage('Redirecting to secure checkout…');
      setSubmitError(false);
    } catch (err) {
      setSubmitMessage(err instanceof Error ? err.message : 'Submit failed');
      setSubmitError(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      {isRouteRequiredOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[10006] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setIsRouteRequiredOpen(false);
                }
              }}
            >
              <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
              <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-5 border-b border-gray-100">
                  <div className="text-base font-semibold text-gray-900">Route / Service Area required</div>
                  <div className="mt-1 text-sm text-gray-600">
                    Please select a Route / Service Area (or set drop-off coordinates) and try again.
                  </div>
                </div>
                <div className="px-6 py-5">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={closeRouteRequiredModal}
                      className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                    >
                      Back
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {isDropoffValidationOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[10006] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setIsDropoffValidationOpen(false);
                }
              }}
            >
              <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
              <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-5 border-b border-gray-100">
                  <div className="text-base font-semibold text-gray-900">Drop-off location required</div>
                  <div className="mt-1 text-sm text-gray-600">
                    Please fill in the required Drop-off Address Breakdown fields before continuing.
                  </div>
                </div>
                <div className="px-6 py-5">
                  {dropoffValidationMissingFields.length > 0 && (
                    <div className="text-sm text-gray-800">
                      Missing:
                      <div className="mt-2 flex flex-wrap gap-2">
                        {dropoffValidationMissingFields.map((f) => (
                          <span
                            key={f}
                            className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-800 border border-gray-200"
                          >
                            {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-5 flex justify-end">
                    <button
                      type="button"
                      onClick={closeDropoffValidationModal}
                      className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {showCheckout && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[10006] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setShowCheckout(false);
                }
              }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-black/70 via-black/50 to-black/70 backdrop-blur-sm"></div>
              <div className="relative w-full max-w-xl max-h-[85vh] rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
                <div className="bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-6 py-4">
                  <div className="text-lg font-semibold">Checkout</div>
                  <div className="text-sm opacity-90">Review details and pay securely</div>
                </div>

                <div className="p-6 space-y-5 overflow-y-auto ocean-scrollbar" style={{ maxHeight: 'calc(85vh - 72px - 88px)' }}>
                  {(() => {
                    const routeArea = String(costData?.pricingCity ?? formData?.dropoff_location?.service_area ?? formData?.pickup_location?.city ?? '').trim();
                    const serviceTypeLabel =
                      String(formData?.service?.service_type ?? '') === 'delivery_one_way' ? 'Delivery (one-way)' : 'Pickup (one-way)';
                    const fulfillment = routeArea.toLowerCase().includes('montreal') ? 'As fast as 1–2 business days' : '3–8 business days';
                    const pickupName = String(formData?.pickup_location?.name ?? '').trim();
                    const pickupPhone = String(formData?.pickup_location?.phone ?? '').trim();
                    const pickupAddress = String(formData?.pickup_location?.address ?? '').trim();
                    const dropName = String(formData?.dropoff_location?.name ?? '').trim();
                    const dropPhone = String(formData?.dropoff_location?.phone ?? '').trim();
                    const dropAddress = String(formData?.dropoff_location?.address ?? '').trim();
                    const docCount = draftDocCount ?? uploadedFiles.length;

                return (
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="text-sm font-semibold text-gray-900">Order details</div>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                        <div className="text-xs font-medium text-gray-500">Route / Service Area</div>
                        <div className="mt-1 font-semibold text-gray-900">{routeArea || '-'}</div>
                        <div className="mt-1 text-xs text-gray-600">Estimated delivery: {fulfillment}</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                        <div className="text-xs font-medium text-gray-500">Service type</div>
                        <div className="mt-1 font-semibold text-gray-900">{serviceTypeLabel}</div>
                        <div className="mt-1 text-xs text-gray-600">Documents uploaded: {docCount}</div>
                      </div>
                      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                        <div className="text-xs font-medium text-gray-500">Pickup</div>
                        <div className="mt-1 font-semibold text-gray-900">{pickupName || '-'}</div>
                        {pickupPhone ? <div className="mt-1 text-xs text-gray-700">{pickupPhone}</div> : null}
                        {pickupAddress ? <div className="mt-1 text-xs text-gray-600">{pickupAddress}</div> : null}
                      </div>
                      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                        <div className="text-xs font-medium text-gray-500">Drop-off</div>
                        <div className="mt-1 font-semibold text-gray-900">{dropName || '-'}</div>
                        {dropPhone ? <div className="mt-1 text-xs text-gray-700">{dropPhone}</div> : null}
                        {dropAddress ? <div className="mt-1 text-xs text-gray-600">{dropAddress}</div> : null}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const routeArea = String(costData?.pricingCity ?? formData?.dropoff_location?.service_area ?? formData?.pickup_location?.city ?? '').trim();
                const subtotal = Number(costData?.cost ?? 0);
                const totals = computeTotals(subtotal, routeArea);
                return (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs font-medium text-gray-500">Totals (origin-based pricing)</div>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                      <div className="rounded-lg bg-white border border-gray-200 p-3">
                        <div className="text-xs text-gray-500">Subtotal (before tax)</div>
                        <div className="mt-1 font-semibold text-gray-900">${totals.subtotal.toFixed(2)}</div>
                      </div>
                      <div className="rounded-lg bg-white border border-gray-200 p-3">
                        <div className="text-xs text-gray-500">Tax {totals.tax_note ? `(${totals.tax_note})` : ''}</div>
                        <div className="mt-1 font-semibold text-gray-900">${totals.tax.toFixed(2)}</div>
                        <div className="text-xs text-gray-500">Rate: {(totals.tax_rate * 100).toFixed(2)}%</div>
                      </div>
                      <div className="rounded-lg bg-white border border-gray-200 p-3">
                        <div className="text-xs text-gray-500">Total</div>
                        <div className="mt-1 font-bold text-gray-900">${totals.total.toFixed(2)}</div>
                        <div className="text-xs text-gray-500">Payable now</div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="space-y-3">
                <div className="text-sm font-semibold text-gray-900">Disclosures (required)</div>

                <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={disclosuresAccepted.timelines}
                    onChange={(e) =>
                      setDisclosuresAccepted((prev) => ({
                        ...prev,
                        timelines: e.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <div className="text-sm text-gray-700">
                    Timelines are estimates (weather, routing, and scheduling may affect delivery).
                  </div>
                </label>

                <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={disclosuresAccepted.payments}
                    onChange={(e) =>
                      setDisclosuresAccepted((prev) => ({
                        ...prev,
                        payments: e.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <div className="text-sm text-gray-700">Customers remain responsible for vehicle payments during transit.</div>
                </label>

                <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={disclosuresAccepted.inTransit}
                    onChange={(e) =>
                      setDisclosuresAccepted((prev) => ({
                        ...prev,
                        inTransit: e.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <div className="text-sm text-gray-700">Once picked up, the vehicle is considered “in transit.”</div>
                </label>
              </div>

              {submitMessage ? (
                <div className={`text-sm font-medium ${submitError ? 'text-red-600' : 'text-green-600'}`}>{submitMessage}</div>
              ) : null}
                </div>

                <div className="border-t border-gray-200 bg-white p-4">
                  <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setShowCheckout(false)}
                      className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={saveCurrentAsDraft}
                      className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      Save as draft
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={async () => {
                        await handlePayNow();
                      }}
                      className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-60"
                    >
                      {isSubmitting ? 'Processing…' : 'Pay now'}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {showPaymentSuccess && (
        <div
          className="fixed inset-0 z-[10003] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowPaymentSuccess(false);
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-black/70 via-black/50 to-black/70 backdrop-blur-sm"></div>
          <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-6 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/20">
                <CheckCircle className="h-5 w-5 text-white" />
              </div>
              <div>
                <div className="text-lg font-semibold">Payment successful</div>
                <div className="text-sm opacity-90">Your receipt is ready</div>
              </div>
            </div>
            <div className="p-6">
              <div className="text-sm text-gray-700">We’ve recorded your payment and generated your receipt.</div>
            </div>
            <div className="border-t border-gray-200 bg-white p-4">
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowPaymentSuccess(false)}
                  className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = String(paymentSuccessReceiptId ?? '').trim();
                    if (id) {
                      try {
                        localStorage.setItem('ed_open_receipt_id', id);
                      } catch {
                        // ignore
                      }
                    }
                    setShowPaymentSuccess(false);
                    try {
                      window.dispatchEvent(new Event('ed_open_receipts'));
                    } catch {
                      // ignore
                    }
                  }}
                  className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                >
                  Check receipt now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cost Estimate Modal */}
      {showCostEstimate && costData && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[10006] flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setShowCostEstimate(false);
                  setCostData(null);
                }
              }}
            >
              <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
              <div className="relative w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden flex flex-col">
            <div className="flex-shrink-0 bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-6 py-4">
              <div className="text-lg font-semibold">Transport Quote</div>
              <div className="text-sm opacity-90">Price based on pickup location</div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">Pickup location (pricing)</div>
                  <div className="mt-1 text-sm font-semibold text-gray-900">
                    {String(costData?.pricingCity ?? formData?.pickup_location?.city ?? formData?.dropoff_location?.service_area ?? '-')}
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-xs font-medium text-gray-500">Service Type</div>
                  <div className="mt-1 text-sm font-semibold text-gray-900">
                    {String(formData?.service?.service_type ?? '') === 'delivery_one_way' ? 'Delivery (one-way)' : 'Pickup (one-way)'}
                  </div>
                </div>
              </div>

              {/* Route Map */}
              <div className="mb-6 rounded-lg overflow-hidden border border-gray-200 h-64 bg-gray-100 relative">
                {formData?.dropoff_location?.lat && formData?.dropoff_location?.lng ? (
                  <iframe
                    src={`https://www.google.com/maps/embed/v1/directions?key=AIzaSyCtkoLYRRy_X-8cBPVn_b2UkbjNRkJeqtY&origin=${dealershipCoords?.lat || 45.5017},${dealershipCoords?.lng || -73.5673}&destination=${formData.dropoff_location.lat},${formData.dropoff_location.lng}&mode=driving&avoid=tolls`}
                    width="100%"
                    height="100%"
                    style={{ border: 0 }}
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    <div className="text-center">
                      <Navigation className="w-8 h-8 mx-auto mb-2 text-gray-400" />
                      <p className="text-sm">Route will appear when locations are set</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Route Info */}
              <div className="mb-6">
                <div className="bg-blue-50 rounded-lg p-6 text-center">
                  <div className="flex items-center justify-center mb-3">
                    <Navigation className="w-6 h-6 text-blue-600 mr-2" />
                    <span className="text-lg font-medium text-blue-800">Transport Distance</span>
                  </div>
                  <div className="text-3xl font-bold text-blue-900">
                    {costData.pricingStatus === 'official' && costData.distance === 0 ? 'N/A' : `${costData.distance} km`}
                  </div>
                </div>
              </div>

              {/* Cost */}
              <div className="text-center mb-6">
                {isLoggedIn ? (
                  <>
                    <div className="text-4xl font-bold text-cyan-600 mb-2">${costData.cost}</div>
                    <div className="text-sm text-gray-600">Price (before tax)</div>
                    <div className="text-xs text-gray-500 mt-1">Note: + applicable tax.</div>
                  </>
                ) : (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-5">
                    <div className="text-xl font-bold text-gray-900">Log in to view price</div>
                    <div className="mt-2 text-base text-gray-600">Pricing details are shown after you sign in.</div>
                  </div>
                )}
              </div>

              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <div className="text-sm text-gray-700 text-center font-medium">Estimated delivery time</div>
                <div className="text-sm text-gray-600 text-center mt-1">
                  {String(costData?.pricingCity ?? '').toLowerCase().includes('montreal') ? 'As fast as 1–2 business days' : '3–8 business days'}
                </div>
              </div>
            </div>

            <div className="flex-shrink-0 border-t border-gray-200 bg-white p-4">
              <div className="space-y-3">
                {isLoggedIn ? (
                  <button
                    onClick={handleProceedWithCost}
                    disabled={isSubmitting}
                    className="w-full bg-cyan-500 text-white px-6 py-3 rounded-lg hover:bg-cyan-600 transition-colors font-semibold disabled:opacity-60"
                  >
                    {isSubmitting ? 'Processing...' : 'Confirm & Continue'}
                  </button>
                ) : (
                  <>
                    <div className="text-sm text-gray-600 text-center">
                      Please log in with Google to continue
                    </div>
                    <button
                      onClick={() => {
                        setShowCostEstimate(false);
                        void saveDraftBeforeSignIn().then(() => {
                          onContinueToSignIn?.();
                        });
                      }}
                      className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
                    >
                      Log In with Google
                    </button>
                  </>
                )}

                <button
                  onClick={() => {
                    setShowCostEstimate(false);
                    setCostData(null);
                  }}
                  className="w-full px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )
        : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleChange}
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png"
      />

      {uploadedFiles.length === 0 && !formData && (
        <div className="rounded-2xl border border-gray-200 bg-white/95 backdrop-blur-sm shadow-xl overflow-hidden">
          <div className="px-5 sm:px-8 pt-5 sm:pt-7">
            <div className="text-center">
              <div className="text-base font-semibold text-gray-800">Start your transport request</div>
              <div className="mt-2 text-lg sm:text-xl font-bold text-gray-900">Upload a release form or enter details manually</div>
              <div className="mt-2 text-sm sm:text-base text-gray-600 max-w-xl mx-auto">
                We use pickup + drop-off to plan the route, vehicle details for accurate pricing, and documents to confirm authorization.
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={`p-5 sm:p-7 transition-all md:rounded-l-2xl ${
                dragActive ? 'bg-cyan-50' : 'bg-white'
              }`}
            >
              <div className="flex flex-col items-center text-center">
                <div className="bg-cyan-50 p-3 rounded-full mb-3 ring-1 ring-cyan-100 shadow-sm">
                  <Upload className="w-8 h-8 text-cyan-600" />
                </div>
                <div className="text-sm font-semibold text-cyan-700 mb-1">Automatic Extraction</div>
                <div className="text-lg font-semibold text-gray-900">Upload Release Form</div>
                <div className="mt-2 max-w-md text-sm text-gray-600">
                  Upload your release form or work order and we’ll auto-fill the request for you.
                </div>

                <div className="mt-4 w-full max-w-md text-left">
                  <div className="text-xs font-semibold text-gray-700">Why upload?</div>
                  <div className="mt-2 space-y-1.5 text-sm text-gray-600">
                    <div className="flex items-start gap-2">
                      <CheckCircle className="mt-0.5 h-4 w-4 text-cyan-600" />
                      <div>Faster checkout: we extract pickup, drop-off, and vehicle info automatically.</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="mt-0.5 h-4 w-4 text-cyan-600" />
                      <div>Fewer mistakes: reduces manual typing and saves time.</div>
                    </div>
                  </div>
                </div>

                <div
                  className={`mt-5 w-full max-w-md min-h-[180px] rounded-2xl border-2 border-dashed px-4 py-5 transition-colors flex flex-col items-center shadow-sm ${
                    dragActive ? 'border-cyan-500 bg-cyan-50' : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  <div className="text-center">
                    <div className="text-sm font-medium text-gray-800">Drag and drop your file here</div>
                    <div className="mt-1 text-xs text-gray-500">or</div>
                  </div>
                  <button
                    type="button"
                    onClick={onButtonClick}
                    className="mt-auto w-full bg-cyan-600 text-white px-6 py-3 rounded-lg hover:bg-cyan-700 transition-colors font-semibold"
                  >
                    Browse Files
                  </button>
                  <div className="mt-3 text-xs text-gray-500 text-center">
                    Supported formats: PDF, JPG, PNG (Max 10MB)
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t md:border-t-0 md:border-l border-gray-200 p-5 sm:p-7 md:rounded-r-2xl bg-gray-50">
              <div className="flex flex-col items-center text-center">
                <div className="bg-white p-3 rounded-full mb-3 ring-1 ring-gray-200">
                  <FileText className="w-8 h-8 text-gray-700" />
                </div>
                <div className="text-sm font-semibold text-gray-700 mb-1">Manual Entry</div>
                <div className="text-lg font-semibold text-gray-900">Fill Out the Form</div>
                <div className="mt-2 max-w-md text-sm text-gray-600">
                  Don’t have a file? Enter the details yourself. It’s the same info, just typed in.
                </div>

                <div className="mt-4 w-full max-w-md text-left">
                  <div className="text-xs font-semibold text-gray-700">Why we ask these details</div>
                  <div className="mt-2 space-y-1.5 text-sm text-gray-600">
                    <div className="flex items-start gap-2">
                      <CheckCircle className="mt-0.5 h-4 w-4 text-gray-700" />
                      <div>Pickup + drop-off: route planning + accurate pricing.</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="mt-0.5 h-4 w-4 text-gray-700" />
                      <div>Vehicle info: correct service type and handling requirements.</div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 w-full max-w-md min-h-[180px] rounded-2xl border border-gray-200 bg-white px-4 py-5 flex flex-col items-center">
                  <div className="text-center text-sm font-medium text-gray-800">No file to upload?</div>
                  <div className="mt-1 text-center text-xs text-gray-500">Open the manual form to continue.</div>

                  <button
                    type="button"
                    onClick={() => {
                      clearPersisted();
                      setSubmitMessage(null);
                      setSubmitError(false);
                      setUploadedFiles([]);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                      setFormData(createBlankFormData());
                      setActiveDraftId(null);
                      setIsManualFormOpen(true);
                    }}
                    className="mt-auto w-full px-6 py-3 rounded-lg border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 transition-colors font-semibold"
                  >
                    Open Manual Form
                  </button>

                  <div className="mt-3 text-xs text-gray-500 text-center">
                    Tip: Use manual entry if the document is missing, unclear, or incomplete.
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="px-5 sm:px-8 pb-5 sm:pb-7">
            <div className="mt-4 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
              Your information is used only to generate your quote and create your transport request.
            </div>
          </div>
        </div>
      )}

      {isManualFormOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[10005] flex items-center justify-center px-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeManualForm();
              }}
            >
              <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
              <div className="relative w-full max-w-5xl max-h-[90vh] rounded-2xl bg-white shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
                <div className="flex-shrink-0 bg-white flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100 rounded-t-2xl">
                  <div>
                    <div className="text-lg font-semibold text-gray-900">Manual Form</div>
                    <div className="text-sm text-gray-500">Fill out the form manually</div>
                  </div>
                  <button
                    type="button"
                    onClick={closeManualForm}
                    className="p-2 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
                    aria-label="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="px-4 sm:px-6 py-4 sm:py-6 overflow-y-auto flex-1 min-h-0">
                  <form onSubmit={preventFormSubmit}>
                    {renderFormDetails()}

                    <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          clearPersisted();
                          setUploadedFiles([]);
                          setSubmitMessage(null);
                          setSubmitError(false);
                          closeManualForm();
                          setActiveDraftId(null);
                          if (fileInputRef.current) fileInputRef.current.value = '';
                        }}
                        className="w-full sm:w-auto px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                      >
                        Clear All
                      </button>
                      <button
                        type="button"
                        onClick={handleSubmitDocuments}
                        disabled={isSubmitting}
                        className="w-full sm:w-auto px-6 py-3 bg-cyan-500 text-white rounded-lg hover:bg-cyan-600 transition-colors font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isSubmitting ? 'Submitting...' : 'View Quote Now'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {!isManualFormOpen && (uploadedFiles.length > 0 || formData) && (
        <div className="mt-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h4 className="text-base sm:text-lg font-semibold text-gray-800">Uploaded Files</h4>
            <button
              type="button"
              onClick={onButtonClick}
              className="w-full sm:w-auto px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
            >
              Add Files
            </button>
          </div>
          {uploadedFiles.length > 0 ? (
            <div className="space-y-3">
              {uploadedFiles.map((file) => (
                <div
                  key={file.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-gray-200 rounded-lg p-4 hover:border-cyan-500 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="bg-cyan-50 p-2 rounded">
                      <FileText className="w-6 h-6 text-cyan-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800 truncate">{file.name}</p>
                      <p className="text-sm text-gray-500">{file.size}</p>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-2">
                    <select
                      value={file.docType}
                      onChange={(e) => {
                        const v = e.target.value as UploadedFile['docType'];
                        setUploadedFiles((prev) => prev.map((x) => (x.id === file.id ? { ...x, docType: v } : x)));
                      }}
                      className="w-full sm:w-auto rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm"
                      style={{ color: '#111827', backgroundColor: '#ffffff' }}
                    >
                      <option value="unknown" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Select document type
                      </option>
                      <option value="release_form" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Vehicle Release Form (required)
                      </option>
                      <option value="work_order" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Work Order (required)
                      </option>
                      <option value="bill_of_sale" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Bill of Sale (optional)
                      </option>
                      <option value="photo" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Photos (optional)
                      </option>
                      <option value="notes" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Notes (optional)
                      </option>
                      <option value="other" className="bg-white text-gray-900" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                        Other (optional)
                      </option>
                    </select>
                    {file.docType === 'release_form' || file.docType === 'work_order' ? (
                      <div className="inline-flex items-center gap-2 rounded-full bg-green-50 border border-green-200 px-3 py-1 text-xs font-semibold text-green-700">
                        <CheckCircle className="w-4 h-4" />
                        Required
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeFile(file.id)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-500">
              No file selected (page refresh clears the file). Use “Replace File” if you need to upload again.
            </div>
          )}

          {submitMessage && (
            <div className={`mt-4 text-sm font-medium ${submitError ? 'text-red-600' : 'text-green-600'}`}>
              {submitMessage}
            </div>
          )}

          <form onSubmit={preventFormSubmit}>
            {renderFormDetails()}

            <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  clearPersisted();
                  setUploadedFiles([]);
                  setSubmitMessage(null);
                  setSubmitError(false);
                  setFormData(null);
                  setActiveDraftId(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="w-full sm:w-auto px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
              >
                Clear All
              </button>
              <button
                type="button"
                onClick={handleSubmitDocuments}
                disabled={isSubmitting}
                className="w-full sm:w-auto px-6 py-3 bg-cyan-500 text-white rounded-lg hover:bg-cyan-600 transition-colors font-medium disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Submitting...' : formData ? 'View Quote Now' : 'Extract Document'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
