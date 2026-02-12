import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Upload, FileText, X, CheckCircle, Navigation } from 'lucide-react';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L, { type LeafletMouseEvent } from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import {
  getFulfillmentDaysForRoute,
  getDistanceRatePerKm,
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

const sanitizeDigits = (v: string) => String(v ?? '').replace(/[^0-9]/g, '');
const sanitizeDigitsDash = (v: string) => String(v ?? '').replace(/[^0-9-]/g, '');
const sanitizePhone = (v: string) => String(v ?? '').replace(/[^0-9+()\-\s]/g, '');
const sanitizeDateLike = (v: string) => String(v ?? '').replace(/[^0-9/-]/g, '');
const sanitizeNoDigits = (v: string) => String(v ?? '').replace(/[0-9]/g, '');
const sanitizeLettersSpaces = (v: string) => String(v ?? '').replace(/[^a-zA-Z\s'.-]/g, '');

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
  unit: string;
  area: string;
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

const makeDraftFileKey = (file: File) => `${file.name}::${file.type}::${file.size}::${file.lastModified}`;

const emptyAddressBreakdown = (): AddressBreakdown => ({
  street: '',
  number: '',
  unit: '',
  area: '',
  city: '',
  province: '',
  postal_code: '',
  country: 'Canada',
});

const defaultAddressBreakdown = (): AddressBreakdown => ({
  ...emptyAddressBreakdown(),
  country: 'Canada',
});

const normalizeWhitespace = (value: string) => String(value ?? '').replace(/\s+/g, ' ').trim();

const stripDiacritics = (value: string) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const looksLikeStreetAddress = (value: string) => /\d/.test(String(value ?? ''));

const normalizePostalCode = (value: string) => {
  const raw = normalizeWhitespace(String(value ?? '').toUpperCase());
  if (!raw) return '';
  const compact = raw.replace(/[^A-Z0-9]/g, '');
  if (compact.length === 6) {
    const chars = compact.split('');
    const toDigit = (c: string) => (c === 'I' ? '1' : c === 'O' || c === 'Q' ? '0' : c);
    const toLetter = (c: string) => (c === '1' ? 'I' : c === '0' ? 'O' : c);
    if (chars[1]) chars[1] = toDigit(chars[1]);
    if (chars[3]) chars[3] = toDigit(chars[3]);
    if (chars[5]) chars[5] = toDigit(chars[5]);
    if (chars[0]) chars[0] = toLetter(chars[0]);
    if (chars[2]) chars[2] = toLetter(chars[2]);
    if (chars[4]) chars[4] = toLetter(chars[4]);
    const repaired = chars.join('');
    return `${repaired.slice(0, 3)} ${repaired.slice(3)}`;
  }
  return raw;
};

const repairStreetNameOcr = (street: string) => {
  const raw = normalizeWhitespace(String(street ?? ''));
  if (!raw) return '';
  return raw
    .replace(/\b(?:loe|l0e|i0e)\b(?=\s+(?:avenue|ave\.?|av\.?)\b)/i, '10e')
    .replace(/\b10E\b(?=\s+(?:avenue|ave\.?|av\.?)\b)/i, '10e');
};

const buildAddressFromBreakdown = (b: AddressBreakdown) => {
  const line1 = normalizeWhitespace(`${b.number} ${b.street}`.trim());
  const unit = normalizeWhitespace(b.unit);
  const area = normalizeWhitespace(b.area);
  const city = normalizeWhitespace(b.city);
  const prov = normalizeWhitespace(b.province);
  const postal = normalizePostalCode(b.postal_code);
  const country = normalizeWhitespace(b.country);

  const parts: string[] = [];
  if (line1) parts.push(line1);
  if (unit) parts.push(unit);
  if (area) parts.push(area);
  if (city) parts.push(city);
  const provPostal = normalizeWhitespace(`${prov} ${postal}`.trim());
  if (provPostal) parts.push(provPostal);
  if (country) parts.push(country);
  return parts.join(', ');
};

const splitLine1ToNumberStreet = (line1: string): { number: string; street: string } => {
  const raw = String(line1 ?? '');
  if (!raw.trim()) return { number: '', street: '' };

  const numberOnly = raw.match(/^\s*(\d{1,6}[A-Za-z]?)\s*$/);
  if (numberOnly?.[1]) return { number: String(numberOnly[1]).trim(), street: '' };

  const s = normalizeWhitespace(raw);
  if (!s) return { number: '', street: '' };
  const m = s.match(/^\s*(\d{1,6}[A-Za-z]?)\s+(.+)$/);
  if (m?.[1] && m?.[2]) return { number: String(m[1]).trim(), street: String(m[2]).trim() };
  return { number: '', street: s };
};

const isValidCanadianPostalCode = (value: string) => {
  const postal = normalizePostalCode(value);
  const compact = postal.replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact);
};

const postalPrefixAllowsProvince = (postal: string, province: string) => {
  const compact = normalizePostalCode(postal).replace(/[^A-Z0-9]/g, '');
  const first = compact.slice(0, 1).toUpperCase();
  const prov = String(province ?? '').trim().toUpperCase();
  if (!first || !prov) return true;

  const map: Record<string, string[]> = {
    AB: ['T'],
    BC: ['V'],
    MB: ['R'],
    NB: ['E'],
    NL: ['A'],
    NS: ['B'],
    NT: ['X'],
    NU: ['X'],
    ON: ['K', 'L', 'M', 'N', 'P'],
    PE: ['C'],
    QC: ['G', 'H', 'J'],
    SK: ['S'],
    YT: ['Y'],
  };

  const allowed = map[prov];
  if (!allowed) return true;
  return allowed.includes(first);
};

const CANADA_PROVINCE_OPTIONS = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;

const CANADA_PROVINCE_FULL_NAME: Record<string, string> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

const PROVINCE_NAME_TO_CODE: Record<string, string> = {
  ALBERTA: 'AB',
  BRITISHCOLUMBIA: 'BC',
  MANITOBA: 'MB',
  NEWBRUNSWICK: 'NB',
  NEWFOUNDLANDANDLABRADOR: 'NL',
  NOVASCOTIA: 'NS',
  NORTHWESTTERRITORIES: 'NT',
  NUNAVUT: 'NU',
  ONTARIO: 'ON',
  PRINCEEDWARDISLAND: 'PE',
  QUEBEC: 'QC',
  SASKATCHEWAN: 'SK',
  YUKON: 'YT',
};

const normalizeCountry = (value: string) => {
  const raw = normalizeWhitespace(String(value ?? ''));
  if (!raw) return '';
  const upper = raw.toUpperCase();
  const lettersOnly = upper.replace(/[^A-Z]/g, '');
  if (lettersOnly === 'CA' || lettersOnly === 'CAN' || lettersOnly === 'CANADA') return 'Canada';
  if (lettersOnly === 'US' || lettersOnly === 'USA' || lettersOnly === 'UNITEDSTATES' || lettersOnly === 'UNITEDSTATESOFAMERICA') return 'USA';
  return raw;
};

const CAN_PROVINCE_CODES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

const normalizeProvinceCode = (value: string): string => {
  const raw = normalizeWhitespace(String(value ?? ''));
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && CAN_PROVINCE_CODES.has(upper)) return upper;
  const key = upper.replace(/[^A-Z]/g, '');
  return PROVINCE_NAME_TO_CODE[key] ?? '';
};

const inferProvinceFromPostal = (postal: string): string => {
  const compact = normalizePostalCode(postal).replace(/[^A-Z0-9]/g, '');
  const first = compact.slice(0, 1).toUpperCase();
  if (!first) return '';
  if (['T'].includes(first)) return 'AB';
  if (['V'].includes(first)) return 'BC';
  if (['R'].includes(first)) return 'MB';
  if (['E'].includes(first)) return 'NB';
  if (['A'].includes(first)) return 'NL';
  if (['B'].includes(first)) return 'NS';
  if (['X'].includes(first)) return 'NT';
  if (['X'].includes(first)) return 'NU';
  if (['K', 'L', 'M', 'N', 'P'].includes(first)) return 'ON';
  if (['C'].includes(first)) return 'PE';
  if (['G', 'H', 'J'].includes(first)) return 'QC';
  if (['S'].includes(first)) return 'SK';
  if (['Y'].includes(first)) return 'YT';
  return '';
};

const extractProvincePostalFromLine = (line: string): { province: string; postal_code: string; remainder: string } => {
  const s = normalizeWhitespace(line);
  if (!s) return { province: '', postal_code: '', remainder: '' };

  const lineUpper = s.toUpperCase();
  const compactCandidates = lineUpper.match(/\b[A-Z0-9]{3}\s*[A-Z0-9]{3}\b/g) ?? [];
  let postal = '';
  let withoutPostal = lineUpper;
  for (const candidate of compactCandidates) {
    const maybe = normalizePostalCode(candidate);
    if (isValidCanadianPostalCode(maybe)) {
      postal = maybe;
      withoutPostal = normalizeWhitespace(withoutPostal.replace(candidate, '').trim());
      break;
    }
  }

  if (!postal) {
    const postalMatch = lineUpper.match(/([A-Z0-9]\s*[A-Z0-9]\s*[A-Z0-9])\s*([A-Z0-9]\s*[A-Z0-9]\s*[A-Z0-9])/i);
    const joined = postalMatch ? normalizePostalCode(`${postalMatch[1]}${postalMatch[2]}`) : '';
    if (joined && isValidCanadianPostalCode(joined)) {
      postal = joined;
      withoutPostal = normalizeWhitespace(lineUpper.replace(postalMatch?.[0] ?? '', '').trim());
    } else {
      withoutPostal = normalizeWhitespace(lineUpper.trim());
    }
  }

  let withoutCountryTokens = withoutPostal;
  withoutCountryTokens = normalizeWhitespace(withoutCountryTokens.replace(/\bCA\.?\b/gi, '').replace(/\bUSA?\.?\b/gi, '').trim());

  const tokens = withoutCountryTokens.split(' ').filter(Boolean);
  let province = '';
  let remainder = '';

  if (tokens.length) {
    const found = tokens.find((t) => CAN_PROVINCE_CODES.has(String(t).toUpperCase()));
    if (found) {
      province = String(found).toUpperCase();
      remainder = normalizeWhitespace(tokens.filter((t) => String(t).toUpperCase() !== province).join(' '));
    } else {
      province = '';
      remainder = normalizeWhitespace(tokens.join(' '));
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

  let unit = '';
  const unitIdx = parts.findIndex((p) => /\b(?:apt|apartment|suite|unit)\b|#/.test(String(p).toLowerCase()));
  if (unitIdx >= 0) {
    unit = String(parts[unitIdx] ?? '').trim();
    parts.splice(unitIdx, 1);
  }

  let country = '';
  if (parts.length) {
    const last = parts[parts.length - 1] ?? '';
    const normalized = normalizeCountry(last);
    if (normalized === 'Canada' || normalized === 'USA') {
      country = normalized;
      parts.pop();
    }
  }

  if (!country && parts.length) {
    const last = parts[parts.length - 1] ?? '';
    const trimmed = normalizeWhitespace(String(last).replace(/\bCA\.?\b/gi, '').replace(/\bUSA?\.?\b/gi, '').trim());
    const hadCA = /\bCA\.?\b/i.test(last);
    const hadUS = /\bUSA?\.?\b/i.test(last);
    if (hadCA) country = 'Canada';
    if (hadUS) country = 'USA';
    if ((hadCA || hadUS) && trimmed !== last) {
      if (trimmed) parts[parts.length - 1] = trimmed;
      else parts.pop();
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

  // Handle OCR layouts like: "8670 10e Avenue, Montréal, QC, H1Z 3B8, CA"
  // Where the province code is separated into its own comma part.
  if (parts.length >= 3) {
    const last = parts[parts.length - 1] ?? '';
    const secondLast = parts[parts.length - 2] ?? '';
    const thirdLast = parts[parts.length - 3] ?? '';
    const maybeProv = normalizeProvinceCode(secondLast);
    if (maybeProv && isValidCanadianPostalCode(last)) {
      city = thirdLast;
      provPostal = normalizeWhitespace(`${maybeProv} ${normalizePostalCode(last)}`.trim());
    }
  }

  const bestLine1 = parts.find((p) => looksLikeStreetAddress(p)) ?? '';
  if (bestLine1) {
    line1 = bestLine1;
    const idx = parts.indexOf(bestLine1);
    if (idx >= 0) {
      const next = parts[idx + 1] ?? '';
      const nextExtract = extractProvincePostalFromLine(next);
      if (next && (nextExtract.province || nextExtract.postal_code)) {
        city = nextExtract.remainder;
        provPostal = normalizeWhitespace(`${nextExtract.province} ${nextExtract.postal_code}`.trim());
      }
    }
  }

  const provPostalExtracted = extractProvincePostalFromLine(provPostal);
  const postal = provPostalExtracted.postal_code;
  let province = provPostalExtracted.province;
  if (province && province.length === 2) province = province.toUpperCase();

  if (!province && postal && country === 'Canada') {
    province = inferProvinceFromPostal(postal);
  }

  const line = normalizeWhitespace(line1);
  let number = '';
  let street = '';

  if (!unit) {
    const mUnit = line.match(/\b(?:apt|apartment|suite|unit)\b\s*#?\s*([A-Za-z0-9-]+)\b/i) || line.match(/\s#\s*([A-Za-z0-9-]+)\b/i);
    if (mUnit?.[0]) {
      unit = normalizeWhitespace(mUnit[0]);
      line1 = normalizeWhitespace(line.replace(mUnit[0], '').trim());
    }
  }

  const lineClean = normalizeWhitespace(line1);
  const startsWithNumber = lineClean.match(/^([0-9A-Z-]+)\s+(.*)$/i);
  const endsWithNumber = lineClean.match(/^(.*)\s+([0-9A-Z-]+)$/i);
  if (startsWithNumber && /^[0-9]/.test(startsWithNumber[1])) {
    number = startsWithNumber[1];
    street = startsWithNumber[2];
  } else if (endsWithNumber && /^[0-9]/.test(endsWithNumber[2])) {
    street = endsWithNumber[1];
    number = endsWithNumber[2];
  } else if (/(\b\d{1,6}[A-Z-]*\b)/.test(lineClean)) {
    const m = lineClean.match(/\b(\d{1,6}[A-Z-]*)\b\s+(.+)$/i);
    if (m && m[1] && /^[0-9]/.test(m[1])) {
      number = m[1];
      street = m[2];
    } else {
      street = lineClean;
    }
  } else {
    street = lineClean;
  }

  const normalized = normalizeProvinceCountry(province, country);
  return {
    street: repairStreetNameOcr(street),
    number: number,
    unit: unit,
    area: '',
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
  uploadedFilesMeta?: Array<{ key: string; name: string; docType: UploadedFile['docType'] }>;
};

type CostData = {
  distance: number;
  cost: number;
  duration?: number;
  route?: unknown;
  pricingCity?: string;
  pricingStatus?: 'official' | 'estimated';
};

const minimizeCostDataForStorage = (input: CostData | null | undefined): CostData | null => {
  if (!input) return null;
  return {
    distance: input.distance,
    cost: input.cost,
    duration: input.duration,
    pricingCity: input.pricingCity,
    pricingStatus: input.pricingStatus,
  };
};

const clampTextForStorage = (value: unknown, max = 4000): string => {
  const s = String(value ?? '');
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
};

const minimizeFormDataForStorage = (input: FormData | null | undefined): FormData | null => {
  if (!input) return null;
  return {
    service: {
      service_type: input.service?.service_type,
      vehicle_type: input.service?.vehicle_type,
    },
    vehicle: {
      vin: String(input.vehicle?.vin ?? ''),
      year: String(input.vehicle?.year ?? ''),
      make: String(input.vehicle?.make ?? ''),
      model: String(input.vehicle?.model ?? ''),
      transmission: String(input.vehicle?.transmission ?? ''),
      odometer_km: String(input.vehicle?.odometer_km ?? ''),
      exterior_color: String(input.vehicle?.exterior_color ?? ''),
    },
    selling_dealership: {
      name: clampTextForStorage(input.selling_dealership?.name, 400),
      phone: clampTextForStorage(input.selling_dealership?.phone, 80),
      address: clampTextForStorage(input.selling_dealership?.address, 600),
    },
    buying_dealership: {
      name: clampTextForStorage(input.buying_dealership?.name, 400),
      phone: clampTextForStorage(input.buying_dealership?.phone, 80),
      contact_name: clampTextForStorage(input.buying_dealership?.contact_name, 200),
    },
    pickup_location: {
      name: clampTextForStorage(input.pickup_location?.name, 200),
      contact_name: clampTextForStorage((input.pickup_location as unknown as Record<string, unknown>)?.contact_name, 200),
      email: clampTextForStorage((input.pickup_location as unknown as Record<string, unknown>)?.email, 320),
      address: clampTextForStorage(input.pickup_location?.address, 800),
      street: clampTextForStorage(input.pickup_location?.street, 300),
      number: clampTextForStorage(input.pickup_location?.number, 60),
      unit: clampTextForStorage(input.pickup_location?.unit, 60),
      area: clampTextForStorage(input.pickup_location?.area, 120),
      city: clampTextForStorage(input.pickup_location?.city, 160),
      province: clampTextForStorage(input.pickup_location?.province, 40),
      postal_code: clampTextForStorage(input.pickup_location?.postal_code, 40),
      country: clampTextForStorage(input.pickup_location?.country, 60) || 'Canada',
      phone: clampTextForStorage(input.pickup_location?.phone, 80),
    },
    dropoff_location: {
      name: clampTextForStorage(input.dropoff_location?.name, 200),
      contact_name: clampTextForStorage((input.dropoff_location as unknown as Record<string, unknown>)?.contact_name, 200),
      email: clampTextForStorage((input.dropoff_location as unknown as Record<string, unknown>)?.email, 320),
      phone: clampTextForStorage(input.dropoff_location?.phone, 80),
      address: clampTextForStorage(input.dropoff_location?.address, 800),
      street: clampTextForStorage(input.dropoff_location?.street, 300),
      number: clampTextForStorage(input.dropoff_location?.number, 60),
      unit: clampTextForStorage(input.dropoff_location?.unit, 60),
      area: clampTextForStorage(input.dropoff_location?.area, 120),
      city: clampTextForStorage(input.dropoff_location?.city, 160),
      province: clampTextForStorage(input.dropoff_location?.province, 40),
      postal_code: clampTextForStorage(input.dropoff_location?.postal_code, 40),
      country: clampTextForStorage(input.dropoff_location?.country, 60) || 'Canada',
      lat: clampTextForStorage(input.dropoff_location?.lat, 40),
      lng: clampTextForStorage(input.dropoff_location?.lng, 40),
    },
    transaction: {
      transaction_id: clampTextForStorage(input.transaction?.transaction_id, 120),
      release_form_number: clampTextForStorage(input.transaction?.release_form_number, 120),
      release_date: clampTextForStorage(input.transaction?.release_date, 40),
      arrival_date: clampTextForStorage(input.transaction?.arrival_date, 40),
    },
    authorization: {
      released_by_name: clampTextForStorage(input.authorization?.released_by_name, 200),
      released_to_name: clampTextForStorage(input.authorization?.released_to_name, 200),
    },
    dealer_notes: clampTextForStorage(input.dealer_notes, 2000),
    costEstimate: input.costEstimate ? minimizeCostDataForStorage(input.costEstimate) : undefined,
    vehicle_condition:
      (input as unknown as Record<string, unknown>)?.vehicle_condition === 'does_not_run_or_drive' ? 'does_not_run_or_drive' : 'runs_and_drives',
    draft_source: String(input.draft_source ?? '').trim() || undefined,
    pickup_locked: Boolean(input.pickup_locked),
    transaction_id: clampTextForStorage((input as unknown as Record<string, unknown>)?.transaction_id, 120) || undefined,
    release_form_number: clampTextForStorage((input as unknown as Record<string, unknown>)?.release_form_number, 120) || undefined,
    arrival_date: clampTextForStorage((input as unknown as Record<string, unknown>)?.arrival_date, 40) || undefined,
  };
};

const emitQuoteReady = (payload: { formData: unknown; costData: unknown; docCount: number; source: 'manual' | 'bulk_upload' }) => {
  try {
    window.dispatchEvent(new CustomEvent('ed_quote_ready', { detail: payload }));
  } catch {
    // ignore
  }
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
    contact_name: string;
    email: string;
    address: string;
    street: string;
    number: string;
    unit: string;
    area: string;
    city: string;
    province: string;
    postal_code: string;
    country: string;
    phone: string;
  };
  dropoff_location: {
    name: string;
    contact_name: string;
    email: string;
    phone: string;
    address: string;
    street: string;
    number: string;
    unit: string;
    area: string;
    city: string;
    province: string;
    postal_code: string;
    country: string;
    lat: string;
    lng: string;
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
  vehicle_condition?: 'runs_and_drives' | 'does_not_run_or_drive';
  draft_source?: string;
  pickup_locked?: boolean;
  transaction_id?: string;
  release_form_number?: string;
  arrival_date?: string;
};

type ManualWizardStep = 'locations' | 'vehicle' | 'quote';

type AddressSuggestion = {
  text: string;
  magicKey?: string;
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

const collectTextFromUnknown = (value: unknown, maxChars = 20000): string => {
  const parts: string[] = [];
  let total = 0;

  const push = (s: string) => {
    const next = String(s ?? '').trim();
    if (!next) return;
    if (total >= maxChars) return;
    const slice = next.length + total > maxChars ? next.slice(0, Math.max(0, maxChars - total)) : next;
    if (!slice) return;
    parts.push(slice);
    total += slice.length;
  };

  const walk = (v: unknown) => {
    if (total >= maxChars) return;
    if (typeof v === 'string') {
      push(v);
      return;
    }
    if (!v) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) walk(item);
    }
  };

  walk(value);
  return parts.join('\n');
};

const normalizeLooseKey = (value: string): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const inferMimeTypeFromName = (name: string): string => {
  const lower = String(name ?? '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
};

const normalizeMimeType = (name: string, type: unknown): string => {
  const raw = String(type ?? '').trim();
  if (raw && raw !== 'unknown') return raw;
  return inferMimeTypeFromName(name);
};

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

const extractTransactionIdFromText = (text: string): string => {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/\bTransaction\s*(?:ID|#|No\.?|Number)?\s*[:#-]?\s*([0-9][0-9-]{2,})\b/i);
  return match?.[1] ?? '';
};

const extractReleaseFormNumberFromText = (text: string): string => {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/\bRelease\s*Form\s*(?:#|No\.?|Number)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{1,})\b/i);
  return match?.[1] ?? '';
};

const extractLabeledValueFromText = (text: string, label: string): string => {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const safeLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${safeLabel}\\b\\s*[:#-]?\\s*([^\\r\\n]{1,60})`, 'i');
  const match = raw.match(re);
  const val = String(match?.[1] ?? '').trim();
  return val;
};

const extractSectionBlockFromText = (text: string, headingPattern: RegExp, maxChars = 500): string => {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const idx = normalized.search(headingPattern);
  if (idx < 0) return '';
  const slice = normalized.slice(idx);
  const stop = slice.search(/\n\s*(?:Selling\s+Dealership|Sell\w*\s+Dealersh\w*|Pickup\s+Date|Pick\w*\s+Date|Released\s+By|Release\s+Date|Transportation\s+Company|Buyer\b|Seller\b)\b/i);
  const chunk = stop > 0 ? slice.slice(0, stop) : slice;
  return chunk.slice(0, maxChars).trim();
};

const extractBetweenHeadingsFromText = (text: string, startPattern: RegExp, endPatterns: RegExp[], maxChars = 500): string => {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const idx = normalized.search(startPattern);
  if (idx < 0) return '';
  const slice = normalized.slice(idx);
  let endPos = -1;
  for (const p of endPatterns) {
    const next = slice.slice(1).search(p);
    if (next < 0) continue;
    const pos = next + 1;
    if (endPos < 0 || pos < endPos) endPos = pos;
  }
  const chunk = endPos > 0 ? slice.slice(0, endPos) : slice;
  return chunk.slice(0, maxChars).trim();
};

const extractVehicleYmmNearVinFromText = (text: string, vin: string): { year: string; make: string; model: string } => {
  const raw = String(text ?? '');
  const v = String(vin ?? '').trim();
  if (!raw.trim() || !v) return { year: '', make: '', model: '' };
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const normalizeYearToken = (token: string): string => {
    const repaired = String(token ?? '')
      .replace(/[Il]/g, '1')
      .replace(/[Oo]/g, '0');
    const match = repaired.match(/\b(19\d{2}|20\d{2})\b/);
    return match?.[1] ?? '';
  };

  const parseYmmFromLine = (line: string): { year: string; make: string; model: string } => {
    const s = String(line ?? '').trim();
    if (!s) return { year: '', make: '', model: '' };
    const m = s.match(/\b((?:19|20)[0-9IlOo]{2})\b\s+([A-Za-z][A-Za-z0-9&.'\/-]{1,})\s+([^\r\n]{2,60})/);
    const y = normalizeYearToken(m?.[1] ?? '');
    if (!y) return { year: '', make: '', model: '' };
    return { year: y, make: String(m?.[2] ?? '').trim(), model: String(m?.[3] ?? '').trim() };
  };

  const vinUpper = v.toUpperCase();
  const idxDirect = normalized.toUpperCase().indexOf(vinUpper);
  const idxShort = idxDirect >= 0 ? idxDirect : normalized.toUpperCase().indexOf(vinUpper.slice(-8));
  if (idxShort < 0) return { year: '', make: '', model: '' };

  const windowStart = Math.max(0, idxShort - 500);
  const windowEnd = Math.min(normalized.length, idxShort + 200);
  const windowText = normalized.slice(windowStart, windowEnd);
  const lines = windowText
    .split('\n')
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);

  const yearLine =
    lines.find((l) => /\b(?:19|20)[0-9IlOo]{2}\b/.test(l) && /[A-Za-z]/.test(l) && !/\bDate\b/i.test(l)) ??
    '';

  return parseYmmFromLine(yearLine);
};

const extractFirstPhoneFromText = (text: string): string => {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const match = raw.match(/(\+?1\s*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/);
  return match ? String(match[0]).trim() : '';
};

const stripContactFromAddressBlock = (block: string, knownName?: string, headingPatterns?: RegExp | RegExp[]): string => {
  const raw = String(block ?? '');
  if (!raw.trim()) return '';
  const name = String(knownName ?? '').trim().toLowerCase();
  const phoneRe = /(\+?1\s*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/g;
  const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const patterns = Array.isArray(headingPatterns)
    ? headingPatterns
    : headingPatterns
      ? [headingPatterns]
      : [/\bP[IL]CKUP\s+LOCAT[IL]ON\b\s*:?\s*/i];

  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => String(l ?? '').trim())
    .map((line) => {
      let l = String(line ?? '');
      for (const p of patterns) l = l.replace(p, '');
      return l.replace(phoneRe, '').replace(emailRe, '').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .filter((l) => {
      if (!name) return true;
      return l.toLowerCase() !== name;
    });

  const joined = lines
    .join(', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '')
    .trim();
  return joined;
};

const looksLikeCleanStreetAddress = (value: string): boolean => {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (!looksLikeStreetAddress(raw)) return false;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw)) return false;
  if (/(\+?1\s*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(raw)) return false;
  if (/\bP[IL]CKUP\s+LOCAT[IL]ON\b/i.test(raw)) return false;
  if (/\,\s*,/.test(raw)) return false;
  if (/\bCA\.?\s*$/i.test(raw)) return false;
  return true;
};

const extractVinFromText = (text: string): string => {
  const raw = String(text ?? '').toUpperCase();
  if (!raw) return '';

  const repair = (candidate: string): string =>
    String(candidate ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/I/g, '1')
      .replace(/[OQ]/g, '0');

  const translit = (c: string): number => {
    if (/\d/.test(c)) return Number(c);
    switch (c) {
      case 'A':
      case 'J':
        return 1;
      case 'B':
      case 'K':
      case 'S':
        return 2;
      case 'C':
      case 'L':
      case 'T':
        return 3;
      case 'D':
      case 'M':
      case 'U':
        return 4;
      case 'E':
      case 'N':
      case 'V':
        return 5;
      case 'F':
      case 'W':
        return 6;
      case 'G':
      case 'P':
      case 'X':
        return 7;
      case 'H':
      case 'Y':
        return 8;
      case 'R':
      case 'Z':
        return 9;
      default:
        return -1;
    }
  };

  const vinCheckDigit = (vin: string): string | null => {
    const v = String(vin ?? '').toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return null;
    const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 17; i += 1) {
      const val = translit(v[i]);
      if (val < 0) return null;
      sum += val * weights[i];
    }
    const mod = sum % 11;
    return mod === 10 ? 'X' : String(mod);
  };

  const isValidVinCandidate = (candidate: string): boolean => {
    const vin = repair(candidate);
    if (!vin) return false;
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
    if (!/[0-9]/.test(vin)) return false;
    const expected = vinCheckDigit(vin);
    if (!expected) return false;
    if (vin[8] !== expected) return false;
    return true;
  };

  const labeled = raw.match(/\bVIN\b[^A-Z0-9]{0,10}([A-Z0-9][A-Z0-9\s\-]{16,40})/i);
  if (labeled?.[1]) {
    const c = repair(labeled[1]);
    if (isValidVinCandidate(c)) return c;
  }

  const direct = raw.match(/\b[A-Z0-9]{17}\b/g) ?? [];
  const directValid = direct.map(repair).find((c) => isValidVinCandidate(c));
  if (directValid) return directValid;

  const looseMatches = raw.match(/(?:[A-Z0-9][\s\-]*){17}/g) ?? [];
  for (const match of looseMatches) {
    const compact = repair(match);
    if (isValidVinCandidate(compact)) return compact;
  }

  return '';
};

const normalizeDateLike = (value: string): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const ymd = raw.match(/\b(19\d{2}|20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\b/);
  if (ymd) {
    const y = ymd[1];
    const m = String(ymd[2]).padStart(2, '0');
    const d = String(ymd[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const mdy = raw.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](19\d{2}|20\d{2})\b/);
  if (mdy) {
    const m = String(mdy[1]).padStart(2, '0');
    const d = String(mdy[2]).padStart(2, '0');
    const y = mdy[3];
    return `${y}-${m}-${d}`;
  }
  return '';
};

const extractArrivalDateFromText = (text: string): string => {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/\bArrival\s*Date\b\s*[:#-]?\s*([0-9]{1,4}[\/-][0-9]{1,2}[\/-][0-9]{1,4})\b/i);
  const candidate = match?.[1] ?? '';
  return normalizeDateLike(candidate);
};

const extractWebhookOutput = (data: unknown): unknown => {
  const isBlankValue = (value: unknown): boolean => {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    return false;
  };

  const mergeNonBlank = (base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base };
    for (const [key, nextVal] of Object.entries(incoming)) {
      const prevVal = out[key];
      if (isRecord(prevVal) && isRecord(nextVal)) {
        out[key] = mergeNonBlank(prevVal as Record<string, unknown>, nextVal as Record<string, unknown>);
        continue;
      }
      if (prevVal === undefined || isBlankValue(prevVal)) {
        if (!isBlankValue(nextVal)) out[key] = nextVal;
        continue;
      }
    }
    return out;
  };

  const mergeWrapper = (wrapper: Record<string, unknown>): unknown => {
    const output = wrapper.output;
    if (!isRecord(output)) return output ?? null;
    const merged: Record<string, unknown> = { ...wrapper, ...(output as Record<string, unknown>) };
    delete merged.output;
    return merged;
  };

  if (Array.isArray(data)) {
    let mergedRecord: Record<string, unknown> | null = null;
    let fallback: unknown = null;

    for (const item of data) {
      if (!item) continue;
      if (isRecord(item)) {
        const extracted = mergeWrapper(item);
        if (isRecord(extracted)) {
          mergedRecord = mergedRecord ? mergeNonBlank(mergedRecord, extracted as Record<string, unknown>) : (extracted as Record<string, unknown>);
        } else if (!fallback && extracted) {
          fallback = extracted;
        }
      } else if (!fallback) {
        fallback = item;
      }
    }

    return mergedRecord ?? fallback;
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

export default function FileUploadSection({ hideHeader: _hideHeader = false, onContinueToSignIn, persistState = true }: FileUploadSectionProps) {
  const STORAGE_FORM = 'ed_extractedFormData';
  const STORAGE_MESSAGE = 'ed_submitMessage';
  const STORAGE_ERROR = 'ed_submitError';
  const STORAGE_RECEIPTS_PENDING = 'ed_receipts_pending';
  const STORAGE_RECEIPTS_BY_USER_PREFIX = 'ed_receipts_by_user_';
  const STORAGE_MANUAL_RESUME = 'ed_manual_wizard_resume_v1';

  const extractionUrl = (() => {
    const fnPath = '/.netlify/functions/extract-documents';
    const isLocalhost =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (import.meta.env.DEV && isLocalhost) {
      return `http://localhost:8888${fnPath}`;
    }
    const envUrl = String(import.meta.env.VITE_EXTRACTION_URL ?? '').trim();
    if (envUrl) return envUrl;
    return fnPath;
  })();

  const STORAGE_DRAFTS = 'ed_checkout_drafts_v1';
  const STORAGE_DRAFTS_PRIMARY = 'ed_checkout_drafts';

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userKey, setUserKey] = useState<string | null>(null);

  const getDraftStorageKey = (base: string) => {
    const safeUser = String(userKey ?? '').trim() || 'anon';
    return `${base}__${safeUser}`;
  };

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
  const [manualWizardStep, setManualWizardStep] = useState<ManualWizardStep>('locations');
  const [manualWizardError, setManualWizardError] = useState<string | null>(null);
  const [manualVinDecodeLoading, setManualVinDecodeLoading] = useState(false);

  const [pickupSearch, setPickupSearch] = useState('');
  const [pickupSuggestions, setPickupSuggestions] = useState<AddressSuggestion[]>([]);
  const [pickupSuggestLoading, setPickupSuggestLoading] = useState(false);

  const [dropoffSearch, setDropoffSearch] = useState('');
  const [dropoffSuggestions, setDropoffSuggestions] = useState<AddressSuggestion[]>([]);
  const [dropoffSuggestLoading, setDropoffSuggestLoading] = useState(false);
  const [resumeManualWizardAfterLogin, setResumeManualWizardAfterLogin] = useState<ManualWizardStep | null>(null);
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
  const [vehicleCondition, setVehicleCondition] = useState<'runs_and_drives' | 'does_not_run_or_drive'>(
    'runs_and_drives'
  );
  const [checkoutConfirmations, setCheckoutConfirmations] = useState({
    pickupAddress: false,
    dropoffAddress: false,
    vehicleDetails: false,
    vehicleRunsAndDrives: false,
    vehicleDoesNotRunOrDrive: false,
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

  useEffect(() => {
    const persisted = (formData as unknown as Record<string, unknown> | null)?.vehicle_condition;
    if (persisted === 'does_not_run_or_drive') {
      setVehicleCondition('does_not_run_or_drive');
      return;
    }
    if (persisted === 'runs_and_drives') {
      setVehicleCondition('runs_and_drives');
    }
  }, [formData]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const suppressGeocodeRef = useRef(false);
  const autoExtractTriggeredRef = useRef(false);
  const [dealershipCoords, setDealershipCoords] = useState<{ lat: number; lng: number } | null>(null);
  const pickupStreetLine1EditingRef = useRef(false);
  const dropoffStreetLine1EditingRef = useRef(false);
  const [pickupStreetLine1Input, setPickupStreetLine1Input] = useState('');
  const [dropoffStreetLine1Input, setDropoffStreetLine1Input] = useState('');
  const [pickupStreetSelected, setPickupStreetSelected] = useState(false);
  const [pickupNumberError, setPickupNumberError] = useState<string | null>(null);
  const [dropoffStreetSelected, setDropoffStreetSelected] = useState(false);
  const [dropoffNumberError, setDropoffNumberError] = useState<string | null>(null);

  useEffect(() => {
    if (pickupStreetLine1EditingRef.current) return;
    const derived = normalizeWhitespace(
      `${String(formData?.pickup_location?.number ?? '').trim()} ${String(formData?.pickup_location?.street ?? '').trim()}`.trim()
    );
    setPickupStreetLine1Input(derived);
  }, [formData?.pickup_location?.number, formData?.pickup_location?.street]);

  useEffect(() => {
    if (dropoffStreetLine1EditingRef.current) return;
    const derived = normalizeWhitespace(
      `${String(formData?.dropoff_location?.number ?? '').trim()} ${String(formData?.dropoff_location?.street ?? '').trim()}`.trim()
    );
    setDropoffStreetLine1Input(derived);
  }, [formData?.dropoff_location?.number, formData?.dropoff_location?.street]);

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
    if (!formData) return;
    const now = new Date().toISOString();
    const draftId = activeDraftId ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inferredDraftSource: CheckoutDraft['draftSource'] =
      String(formData?.draft_source ?? '').trim() === 'bulk_upload' || uploadedFiles.length > 0 ? 'bulk_upload' : 'manual';
    const persistedCost = minimizeCostDataForStorage(costData);
    const persistedForm = minimizeFormDataForStorage(formData) ?? formData;
    const draft: CheckoutDraft = {
      id: draftId,
      createdAt: now,
      formData: {
        ...persistedForm,
        draft_source:
          String(formData?.draft_source ?? '').trim() || (inferredDraftSource === 'bulk_upload' ? 'bulk_upload' : 'manual'),
      },
      costData: persistedCost,
      docCount: draftDocCount ?? uploadedFiles.length,
      draftSource: inferredDraftSource,
      uploadedFilesMeta: uploadedFiles.map((f) => ({ key: makeDraftFileKey(f.file), name: f.name, docType: f.docType })),
    };
    try {
      const raw = localStorage.getItem(getDraftStorageKey(STORAGE_DRAFTS_PRIMARY)) ?? localStorage.getItem(getDraftStorageKey(STORAGE_DRAFTS));
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];

      const next = (() => {
        if (activeDraftId) {
          const idx = existing.findIndex((d) => d && typeof d === 'object' && (d as CheckoutDraft).id === activeDraftId);
          if (idx >= 0) {
            const copy = [...existing];
            copy[idx] = draft;
            return copy;
          }
        }
        return [draft, ...existing];
      })();

      try {
        localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS_PRIMARY), JSON.stringify(next));
        localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS), JSON.stringify(next));
      } catch {
        const trimmed = next.slice(0, 6);
        localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS_PRIMARY), JSON.stringify(trimmed));
        localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS), JSON.stringify(trimmed));
      }
    } catch {
      setSubmitMessage('Failed to save draft. Please check browser storage settings and try again.');
      setSubmitError(true);
      return;
    }

    try {
      window.dispatchEvent(new Event('ed_drafts_updated'));
    } catch {
      // ignore
    }

    setShowCheckout(false);
    setShowCostEstimate(false);
    if (isManualFormOpen) setIsManualFormOpen(false);
    setActiveDraftId(null);
    setDraftDocCount(null);
    setCostData(null);
    setFormData(null);
    setUploadedFiles([]);
    setSubmitMessage(persistedCost ? 'Saved to drafts. You can pay later from Drafts.' : 'Saved to drafts. Continue later from Drafts.');
    setSubmitError(false);

    try {
      localStorage.setItem('ed_open_drafts', '1');
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new Event('ed_open_drafts'));
    } catch {
      // ignore
    }
  };

  const saveDraftBeforeSignIn = useCallback(async (override?: { formData?: FormData | null; costData?: CostData | null }): Promise<string | null> => {
    const effectiveFormData = override && 'formData' in override ? override.formData : formData;
    const effectiveCostData = override && 'costData' in override ? override.costData ?? null : costData;
    if (uploadedFiles.length === 0 && !effectiveFormData && !effectiveCostData) return null;

    const persistedCostData = minimizeCostDataForStorage(effectiveCostData);
    const inferredDraftSource: CheckoutDraft['draftSource'] =
      String(effectiveFormData?.draft_source ?? '').trim() === 'bulk_upload' || (!effectiveFormData && uploadedFiles.length > 0)
        ? 'bulk_upload'
        : 'manual';

    const draftId = activeDraftId ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const baseForm: FormData =
      effectiveFormData ??
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
          contact_name: '',
          email: '',
        },
        dropoff_location: {
          name: '',
          phone: '',
          address: '',
          ...emptyAddressBreakdown(),
          lat: '',
          lng: '',
          contact_name: '',
          email: '',
        },
        transaction: { transaction_id: '', release_form_number: '', release_date: '', arrival_date: '' },
        authorization: { released_by_name: '', released_to_name: '' },
        dealer_notes: '',
        vehicle_condition: 'runs_and_drives',
      } satisfies FormData);

    const draft: CheckoutDraft = {
      id: draftId,
      createdAt: new Date().toISOString(),
      formData: {
        ...baseForm,
        draft_source:
          String(baseForm.draft_source ?? '').trim() || (inferredDraftSource === 'bulk_upload' ? 'bulk_upload' : 'manual'),
      },
      costData: persistedCostData,
      docCount: draftDocCount ?? uploadedFiles.length,
      draftSource: inferredDraftSource,
      needsExtraction: !effectiveFormData,
      uploadedFilesMeta: uploadedFiles.map((f) => ({ key: makeDraftFileKey(f.file), name: f.name, docType: f.docType })),
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
      const raw = localStorage.getItem(getDraftStorageKey(STORAGE_DRAFTS));
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];
      const idx = existing.findIndex((d) => d && typeof d === 'object' && (d as CheckoutDraft).id === draftId);
      if (idx >= 0) {
        const next = [...existing];
        next[idx] = draft;
        localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS), JSON.stringify(next));
      } else {
        localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS), JSON.stringify([draft, ...existing]));
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
    return draftId;
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
        const uploadedFilesMetaRaw = (detail as Record<string, unknown>).uploadedFilesMeta;
        const uploadedFilesMeta = Array.isArray(uploadedFilesMetaRaw)
          ? (uploadedFilesMetaRaw
              .map((x) => {
                if (!isRecord(x)) return null;
                const key = readString(x.key);
                const name = readString(x.name);
                const docType = x.docType;
                if (!key || !name) return null;
                if (
                  docType !== 'release_form' &&
                  docType !== 'work_order' &&
                  docType !== 'bill_of_sale' &&
                  docType !== 'photo' &&
                  docType !== 'notes' &&
                  docType !== 'other' &&
                  docType !== 'unknown'
                ) {
                  return null;
                }
                return { key, name, docType } as { key: string; name: string; docType: UploadedFile['docType'] };
              })
              .filter(Boolean) as Array<{ key: string; name: string; docType: UploadedFile['docType'] }>)
          : [];
        if (!isRecord(nextFormData)) return;
        const draftId = typeof nextDraftId === 'string' ? nextDraftId : null;

        const needsExtraction = Boolean((detail as Record<string, unknown>)?.needsExtraction);

        const restoredFormData = !needsExtraction ? (nextFormData as FormData) : null;
        setFormData(restoredFormData);

        const draftSource = readString((restoredFormData as unknown as Record<string, unknown> | null)?.draft_source);

        setPickupStreetSelected(Boolean(String(restoredFormData?.pickup_location?.street ?? '').trim()));
        setDropoffStreetSelected(Boolean(String(restoredFormData?.dropoff_location?.street ?? '').trim()));

        const hasCost = !needsExtraction && isRecord(nextCostData);
        setCostData(hasCost ? (nextCostData as CostData) : null);
        setDraftDocCount(typeof nextDocCount === 'number' && Number.isFinite(nextDocCount) ? nextDocCount : null);
        setActiveDraftId(draftId);

        if (hasCost) {
          try {
            emitQuoteReady({
              formData: restoredFormData,
              costData: minimizeCostDataForStorage(nextCostData as CostData),
              docCount: typeof nextDocCount === 'number' && Number.isFinite(nextDocCount) ? nextDocCount : uploadedFilesMeta.length,
              source: draftSource === 'manual' ? 'manual' : 'bulk_upload',
            });
          } catch {
            // ignore
          }
        }

        if (draftSource === 'manual') {
          setUploadedFiles([]);
          setPickupSearch(String(restoredFormData?.pickup_location?.address ?? '').trim());
          setDropoffSearch(String(restoredFormData?.dropoff_location?.address ?? '').trim());

          const hasPickup = Boolean(String(restoredFormData?.pickup_location?.address ?? '').trim());
          const hasDropoff = Boolean(String(restoredFormData?.dropoff_location?.address ?? '').trim());
          const nextStep: ManualWizardStep = hasCost ? 'quote' : hasPickup || hasDropoff ? 'vehicle' : 'locations';

          setManualWizardStep(nextStep);
          setIsManualFormOpen(true);
          setShowCheckout(false);
          setShowCostEstimate(false);
          setSubmitMessage('Draft loaded. Continue your manual quote.');
          setSubmitError(false);
          return;
        }

        if (draftId) {
          try {
            const files = await getDraftFiles(draftId);
            if (files && files.length) {
              const restored: UploadedFile[] = files.map((file) => ({
                ...(uploadedFilesMeta.length
                  ? (() => {
                      const key = makeDraftFileKey(file);
                      const meta = uploadedFilesMeta.find((m) => m.key === key) ?? uploadedFilesMeta.find((m) => m.name === file.name);
                      return { docType: meta?.docType ?? ('unknown' as const) };
                    })()
                  : { docType: 'unknown' as const }),
                id: Math.random().toString(36).slice(2),
                name: file.name,
                size: formatFileSize(file.size),
                type: file.type || 'unknown',
                file,
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
        setShowCostEstimate(Boolean(hasCost));
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

  const isOntarioOrQuebec = (regionRaw: unknown): boolean => {
    const region = String(regionRaw ?? '').trim().toLowerCase();
    if (!region) return false;
    return region === 'on' || region === 'qc' || region === 'ontario' || region === 'quebec';
  };

  const looksLikeOntarioOrQuebecSuggestion = (textRaw: unknown): boolean => {
    const text = String(textRaw ?? '').trim();
    if (!text) return false;
    return /,\s*(ON|QC)(?:\s|$)/.test(text) || /\b(ontario|quebec)\b/i.test(text);
  };

  const geocodeAddress = async (address: string): Promise<{ lat: number; lng: number } | null> => {
    const q = address.trim();
    if (!q) return null;

    const parts = q.split(',').map((p) => p.trim()).filter(Boolean);
    const idxWithNumber = parts.findIndex((p) => /\d/.test(p));
    const normalizedQuery = idxWithNumber > 0 ? parts.slice(idxWithNumber).join(', ') : q;
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=pjson&maxLocations=1&outFields=Region,Country,CountryCode&sourceCountry=CAN&singleLine=${encodeURIComponent(normalizedQuery)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ location?: { x?: number; y?: number }; attributes?: { Region?: unknown; CountryCode?: unknown; Country?: unknown } }>;
    };
    const candidate = data?.candidates?.[0];
    if (!isOntarioOrQuebec(candidate?.attributes?.Region)) return null;
    const lat = Number(candidate?.location?.y);
    const lng = Number(candidate?.location?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  };

  const decodeVinViaNhtsa = async (vin: string): Promise<{ year: string; make: string; model: string } | null> => {
    const v = String(vin ?? '').trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return null;
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${encodeURIComponent(v)}?format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as unknown;
    const results = isRecord(json) ? (json as Record<string, unknown>).Results : null;
    const first = Array.isArray(results) && results.length ? (results[0] as unknown) : null;
    if (!isRecord(first)) return null;
    const year = String((first as Record<string, unknown>).ModelYear ?? '').trim();
    const make = String((first as Record<string, unknown>).Make ?? '').trim();
    const model = String((first as Record<string, unknown>).Model ?? '').trim();
    if (!year && !make && !model) return null;
    return { year, make, model };
  };

  const validateStreetNumber = async ({ number, street, city, province }: { number: string; street: string; city: string; province: string }): Promise<boolean> => {
    const n = String(number ?? '').trim();
    const st = String(street ?? '').trim();
    const c = String(city ?? '').trim();
    const p = String(province ?? '').trim();
    if (!n || !st || !c || !p) return false;
    if (!/^\d{1,6}[A-Za-z]?$/.test(n)) return false;
    const stClean = stripDiacritics(st);
    const cClean = stripDiacritics(c);
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=pjson&maxLocations=1&outFields=*&Address=${encodeURIComponent(`${n} ${stClean}`)}&City=${encodeURIComponent(cClean)}&Region=${encodeURIComponent(p)}&CountryCode=CAN`;
    const res = await fetch(url);
    if (!res.ok) return true;
    const data = (await res.json().catch(() => null)) as {
      candidates?: Array<{ score?: number; address?: string }>;
    };
    const cand = (data?.candidates ?? [])[0];
    const score = Number(cand?.score);
    if (!Number.isFinite(score)) return true;
    if (score < 80) return false;
    return true;
  };

  useEffect(() => {
    if (pickupStreetSelected) {
      setPickupNumberError(null);
      return;
    }
    const city = String(formData?.pickup_location?.city ?? '').trim();
    const province = String(formData?.pickup_location?.province ?? '').trim();
    const street = String(formData?.pickup_location?.street ?? '').trim();
    const number = String(formData?.pickup_location?.number ?? '').trim();
    if (!city || !province || !street) {
      setPickupNumberError(null);
      return;
    }
    if (!number || street.length < 2) {
      setPickupNumberError(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      const ok = await validateStreetNumber({ number, street, city, province }).catch(() => false);
      setPickupNumberError(ok ? null : 'Street number not found on this street in this city');
    }, 320);
    return () => window.clearTimeout(timer);
  }, [pickupStreetSelected, formData?.pickup_location?.number, formData?.pickup_location?.street, formData?.pickup_location?.city, formData?.pickup_location?.province]);

  useEffect(() => {
    const city = String(formData?.dropoff_location?.city ?? '').trim();
    const province = String(formData?.dropoff_location?.province ?? '').trim();
    const street = String(formData?.dropoff_location?.street ?? '').trim();
    const number = String(formData?.dropoff_location?.number ?? '').trim();
    if (!city || !province || !street) {
      setDropoffNumberError(null);
      return;
    }
    if (!number || street.length < 2) {
      setDropoffNumberError(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      const ok = await validateStreetNumber({ number, street, city, province }).catch(() => false);
      setDropoffNumberError(ok ? null : 'Street number not found on this street in this city');
    }, 320);
    return () => window.clearTimeout(timer);
  }, [dropoffStreetSelected, formData?.dropoff_location?.number, formData?.dropoff_location?.street, formData?.dropoff_location?.city, formData?.dropoff_location?.province]);

  const reverseGeocode = async (lat: number, lng: number): Promise<string | null> => {
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=pjson&location=${encodeURIComponent(String(lng))}%2C${encodeURIComponent(String(lat))}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: { Match_addr?: string; LongLabel?: string; Region?: unknown } };
    if (!isOntarioOrQuebec(data?.address?.Region)) return null;
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

            const costPerKm = getDistanceRatePerKm();
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
          const mapboxToken = String((import.meta as any)?.env?.VITE_MAPBOX_ACCESS_TOKEN ?? '').trim();
          if (!mapboxToken) throw new Error('Missing VITE_MAPBOX_ACCESS_TOKEN');

          const mapboxUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${pickupLng},${pickupLat};${dropoffLng},${dropoffLat}?access_token=${encodeURIComponent(mapboxToken)}&geometries=geojson`;
          const mapboxResponse = await fetch(mapboxUrl);
          
          if (mapboxResponse.ok) {
            const mapboxData = await mapboxResponse.json();
            const route = mapboxData?.routes?.[0];
            if (route) {
              const distanceKm = Math.round(route.distance / 1000);
              const durationMin = Math.round(route.duration / 60);
              const polyline = route?.geometry?.coordinates ? encodePolyline(route.geometry.coordinates) : undefined;

              const costPerKm = getDistanceRatePerKm();
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

      // Simple cost calculation: per km with minimum $150
      const costPerKm = getDistanceRatePerKm();
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
    if (!pickupAddress) {
      setDealershipCoords(null);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const result = await geocodeAddress(pickupAddress);
        if (!result) {
          setDealershipCoords(null);
          return;
        }
        setDealershipCoords(result);
      } catch {
        setDealershipCoords(null);
      }
    }, 500);

    return () => window.clearTimeout(timer);
  }, [formData?.pickup_location?.address]);

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
        localStorage.setItem(STORAGE_FORM, JSON.stringify(minimizeFormDataForStorage(formData)));
      } else {
        localStorage.removeItem(STORAGE_FORM);
      }

      if (submitMessage === null) {
        localStorage.removeItem(STORAGE_MESSAGE);
      } else {
        localStorage.setItem(STORAGE_MESSAGE, submitMessage);
      }

      localStorage.setItem(`${userKey}_${STORAGE_ERROR}`, submitError ? 'true' : 'false');
    } catch {
      // ignore
    }
  }, [formData, persistState, submitError, submitMessage, userKey]);

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

  const fileToJpegBase64 = (file: File): Promise<{ base64: string; name: string; type: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }

        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const srcW = Math.max(1, img.naturalWidth || img.width || 1);
          const srcH = Math.max(1, img.naturalHeight || img.height || 1);
          const longSide = Math.max(srcW, srcH);
          const targetLongSide = Math.min(2600, Math.max(1600, longSide));
          const scale = longSide > 0 ? targetLongSide / longSide : 1;
          canvas.width = Math.max(1, Math.round(srcW * scale));
          canvas.height = Math.max(1, Math.round(srcH * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Image conversion failed'));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.filter = 'grayscale(1) contrast(1.25) brightness(1.05)';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          ctx.filter = 'none';
          const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
          const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          const baseName = String(file.name ?? 'upload').replace(/\.[^./\\]+$/, '');
          resolve({ base64, name: `${baseName}.jpg`, type: 'image/jpeg' });
        };
        img.onerror = () => reject(new Error('Image conversion failed'));
        img.src = result;
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  const prepareFileForExtraction = async (f: UploadedFile): Promise<{ name: string; type: string; size: number; base64: string; docType: UploadedFile['docType'] }> => {
    const normalizedType = normalizeMimeType(f.name, f.type);
    const isImage = /^image\//i.test(normalizedType) || /^image\//i.test(String(f.file?.type ?? ''));
    if (isImage) {
      const jpeg = await fileToJpegBase64(f.file);
      return { name: jpeg.name, type: jpeg.type, size: f.file.size, base64: jpeg.base64, docType: f.docType };
    }
    return {
      name: f.name,
      type: normalizedType,
      size: f.file.size,
      base64: await fileToBase64(f.file),
      docType: f.docType,
    };
  };

  const initFormData = (output: unknown): FormData | null => {
    if (!output || !isRecord(output)) return null;

    const outputObj = output as Record<string, unknown>;
    const rawExtractedText = pickFirstString(
      getLooseValue(outputObj, 'text', 'raw_text', 'rawtext', 'document_text', 'documenttext', 'ocr_text', 'ocrtext'),
      (outputObj as Record<string, unknown>).extracted_text,
      (outputObj as Record<string, unknown>).extractedText
    );
    const rawExtractedTextAll = rawExtractedText || collectTextFromUnknown(outputObj);

    const vinFromTextEarly = extractVinFromText(rawExtractedTextAll);

    const buyerHeadingStrict = /(?:^|\n)\s*Buyer\s*(?:\n|$)/i;
    const vehicleHeadingStrict = /(?:^|\n)\s*Vehicle\s*(?:\n|$)/i;
    const pickupHeadingStrict = /(?:^|\n)\s*Pickup\s+location\s*(?:\n|$)/i;

    const buyerBlockFromText =
      extractBetweenHeadingsFromText(rawExtractedTextAll, buyerHeadingStrict, [vehicleHeadingStrict, pickupHeadingStrict], 520) ||
      extractBetweenHeadingsFromText(rawExtractedTextAll, /\bBuyer\b/i, [/\bVehicle\b/i, /\bPickup\s+location\b/i], 420);
    const buyerNameFromText = (() => {
      const lines = buyerBlockFromText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((l) => String(l ?? '').trim())
        .filter(Boolean);
      const startIdx = lines.findIndex((l) => /^Buyer\b/i.test(l));
      const after = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;
      const candidate = after.find((l) => !/^\s*(?:Buyer|Vehicle|Pickup\s+location)\b/i.test(l));
      return String(candidate ?? '').trim();
    })();
    const buyerPhoneFromText = extractFirstPhoneFromText(buyerBlockFromText);

    const vehicleBlockFromText =
      extractBetweenHeadingsFromText(rawExtractedTextAll, vehicleHeadingStrict, [pickupHeadingStrict, buyerHeadingStrict], 520) ||
      extractBetweenHeadingsFromText(rawExtractedTextAll, /\bVehicle\b/i, [/\bPickup\s+location\b/i, /\bBuyer\b/i], 420);
    const vehicleYmmFromText = (() => {
      const normalizeYearToken = (token: string): string => {
        const repaired = String(token ?? '')
          .replace(/[Il]/g, '1')
          .replace(/[Oo]/g, '0');
        const match = repaired.match(/\b(19\d{2}|20\d{2})\b/);
        return match?.[1] ?? '';
      };

      const parseYmmFromLine = (line: string): { year: string; make: string; model: string } => {
        const s = String(line ?? '').trim();
        if (!s) return { year: '', make: '', model: '' };
        const m = s.match(/\b((?:19|20)[0-9IlOo]{2})\b\s+([A-Za-z][A-Za-z0-9&.'\/-]{1,})\s+([^\r\n]{2,60})/);
        const y = normalizeYearToken(m?.[1] ?? '');
        if (!y) return { year: '', make: '', model: '' };
        return { year: y, make: String(m?.[2] ?? '').trim(), model: String(m?.[3] ?? '').trim() };
      };

      const lines = vehicleBlockFromText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((l) => String(l ?? '').trim())
        .filter(Boolean);
      const yearLine = lines.find((l) => /\b(?:19|20)[0-9IlOo]{2}\b/.test(l) && /[A-Za-z]/.test(l)) ?? '';
      return parseYmmFromLine(yearLine);
    })();

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

    const vehicleVin =
      pickFirstString(
        vehicleObj?.vin,
        getLooseValue(vehicleObj, 'vin', 'vehicle_vin', 'vehiclevin', 'vin_number', 'vinnumber'),
        getLooseValue(outputObj, 'vin', 'vehicle_vin', 'vehiclevin', 'vin_number', 'vinnumber')
      ) || vinFromTextEarly;

    const vehicleYmmNearVinFromText = extractVehicleYmmNearVinFromText(rawExtractedTextAll, String(vehicleVin ?? '').trim() || vinFromTextEarly);
    const vehicleYear =
      normalizeVehicleYear(
        pickFirstString(
          vehicleObj?.year,
          getLooseValue(vehicleObj, 'year', 'vehicle_year', 'vehicleyear'),
          getLooseValue(outputObj, 'year', 'vehicle_year', 'vehicleyear')
        )
      ) || extractVehicleYearFromText(rawExtractedText) || vehicleYmmFromText.year || vehicleYmmNearVinFromText.year;
    const vehicleMake = pickFirstString(
      vehicleObj?.make,
      getLooseValue(outputObj, 'make', 'vehicle_make')
    ) || extractLabeledValueFromText(rawExtractedTextAll, 'Make') || vehicleYmmFromText.make || vehicleYmmNearVinFromText.make;
    const vehicleModel = pickFirstString(
      vehicleObj?.model,
      getLooseValue(outputObj, 'model', 'vehicle_model')
    ) || extractLabeledValueFromText(rawExtractedTextAll, 'Model') || vehicleYmmFromText.model || vehicleYmmNearVinFromText.model;
    const vehicleTransmission = pickFirstString(
      vehicleObj?.transmission,
      getLooseValue(outputObj, 'transmission', 'vehicle_transmission')
    ) ||
    extractLabeledValueFromText(rawExtractedTextAll, 'Transmission') ||
    extractLabeledValueFromText(rawExtractedTextAll, 'Transmlsslon') ||
    extractLabeledValueFromText(rawExtractedTextAll, 'Transm');
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
    ) || extractLabeledValueFromText(rawExtractedTextAll, 'Color');

    const sellingBlockFromText = extractSectionBlockFromText(rawExtractedTextAll, /\bS[EL]LL[IL]NG\s+DEALERSH[IL]P\b/i);
    const sellingNameFromText = (() => {
      const lines = sellingBlockFromText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((l) => String(l ?? '').trim())
        .filter(Boolean);
      const startIdx = lines.findIndex((l) => /S[EL]LL[IL]NG\s+DEALERSH[IL]P/i.test(l));
      return startIdx >= 0 ? String(lines[startIdx + 1] ?? '').trim() : '';
    })();
    const sellingPhoneFromText = extractFirstPhoneFromText(sellingBlockFromText);
    const sellingAddressFromText = stripContactFromAddressBlock(sellingBlockFromText, sellingNameFromText, [
      /\bS[EL]LL[IL]NG\s+DEALERSH[IL]P\b\s*:?\s*/i,
      /\bSell\w*\s+Dealersh\w*\b\s*:?\s*/i,
    ]);

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
    ) || sellingNameFromText;
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
    ) || sellingPhoneFromText;
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

    const sellingAddressFinal = (() => {
      const candidate = String(sellingAddress ?? '').trim();
      if (looksLikeCleanStreetAddress(candidate)) return candidate;
      const cleaned = String(sellingAddressFromText ?? '').trim();
      const parsed = parseAddressToBreakdown(cleaned);
      const rebuilt = buildAddressFromBreakdown({
        street: String(parsed.street ?? '').trim(),
        number: String(parsed.number ?? '').trim(),
        unit: String(parsed.unit ?? '').trim(),
        area: String(parsed.area ?? '').trim(),
        city: String(parsed.city ?? '').trim(),
        province: normalizeWhitespace(String(parsed.province ?? '').trim()),
        postal_code: normalizePostalCode(String(parsed.postal_code ?? '').trim()),
        country: normalizeCountry(String(parsed.country ?? 'Canada')),
      });
      return looksLikeStreetAddress(rebuilt) ? rebuilt : '';
    })();

    const buyingBlockFromText = extractSectionBlockFromText(rawExtractedTextAll, /\b(?:BUYING|8UYLNG|BUYLNG)\s+DEALERSH[IL]P\b/i);
    const buyingNameFromText = (() => {
      const lines = buyingBlockFromText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((l) => String(l ?? '').trim())
        .filter(Boolean);
      const startIdx = lines.findIndex((l) => /(?:BUYING|8UYLNG|BUYLNG)\s+DEALERSH/i.test(l));
      return startIdx >= 0 ? String(lines[startIdx + 1] ?? '').trim() : '';
    })();
    const buyingPhoneFromText = extractFirstPhoneFromText(buyingBlockFromText);

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
    ) || buyingNameFromText || buyerNameFromText;
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
    ) || buyingPhoneFromText || buyerPhoneFromText;
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

    const pickupBlockFromText = extractSectionBlockFromText(rawExtractedTextAll, /\bP[IL]CKUP\s+LOCAT[IL]ON\b/i);
    const pickupNameFromText = (() => {
      if (!pickupBlockFromText) return '';
      const lines = pickupBlockFromText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((l) => String(l ?? '').trim())
        .filter(Boolean);
      const startIdx = lines.findIndex((l) => /P[IL]CKUP\s+LOCAT[IL]ON/i.test(l));
      const candidate = startIdx >= 0 ? (lines[startIdx + 1] ?? '') : '';
      return String(candidate ?? '').trim();
    })();
    const pickupAddressOnlyFromText = stripContactFromAddressBlock(pickupBlockFromText, pickupNameFromText);
    const pickupName =
      pickFirstString(pickupObj?.name, getLooseValue(outputObj, 'pickup_location_name', 'pickuplocationname', 'pickup_name', 'pickupname')) ||
      pickupNameFromText;
    const pickupAddress =
      pickFirstString(pickupObj?.address, getLooseValue(outputObj, 'pickup_location_address', 'pickuplocationaddress', 'pickup_address', 'pickupaddress')) ||
      pickupAddressOnlyFromText;
    const pickupPhone = pickFirstString(
      pickupObj?.phone,
      getLooseValue(outputObj, 'pickup_location_phone', 'pickuplocationphone', 'pickup_phone', 'pickupphone'),
      sellingPhone,
      extractFirstPhoneFromText(pickupBlockFromText)
    );

    const transactionId =
      pickFirstString(
        transactionObj?.transaction_id,
        getLooseValue(outputObj, 'transaction_id', 'transactionid', 'transaction', 'transaction_number', 'transactionnumber')
      ) || extractTransactionIdFromText(rawExtractedText);
    const releaseFormNumber =
      pickFirstString(
        transactionObj?.release_form_number,
        getLooseValue(outputObj, 'release_form_number', 'releaseformnumber', 'release_form', 'releaseform', 'release_form_no', 'releaseformno')
      ) || extractReleaseFormNumberFromText(rawExtractedText);
    const releaseDate = pickFirstString(transactionObj?.release_date, getLooseValue(outputObj, 'release_date', 'releasedate'));
    const arrivalDate =
      pickFirstString(transactionObj?.arrival_date, getLooseValue(outputObj, 'arrival_date', 'arrivaldate')) ||
      extractArrivalDateFromText(rawExtractedText);

    const releasedByName = pickFirstString(authObj?.released_by_name, getLooseValue(outputObj, 'released_by_name', 'releasedbyname', 'releasedby'));
    const releasedToName = pickFirstString(authObj?.released_to_name, getLooseValue(outputObj, 'released_to_name', 'releasedtoname', 'releasedto'));

    const pickupAddressForParsing = pickBestAddressCandidate(
      pickupObj?.full_address,
      pickupObj?.fullAddress,
      pickupAddress,
      sellingAddressFinal,
      sellingAddress,
      pickupAddressOnlyFromText
    );
    const parsedPickupInitial = parseAddressToBreakdown(pickupAddressForParsing);
    const parsedPickup = (() => {
      const hasStreet = !!String(parsedPickupInitial.street ?? '').trim();
      const hasNumber = !!String(parsedPickupInitial.number ?? '').trim();
      const hasCity = !!String(parsedPickupInitial.city ?? '').trim();
      const hasPostal = !!String(parsedPickupInitial.postal_code ?? '').trim();
      const looksIncomplete = !(hasStreet && hasNumber && (hasCity || hasPostal));
      if (!looksIncomplete) return parsedPickupInitial;

      const parsedSelling = parseAddressToBreakdown(String(sellingAddressFinal ?? '').trim());
      const hasSellingStreet = !!String(parsedSelling.street ?? '').trim();
      const hasSellingNumber = !!String(parsedSelling.number ?? '').trim();
      const hasSellingCity = !!String(parsedSelling.city ?? '').trim();
      if (!(hasSellingStreet && hasSellingNumber && hasSellingCity)) return parsedPickupInitial;

      return parsedSelling;
    })();
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
      parsedPickup.street,
      pickupObj?.street,
      pickupObj?.street_name,
      getLooseValue(outputObj, 'pickup_street', 'pickupStreet')
    );
    const pickupStreetFinal = pickupStreet;
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
    const pickupUnitFinal = normalizeWhitespace(String((parsedPickup as unknown as Record<string, unknown>)?.unit ?? ''));
    const pickupAddressFinal = (() => {
      const rebuilt = buildAddressFromBreakdown({
        street: pickupStreetFinal,
        number: pickupNumber,
        unit: pickupUnitFinal,
        area: '',
        city: pickupCityFinal || 'Ottawa',
        province: pickupProvinceFinal || (pickupCityFinal ? pickupProvinceFinal : 'ON'),
        postal_code: pickupPostalFinal,
        country: pickupCountryFinal || 'Canada',
      });
      if (looksLikeStreetAddress(rebuilt)) return rebuilt;
      return looksLikeCleanStreetAddress(pickupAddressCandidate) ? pickupAddressCandidate : '';
    })();

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
    const dropoffUnitFinal = normalizeWhitespace(String((parsedDropoff as unknown as Record<string, unknown>)?.unit ?? ''));
    const dropoffAddressCandidate = String(dropoffAddress ?? '').trim();
    const dropoffAddressFinal =
      (looksLikeStreetAddress(dropoffAddressCandidate) ? dropoffAddressCandidate : '') ||
      buildAddressFromBreakdown({
        street: dropoffStreetFinal,
        number: dropoffNumber,
        unit: dropoffUnitFinal,
        area: '',
        city: dropoffCityFinal || 'Ottawa',
        province: dropoffProvinceFinal || (dropoffCityFinal ? dropoffProvinceFinal : 'ON'),
        postal_code: dropoffPostalFinal,
        country: dropoffCountryFinal || 'Canada',
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
        address: sellingAddressFinal || String(sellingAddress ?? ''),
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
        unit: pickupUnitFinal,
        area: '',
        city: pickupCityFinal || 'Ottawa',
        province: pickupProvinceFinal || (pickupCityFinal ? pickupProvinceFinal : 'ON'),
        postal_code: pickupPostalFinal,
        country: pickupCountryFinal || 'Canada',
        phone: String(pickupPhone ?? ''),
        contact_name: '',
        email: '',
      },
      dropoff_location: {
        name: dropoffName,
        phone: dropoffPhone,
        address: dropoffAddressFinal,
        street: dropoffStreetFinal,
        number: dropoffNumber,
        unit: dropoffUnitFinal,
        area: '',
        city: dropoffCityFinal || 'Ottawa',
        province: dropoffProvinceFinal || (dropoffCityFinal ? dropoffProvinceFinal : 'ON'),
        postal_code: dropoffPostalFinal,
        country: dropoffCountryFinal || 'Canada',
        lat: dropoffLat,
        lng: dropoffLng,
        contact_name: '',
        email: '',
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

  const createBlankFormData = (): FormData => {
    return {
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
      selling_dealership: {
        name: '',
        phone: '',
        address: '',
      },
      buying_dealership: {
        name: '',
        phone: '',
        contact_name: '',
      },
      pickup_location: {
        name: '',
        contact_name: '',
        email: '',
        address: '',
        phone: '',
        ...defaultAddressBreakdown(),
      },
      dropoff_location: {
        name: '',
        contact_name: '',
        email: '',
        phone: '',
        address: '',
        lat: '',
        lng: '',
        ...defaultAddressBreakdown(),
      },
      transaction: {
        transaction_id: '',
        release_form_number: '',
        release_date: '',
        arrival_date: '',
      },
      authorization: {
        released_by_name: '',
        released_to_name: '',
      },
      dealer_notes: '',
      vehicle_condition: 'runs_and_drives',
      pickup_locked: false,
    };
  };

  const closeManualForm = () => {
    setIsManualFormOpen(false);
    setFormData(null);
  };

  const startManualWizard = () => {
    setManualWizardStep('locations');
    setManualWizardError(null);
    setManualVinDecodeLoading(false);
    setShowCostEstimate(false);
    setPickupSearch('');
    setPickupSuggestions([]);
    setPickupSuggestLoading(false);
    setDropoffSearch('');
    setDropoffSuggestions([]);
    setDropoffSuggestLoading(false);
  };

  const hideManualFormKeepState = () => {
    setIsManualFormOpen(false);
    setManualWizardError(null);
  };

  const persistManualResumeState = (payload: unknown) => {
    try {
      sessionStorage.setItem(STORAGE_MANUAL_RESUME, JSON.stringify(payload));
      return;
    } catch {
      // ignore
    }
    try {
      localStorage.setItem(STORAGE_MANUAL_RESUME, JSON.stringify(payload));
    } catch {
      // ignore
    }
  };

  const readManualResumeState = (): { step: ManualWizardStep; formData: FormData | null; costData: CostData | null; pickupSearch: string; dropoffSearch: string } | null => {
    const read = (): string | null => {
      try {
        return sessionStorage.getItem(STORAGE_MANUAL_RESUME);
      } catch {
        // ignore
      }
      try {
        return localStorage.getItem(STORAGE_MANUAL_RESUME);
      } catch {
        return null;
      }
    };

    const raw = read();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return null;
      const stepRaw = readString(parsed.step);
      const step: ManualWizardStep = stepRaw === 'locations' || stepRaw === 'vehicle' || stepRaw === 'quote' ? (stepRaw as ManualWizardStep) : 'locations';

      const nextFormDataRaw = (parsed as Record<string, unknown>).formData;
      const nextFormData = isRecord(nextFormDataRaw) ? (nextFormDataRaw as FormData) : null;

      const nextCostRaw = (parsed as Record<string, unknown>).costData;
      const nextCost = isRecord(nextCostRaw) ? (nextCostRaw as CostData) : null;

      const nextPickupSearch = readString((parsed as Record<string, unknown>).pickupSearch);
      const nextDropoffSearch = readString((parsed as Record<string, unknown>).dropoffSearch);

      return {
        step,
        formData: nextFormData,
        costData: nextCost,
        pickupSearch: nextPickupSearch,
        dropoffSearch: nextDropoffSearch,
      };
    } catch {
      return null;
    }
  };

  const clearManualResumeState = () => {
    try {
      sessionStorage.removeItem(STORAGE_MANUAL_RESUME);
    } catch {
      // ignore
    }
    try {
      localStorage.removeItem(STORAGE_MANUAL_RESUME);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const reset = () => {
      clearPersisted();
      clearManualResumeState();
      setIsManualFormOpen(false);
      setManualWizardError(null);
      setManualVinDecodeLoading(false);
      setShowCostEstimate(false);
      setShowCheckout(false);
      setPickupSearch('');
      setPickupSuggestions([]);
      setPickupSuggestLoading(false);
      setDropoffSearch('');
      setDropoffSuggestions([]);
      setDropoffSuggestLoading(false);
      setResumeManualWizardAfterLogin(null);
      setFormData(null);
      setCostData(null);
      setDraftDocCount(null);
      setActiveDraftId(null);
      setUploadedFiles([]);
      setSubmitMessage(null);
      setSubmitError(false);
      setPaymentSuccessReceiptId(null);
      setShowPaymentSuccess(false);
      setDealershipCoords(null);
      try {
        if (fileInputRef.current) fileInputRef.current.value = '';
      } catch {
        // ignore
      }
    };

    window.addEventListener('ed_reset_upload', reset);
    return () => {
      window.removeEventListener('ed_reset_upload', reset);
    };
  }, [clearManualResumeState]);

  useEffect(() => {
    if (!resumeManualWizardAfterLogin) return;
    if (!isLoggedIn) return;
    setIsManualFormOpen(true);
    setManualWizardStep(resumeManualWizardAfterLogin);
    setResumeManualWizardAfterLogin(null);
  }, [isLoggedIn, resumeManualWizardAfterLogin]);

  useEffect(() => {
    if (!isLoggedIn) return;
    const restored = readManualResumeState();
    if (!restored) return;

    setFormData(restored.formData);
    setCostData(restored.costData);
    setPickupSearch(restored.pickupSearch || String(restored.formData?.pickup_location?.address ?? ''));
    setDropoffSearch(restored.dropoffSearch || String(restored.formData?.dropoff_location?.address ?? ''));
    setManualWizardStep(restored.step);
    setIsManualFormOpen(true);
    clearManualResumeState();
  }, [clearManualResumeState, isLoggedIn, readManualResumeState]);

  const computeManualQuote = async () => {
    if (!formData) return false;

    const pickupAddress = String(formData?.pickup_location?.address ?? '').trim();
    const dropoffAddress = String(formData?.dropoff_location?.address ?? '').trim();

    if (!pickupAddress || pickupAddress.length < 5) {
      setManualWizardError('Please enter a valid Pickup address in Canada.');
      return false;
    }

    if (!dropoffAddress || dropoffAddress.length < 5) {
      setManualWizardError('Please enter a valid Drop-off address in Canada.');
      return false;
    }

    const pickupResolved =
      dealershipCoords ?? (pickupAddress ? await geocodeAddress(pickupAddress).catch(() => null) : null);
    if (pickupResolved && !dealershipCoords) {
      setDealershipCoords(pickupResolved);
    }

    const dropoffLatRaw = String(formData?.dropoff_location?.lat ?? '').trim();
    const dropoffLngRaw = String(formData?.dropoff_location?.lng ?? '').trim();
    const dropoffLat = Number(dropoffLatRaw);
    const dropoffLng = Number(dropoffLngRaw);
    const hasDropoffCoords =
      dropoffLatRaw !== '' &&
      dropoffLngRaw !== '' &&
      Number.isFinite(dropoffLat) &&
      Number.isFinite(dropoffLng) &&
      dropoffLat >= -90 &&
      dropoffLat <= 90 &&
      dropoffLng >= -180 &&
      dropoffLng <= 180 &&
      !(dropoffLat === 0 && dropoffLng === 0);

    const dropoffResolved = hasDropoffCoords ? { lat: dropoffLat, lng: dropoffLng } : dropoffAddress ? await geocodeAddress(dropoffAddress).catch(() => null) : null;
    if (dropoffResolved && !hasDropoffCoords) {
      updateFormField('dropoff_location', 'lat', String(dropoffResolved.lat));
      updateFormField('dropoff_location', 'lng', String(dropoffResolved.lng));
    }

    if (!pickupResolved || !dropoffResolved) {
      setManualWizardError('Unable to locate both addresses on the map. Please verify the addresses and try again.');
      return false;
    }

    const estimate = await calculateCostAndDistance(pickupResolved.lat, pickupResolved.lng, dropoffResolved.lat, dropoffResolved.lng);
    if (!estimate) {
      setManualWizardError('Unable to calculate distance. Please try again.');
      return false;
    }

    const nextCost = { ...estimate, pricingStatus: 'estimated' as const };
    setCostData(nextCost);
    setManualWizardError(null);
    try {
      emitQuoteReady({
        formData,
        costData: minimizeCostDataForStorage(nextCost),
        docCount: 0,
        source: 'manual',
      });
    } catch {
      // ignore
    }
    return true;
  };

  const fetchAddressSuggestions = async (query: string): Promise<AddressSuggestion[]> => {
    const q = String(query ?? '').trim();
    if (!q || q.length < 3) return [];
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?f=pjson&maxSuggestions=6&countryCode=CAN&category=Address,POI&text=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as unknown;
    const suggestions = isRecord(data) ? (data as Record<string, unknown>).suggestions : null;
    if (!Array.isArray(suggestions)) return [];

    const rawList = suggestions
      .map((s) => {
        const obj = s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
        if (!obj) return null;
        const text = String(obj.text ?? '').trim();
        const magicKey = String(obj.magicKey ?? '').trim();
        if (!text) return null;
        return magicKey ? ({ text, magicKey } as AddressSuggestion) : ({ text } as AddressSuggestion);
      })
      .filter((s): s is AddressSuggestion => s !== null);

    const validateSuggestion = async (s: AddressSuggestion): Promise<boolean> => {
      if (!s.magicKey) return looksLikeOntarioOrQuebecSuggestion(s.text);
      try {
        const validateUrl = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=pjson&maxLocations=1&outFields=Region,Country,CountryCode&sourceCountry=CAN&magicKey=${encodeURIComponent(s.magicKey)}&text=${encodeURIComponent(s.text)}`;
        const validateRes = await fetch(validateUrl);
        if (!validateRes.ok) return false;
        const json = (await validateRes.json().catch(() => null)) as unknown;
        const candidates = isRecord(json) ? (json as Record<string, unknown>).candidates : null;
        const first = Array.isArray(candidates) && candidates.length ? (candidates[0] as unknown) : null;
        const attrs = isRecord(first) ? ((first as Record<string, unknown>).attributes as unknown) : null;
        const region = isRecord(attrs) ? (attrs as Record<string, unknown>).Region : null;
        return isOntarioOrQuebec(region);
      } catch {
        return false;
      }
    };

    const keep = await Promise.all(rawList.map(async (s) => ({ s, ok: await validateSuggestion(s) })));
    return keep
      .filter((r) => r.ok)
      .map((r) => r.s);
  };

  useEffect(() => {
    if (!isManualFormOpen) return;
    const q = pickupSearch.trim();
    let cancelled = false;
    setPickupSuggestLoading(true);
    const t = window.setTimeout(async () => {
      const list = await fetchAddressSuggestions(q).catch(() => []);
      if (cancelled) return;
      setPickupSuggestions(list);
      setPickupSuggestLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      setPickupSuggestLoading(false);
    };
  }, [pickupSearch, isManualFormOpen]);

  useEffect(() => {
    if (!isManualFormOpen) return;
    const q = dropoffSearch.trim();
    let cancelled = false;
    setDropoffSuggestLoading(true);
    const t = window.setTimeout(async () => {
      const list = await fetchAddressSuggestions(q).catch(() => []);
      if (cancelled) return;
      setDropoffSuggestions(list);
      setDropoffSuggestLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      setDropoffSuggestLoading(false);
    };
  }, [dropoffSearch, isManualFormOpen]);

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
              <label className="block text-sm text-gray-600 mb-1">Service</label>
              <input
                value="Vehicle transport"
                readOnly
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-800"
              />
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Street Address</label>
                <input
                  name="pickup_address_line1"
                  autoComplete="shipping address-line1"
                  value={pickupStreetLine1Input}
                  onChange={(e) => {
                    const next = e.target.value;
                    pickupStreetLine1EditingRef.current = true;
                    setPickupStreetLine1Input(next);
                    setPickupStreetSelected(false);
                    setPickupNumberError(null);
                    const split = splitLine1ToNumberStreet(next);
                    setPickupAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                  }}
                  onFocus={() => {
                    pickupStreetLine1EditingRef.current = true;
                  }}
                  onBlur={() => {
                    pickupStreetLine1EditingRef.current = false;
                    const normalized = normalizeWhitespace(pickupStreetLine1Input);
                    setPickupStreetLine1Input(normalized);
                    const split = splitLine1ToNumberStreet(normalized);
                    setPickupAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="8670 10e Avenue"
                />
                {pickupNumberError ? <div className="mt-2 text-xs font-medium text-red-600">{pickupNumberError}</div> : null}
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Suite/Apt</label>
                <input
                  name="pickup_address_line2"
                  autoComplete="shipping address-line2"
                  value={String(formData.pickup_location.unit ?? '')}
                  onChange={(e) => {
                    setPickupAddressFromBreakdown({ unit: e.target.value, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Leave blank if none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">City</label>
                <input
                  name="pickup_city"
                  autoComplete="shipping address-level2"
                  value={String(formData.pickup_location.city ?? '')}
                  onChange={(e) => {
                    setPickupAddressFromBreakdown({ city: e.target.value, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Montreal"
                />
                <div className="mt-1 text-xs text-gray-500">e.g. Montreal</div>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Province</label>
                <select
                  name="pickup_province"
                  autoComplete="shipping address-level1"
                  value={String(formData.pickup_location.province ?? '')}
                  onChange={(e) => {
                    setPickupAddressFromBreakdown({ province: e.target.value, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                >
                  <option value="">Select</option>
                  {CANADA_PROVINCE_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {CANADA_PROVINCE_FULL_NAME[p] ?? p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Postal Code</label>
                <input
                  name="pickup_postal_code"
                  autoComplete="shipping postal-code"
                  value={String(formData.pickup_location.postal_code ?? '')}
                  onChange={(e) => setPickupAddressFromBreakdown({ postal_code: e.target.value, area: '' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="K2J 0B6"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Country</label>
                <input
                  name="pickup_country"
                  autoComplete="shipping country-name"
                  value="Canada"
                  readOnly
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-800"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h5 className="text-sm font-semibold text-gray-700 mb-3">Drop-off Location</h5>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-sm font-semibold text-gray-700 mb-3">Address Breakdown</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Street Address</label>
                <input
                  name="dropoff_address_line1"
                  autoComplete="billing address-line1"
                  value={dropoffStreetLine1Input}
                  onChange={(e) => {
                    const next = e.target.value;
                    dropoffStreetLine1EditingRef.current = true;
                    setDropoffStreetLine1Input(next);
                    setDropoffStreetSelected(false);
                    setDropoffNumberError(null);
                    const split = splitLine1ToNumberStreet(next);
                    setDropoffAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                  }}
                  onFocus={() => {
                    dropoffStreetLine1EditingRef.current = true;
                  }}
                  onBlur={() => {
                    dropoffStreetLine1EditingRef.current = false;
                    const normalized = normalizeWhitespace(dropoffStreetLine1Input);
                    setDropoffStreetLine1Input(normalized);
                    const split = splitLine1ToNumberStreet(normalized);
                    setDropoffAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="8670 10e Avenue"
                />
                {dropoffNumberError ? <div className="mt-2 text-xs font-medium text-red-600">{dropoffNumberError}</div> : null}
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Suite/Apt</label>
                <input
                  name="dropoff_address_line2"
                  autoComplete="billing address-line2"
                  value={String(formData.dropoff_location.unit ?? '')}
                  onChange={(e) => {
                    setDropoffAddressFromBreakdown({ unit: e.target.value, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Leave blank if none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">City</label>
                <input
                  name="dropoff_city"
                  autoComplete="billing address-level2"
                  value={String(formData.dropoff_location.city ?? '')}
                  onChange={(e) => {
                    setDropoffAddressFromBreakdown({ city: e.target.value, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="Montreal"
                />
                <div className="mt-1 text-xs text-gray-500">e.g. Montreal</div>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Province</label>
                <select
                  name="dropoff_province"
                  autoComplete="billing address-level1"
                  value={String(formData.dropoff_location.province ?? '')}
                  onChange={(e) => {
                    setDropoffAddressFromBreakdown({ province: e.target.value, area: '' });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                >
                  <option value="">Select</option>
                  {CANADA_PROVINCE_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {CANADA_PROVINCE_FULL_NAME[p] ?? p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Postal Code</label>
                <input
                  name="dropoff_postal_code"
                  autoComplete="billing postal-code"
                  value={String(formData.dropoff_location.postal_code ?? '')}
                  onChange={(e) => setDropoffAddressFromBreakdown({ postal_code: e.target.value, area: '' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="K2J 0B6"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Country</label>
                <input
                  name="dropoff_country"
                  autoComplete="billing country-name"
                  value="Canada"
                  readOnly
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-800"
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

  const handlePickupAddressChange = (value: string) => {
    const parsed = parseAddressToBreakdown(value);
    setFormData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        pickup_location: {
          ...prev.pickup_location,
          address: value,
          ...parsed,
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
        unit: String(next.unit ?? (current as unknown as AddressBreakdown).unit ?? ''),
        area: String(next.area ?? (current as unknown as AddressBreakdown).area ?? ''),
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
        unit: String(next.unit ?? (current as unknown as AddressBreakdown).unit ?? ''),
        area: String(next.area ?? (current as unknown as AddressBreakdown).area ?? ''),
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

    const maxBytes = 10 * 1024 * 1024;

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
      type: normalizeMimeType(file.name, file.type),
      file,
      docType: 'release_form',
    }));

    clearPersisted();
    setSubmitMessage(null);
    setSubmitError(false);
    setFormData(null);
    setDraftDocCount(null);
    setActiveDraftId(null);
    autoExtractTriggeredRef.current = false;
    setUploadedFiles((prev) => [...mapped, ...prev]);
  };

  const removeFile = (id: string) => {
    autoExtractTriggeredRef.current = false;
    setUploadedFiles((prev) => prev.filter((file) => file.id !== id));
  };

  const onButtonClick = () => {
    fileInputRef.current?.click();
  };

  const closeDropoffValidationModal = () => {
    setIsDropoffValidationOpen(false);
  };

  const handleSubmitDocuments = async () => {
    if (isSubmitting) return;

    if (formData) {
      if (isManualFormOpen) setIsManualFormOpen(false);
      const pickupStreet = String(formData.pickup_location.street ?? '').trim();
      const pickupNumber = String(formData.pickup_location.number ?? '').trim();
      const pickupCity = String(formData.pickup_location.city ?? '').trim();
      const pickupProvince = String(formData.pickup_location.province ?? '').trim();
      const pickupPostal = String(formData.pickup_location.postal_code ?? '').trim();
      const pickupCountry = String(formData.pickup_location.country ?? '').trim();

      const dropoffStreet = String(formData.dropoff_location.street ?? '').trim();
      const dropoffNumber = String(formData.dropoff_location.number ?? '').trim();
      const dropoffCity = String(formData.dropoff_location.city ?? '').trim();
      const dropoffProvince = String(formData.dropoff_location.province ?? '').trim();
      const dropoffPostal = String(formData.dropoff_location.postal_code ?? '').trim();
      const dropoffCountry = String(formData.dropoff_location.country ?? '').trim();

      const missingFields: string[] = [];
      if (!pickupNumber) missingFields.push('Pickup Street Address');
      if (!pickupStreet) missingFields.push('Pickup Street Address');
      if (!pickupCity) missingFields.push('Pickup City');
      if (!pickupProvince) missingFields.push('Pickup Province');
      if (!pickupPostal) missingFields.push('Pickup Postal Code');
      if (!pickupCountry) missingFields.push('Pickup Country');

      if (!dropoffNumber) missingFields.push('Drop-off Street Address');
      if (!dropoffStreet) missingFields.push('Drop-off Street Address');
      if (!dropoffCity) missingFields.push('Drop-off City');
      if (!dropoffProvince) missingFields.push('Province');
      if (!dropoffPostal) missingFields.push('Postal Code');
      if (!dropoffCountry) missingFields.push('Country');

      if (
        pickupPostal &&
        (!isValidCanadianPostalCode(pickupPostal) || !postalPrefixAllowsProvince(pickupPostal, pickupProvince))
      ) {
        missingFields.push('Valid Pickup Postal Code');
      }

      if (dropoffPostal && (!isValidCanadianPostalCode(dropoffPostal) || !postalPrefixAllowsProvince(dropoffPostal, dropoffProvince))) {
        missingFields.push('Valid Postal Code');
      }

      const isPickupBreakdownComplete =
        !!pickupStreet &&
        !!pickupNumber &&
        !!pickupCity &&
        !!pickupProvince &&
        !!pickupPostal &&
        !!pickupCountry &&
        isValidCanadianPostalCode(pickupPostal) &&
        postalPrefixAllowsProvince(pickupPostal, pickupProvince);

      const isDropoffBreakdownComplete =
        !!dropoffStreet &&
        !!dropoffNumber &&
        !!dropoffCity &&
        !!dropoffProvince &&
        !!dropoffPostal &&
        !!dropoffCountry &&
        isValidCanadianPostalCode(dropoffPostal) &&
        postalPrefixAllowsProvince(dropoffPostal, dropoffProvince);

      if (!isPickupBreakdownComplete || !isDropoffBreakdownComplete) {
        if (isManualFormOpen) setIsManualFormOpen(false);
        setDropoffValidationMissingFields(missingFields);
        setIsDropoffValidationOpen(true);
        return;
      }

      setShowCostEstimate(false);

      if (!isLoggedIn) {
        try {
          await saveDraftBeforeSignIn({ formData, costData });
        } catch {
          // ignore
        }
      }

      const pickupLat = Number(dealershipCoords?.lat);
      const pickupLng = Number(dealershipCoords?.lng);
      const dropoffLatRaw = String(formData?.dropoff_location?.lat ?? '').trim();
      const dropoffLngRaw = String(formData?.dropoff_location?.lng ?? '').trim();
      const dropoffLat = Number(dropoffLatRaw);
      const dropoffLng = Number(dropoffLngRaw);

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
          const nextCost = { ...estimate, pricingStatus: 'estimated' as const };
          setCostData(nextCost);
          try {
            emitQuoteReady({
              formData,
              costData: minimizeCostDataForStorage(nextCost),
              docCount: uploadedFiles.length,
              source: 'bulk_upload',
            });
          } catch {
            // ignore
          }
          if (!isLoggedIn) {
            try {
              await saveDraftBeforeSignIn({ formData, costData: nextCost });
            } catch {
              // ignore
            }
          }
          if (isManualFormOpen) setIsManualFormOpen(false);
          setShowCostEstimate(true);
          return;
        }
      }

      if (isManualFormOpen) setIsManualFormOpen(false);
      setSubmitMessage('Unable to calculate a quote. Please ensure both Pickup and Drop-off addresses are complete and the map has valid coordinates.');
      setSubmitError(true);
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
          const raw = localStorage.getItem(getDraftStorageKey(STORAGE_DRAFTS));
          const parsed = raw ? (JSON.parse(raw) as unknown) : null;
          const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];
          if (newDrafts.length) {
            localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS), JSON.stringify([...newDrafts, ...existing]));
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
        const pickupAddress = String(extracted?.pickup_location?.address ?? '').trim();
        const pickupName = String(extracted?.pickup_location?.name ?? '').trim();

        const pickupQuery = pickupAddress || pickupName;

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
            return minimizeCostDataForStorage({ ...estimate, pricingStatus: 'estimated' as const });
          }
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
            type: normalizeMimeType(f.name, f.type),
            size: f.file.size,
            base64: await fileToBase64(f.file),
            docType: f.docType,
          };

          const res = await fetch(extractionUrl, {
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
        const raw = localStorage.getItem(getDraftStorageKey(STORAGE_DRAFTS));
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        const existing = Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : [];
        if (newDrafts.length) {
          localStorage.setItem(getDraftStorageKey(STORAGE_DRAFTS), JSON.stringify([...newDrafts, ...existing]));
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
      const filesWithBase64 = await Promise.all(uploadedFiles.map(async (f) => prepareFileForExtraction(f)));
      const files = filesWithBase64.map((f) => ({ name: f.name, type: f.type, size: f.size, base64: f.base64, docType: f.docType }));

      const res = await fetch(extractionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const parsed = (() => {
          try {
            return text ? (JSON.parse(text) as unknown) : null;
          } catch {
            return null;
          }
        })();
        const serverMsg = isRecord(parsed) ? readString((parsed as Record<string, unknown>).message) : '';
        if (serverMsg && /workflow execution failed/i.test(serverMsg)) {
          throw new Error(`Extraction failed (workflow error, ${res.status}). Please try a clearer scan or a JPG.`);
        }
        throw new Error(serverMsg ? `Extraction failed (${res.status}): ${serverMsg}` : text || `Upload failed (${res.status})`);
      }

      const data = await res.json().catch(() => null);
      const output = extractWebhookOutput(data);
      const extracted = initFormData(output);
      if (!extracted) {
        const serverMsg =
          (isRecord(data) ? readString((data as Record<string, unknown>).message) : '') ||
          (isRecord(output) ? readString((output as Record<string, unknown>).message) : '');
        throw new Error(
          serverMsg && /workflow execution failed/i.test(serverMsg)
            ? 'Extraction failed (workflow error). Please try again with a clearer image/PDF, or try converting the image to JPG.'
            : serverMsg
              ? `Extraction failed: ${serverMsg}`
              : 'Extraction failed. The server returned no usable data.'
        );
      }
      const decodedVin = (() => {
        const vin = String(extracted?.vehicle?.vin ?? '').trim();
        return vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin) ? vin.toUpperCase() : '';
      })();
      const needYmm = !String(extracted?.vehicle?.year ?? '').trim() || !String(extracted?.vehicle?.make ?? '').trim() || !String(extracted?.vehicle?.model ?? '').trim();
      const vinInfo = decodedVin && needYmm ? await decodeVinViaNhtsa(decodedVin).catch(() => null) : null;
      const extractedDecoded: FormData | null = vinInfo
        ? {
            ...extracted,
            vehicle: {
              ...extracted.vehicle,
              year: String(extracted.vehicle.year ?? '').trim() || String(vinInfo.year ?? '').trim(),
              make: String(extracted.vehicle.make ?? '').trim() || String(vinInfo.make ?? '').trim(),
              model: String(extracted.vehicle.model ?? '').trim() || String(vinInfo.model ?? '').trim(),
            },
          }
        : extracted;
      const extractedWithRules: FormData | null = extractedDecoded
        ? {
            ...extractedDecoded,
            draft_source: 'bulk_upload',
            pickup_locked: true,
            dropoff_location: {
              ...extractedDecoded.dropoff_location,
              name: '',
              phone: '',
              address: '',
              street: '',
              number: '',
              unit: '',
              area: '',
              city: '',
              province: '',
              postal_code: '',
              country: 'Canada',
              lat: '',
              lng: '',
            },
          }
        : null;

      setFormData(extractedWithRules);

      if (extractedWithRules) {
        setPickupStreetSelected(Boolean(String(extractedWithRules?.pickup_location?.street ?? '').trim()));
        setDropoffStreetSelected(Boolean(String(extractedWithRules?.dropoff_location?.street ?? '').trim()));
      }

      setSubmitMessage('Document extracted successfully. Please review the details then click View Quote Now.');
      setSubmitError(false);
    } catch (err) {
      console.error(err);
      setSubmitMessage(err instanceof Error ? err.message : 'Upload failed');
      setSubmitError(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (autoExtractTriggeredRef.current) return;
    if (isSubmitting) return;
    if (formData) return;
    if (uploadedFiles.length === 0) return;

    autoExtractTriggeredRef.current = true;
    void handleSubmitDocuments();
  }, [uploadedFiles, isSubmitting, formData]);

  const handleProceedWithCost = async () => {
    setShowCostEstimate(false);

    if (!isLoggedIn) {
      setSubmitMessage('Please log in with Google to continue.');
      setSubmitError(true);
      await saveDraftBeforeSignIn();
      onContinueToSignIn?.();
      return;
    }

    setVehicleCondition((formData as unknown as Record<string, unknown> | null)?.vehicle_condition === 'does_not_run_or_drive' ? 'does_not_run_or_drive' : 'runs_and_drives');
    setCheckoutConfirmations({
      pickupAddress: false,
      dropoffAddress: false,
      vehicleDetails: false,
      vehicleRunsAndDrives: false,
      vehicleDoesNotRunOrDrive: false,
    });
    setShowCheckout(true);
  };

  const handlePayNow = async () => {
    if (!formData) return;

    const baseAccepted =
      checkoutConfirmations.pickupAddress &&
      checkoutConfirmations.dropoffAddress &&
      checkoutConfirmations.vehicleDetails;

    const vehicleAccepted =
      vehicleCondition === 'runs_and_drives'
        ? checkoutConfirmations.vehicleRunsAndDrives
        : checkoutConfirmations.vehicleDoesNotRunOrDrive;

    if (!(baseAccepted && vehicleAccepted)) {
      setSubmitMessage('Please complete all required confirmations to continue.');
      setSubmitError(true);
      return;
    }

    const loadingFee = vehicleCondition === 'does_not_run_or_drive' ? 50 : 0;

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
              type: normalizeMimeType(f.name, f.type),
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
              vehicle_condition: vehicleCondition,
              vehicle_loading_fee: loadingFee,
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
          const loadingFee = vehicleCondition === 'does_not_run_or_drive' ? 50 : 0;
          const subtotalBeforeTax = Number(costData.cost ?? 0) + loadingFee;
          lines.push(`Distance: ${costData.distance} km`);
          if (costData.pricingCity && costData.pricingStatus === 'official') {
            lines.push(`City: ${costData.pricingCity}`);
            lines.push(`Price (before tax): $${subtotalBeforeTax}`);
            lines.push('Note: + applicable tax.');
          } else {
            lines.push(`Price (before tax): $${subtotalBeforeTax}`);
            lines.push('Note: + applicable tax.');
          }
          if (loadingFee) {
            lines.push(`Loading fee: $${loadingFee}`);
            lines.push('Note: A customer service representative will contact you within 24 hours to reconfirm vehicle condition and pickup details.');
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

      const routeArea = String(costData?.pricingCity ?? formData?.dropoff_location?.city ?? formData?.pickup_location?.city ?? '').trim();
      const subtotal = Number(costData?.cost ?? 0) + loadingFee;
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
          form_data: {
            ...formData,
            costEstimate: costData,
            vehicle_condition: vehicleCondition,
            vehicle_loading_fee: loadingFee,
          },
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
        form_data: {
          ...formData,
          costEstimate: costData,
          vehicle_condition: vehicleCondition,
          vehicle_loading_fee: loadingFee,
        },
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
                    const routeArea = String(costData?.pricingCity ?? formData?.dropoff_location?.city ?? formData?.pickup_location?.city ?? '').trim();
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
                        <div className="text-xs font-medium text-gray-500">Pricing city</div>
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
                const routeArea = String(costData?.pricingCity ?? formData?.dropoff_location?.city ?? formData?.pickup_location?.city ?? '').trim();
                const loadingFee = vehicleCondition === 'does_not_run_or_drive' ? 50 : 0;
                const subtotal = Number(costData?.cost ?? 0) + loadingFee;
                const totals = computeTotals(subtotal, routeArea);
                return (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div className="text-xs font-medium text-gray-500">Totals (origin-based pricing)</div>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                      <div className="rounded-lg bg-white border border-gray-200 p-3">
                        <div className="text-xs text-gray-500">Subtotal (before tax)</div>
                        <div className="mt-1 font-semibold text-gray-900">${totals.subtotal.toFixed(2)}</div>
                        {loadingFee ? <div className="mt-1 text-xs text-gray-600">Includes $50.00 loading fee</div> : null}
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

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-sm font-semibold text-gray-900">Vehicle condition</div>
                <div className="mt-1 text-sm text-gray-600">Select the current condition of the vehicle at pickup.</div>
                <select
                  value={vehicleCondition}
                  onChange={(e) => {
                    const next = String(e.target.value) === 'does_not_run_or_drive' ? 'does_not_run_or_drive' : 'runs_and_drives';
                    setVehicleCondition(next);
                    setFormData((prev) => (prev ? ({ ...prev, vehicle_condition: next } satisfies FormData) : prev));
                    setCheckoutConfirmations((prev) => ({
                      ...prev,
                      vehicleRunsAndDrives: false,
                      vehicleDoesNotRunOrDrive: false,
                    }));
                  }}
                  className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm"
                >
                  <option value="runs_and_drives">Runs and drives</option>
                  <option value="does_not_run_or_drive">Does not run or drive</option>
                </select>

                {vehicleCondition === 'does_not_run_or_drive' ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <div className="text-sm font-semibold text-amber-900">Additional loading fee</div>
                    <div className="mt-1 text-sm text-amber-900">
                      An additional loading fee of 50 is required for vehicles that do not run or drive. This fee has been added to your total.
                    </div>
                    <div className="mt-2 text-sm text-amber-900">
                      A customer service representative will contact you within 24 hours to reconfirm vehicle condition and pickup details before scheduling transportation.
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="space-y-3">
                <div className="text-sm font-semibold text-gray-900">Checkout vehicle condition confirmation</div>

                <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={checkoutConfirmations.pickupAddress}
                    onChange={(e) =>
                      setCheckoutConfirmations((prev) => ({
                        ...prev,
                        pickupAddress: e.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <div className="text-sm text-gray-700">I confirm the pickup address is correct and accessible.</div>
                </label>

                <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={checkoutConfirmations.dropoffAddress}
                    onChange={(e) =>
                      setCheckoutConfirmations((prev) => ({
                        ...prev,
                        dropoffAddress: e.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <div className="text-sm text-gray-700">I confirm the drop off address is correct.</div>
                </label>

                <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={checkoutConfirmations.vehicleDetails}
                    onChange={(e) =>
                      setCheckoutConfirmations((prev) => ({
                        ...prev,
                        vehicleDetails: e.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <div className="text-sm text-gray-700">I confirm the vehicle year make model and details are accurate.</div>
                </label>

                {vehicleCondition === 'runs_and_drives' ? (
                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={checkoutConfirmations.vehicleRunsAndDrives}
                      onChange={(e) =>
                        setCheckoutConfirmations((prev) => ({
                          ...prev,
                          vehicleRunsAndDrives: e.target.checked,
                        }))
                      }
                      className="mt-1 h-4 w-4"
                    />
                    <div className="text-sm text-gray-700">
                      <div className="font-medium">
                        By checking this box, you confirm and acknowledge that the vehicle runs and drives and is available at the provided pickup address.
                      </div>
                      <div className="mt-2">
                        You understand that failure to disclose vehicle condition or vehicle unavailability will result in a dry run and the full transportation fee will apply.
                        Repeated or related incidents may result in termination of future services.
                      </div>
                    </div>
                  </label>
                ) : (
                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={checkoutConfirmations.vehicleDoesNotRunOrDrive}
                      onChange={(e) =>
                        setCheckoutConfirmations((prev) => ({
                          ...prev,
                          vehicleDoesNotRunOrDrive: e.target.checked,
                        }))
                      }
                      className="mt-1 h-4 w-4"
                    />
                    <div className="text-sm text-gray-700">
                      I confirm the vehicle does not run or drive and understand an additional 50 loading fee will be added to the order.
                    </div>
                  </label>
                )}

                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm font-semibold text-gray-900">Dry run disclosure</div>
                  <div className="mt-1 text-sm text-gray-700">
                    If the driver arrives and the vehicle cannot be moved or is not present at the pickup address, the order will be treated as a dry run and the full transportation cost will apply.
                  </div>
                </div>
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
                      disabled={(() => {
                        const baseAccepted =
                          checkoutConfirmations.pickupAddress &&
                          checkoutConfirmations.dropoffAddress &&
                          checkoutConfirmations.vehicleDetails;
                        const vehicleAccepted =
                          vehicleCondition === 'runs_and_drives'
                            ? checkoutConfirmations.vehicleRunsAndDrives
                            : checkoutConfirmations.vehicleDoesNotRunOrDrive;
                        return isSubmitting || !(baseAccepted && vehicleAccepted);
                      })()}
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
                    {String(costData?.pricingCity ?? formData?.pickup_location?.city ?? formData?.dropoff_location?.city ?? '-')}
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
                      setUploadedFiles([]);
                      setSubmitMessage(null);
                      setSubmitError(false);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                      setFormData(createBlankFormData());
                      setActiveDraftId(null);
                      startManualWizard();
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
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-sm font-semibold text-gray-900">Manual quote wizard</div>
                      <div className="mt-1 text-xs text-gray-600">Step {manualWizardStep === 'locations' ? '1' : manualWizardStep === 'vehicle' ? '2' : '3'} of 3</div>
                      {manualWizardError ? <div className="mt-3 text-sm font-medium text-red-600">{manualWizardError}</div> : null}
                    </div>

                    {manualWizardStep === 'locations' ? (
                      <>
                      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="text-sm font-semibold text-gray-900">Enter Pickup Address</div>
                        <div className="mt-1 text-sm text-gray-600">Start typing the street address in Ontario or Quebec. We'll auto-fill the rest.</div>

                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Street Address</label>
                            <div className="relative">
                              <input
                                name="pickup_address_line1"
                                autoComplete="shipping address-line1"
                                value={pickupStreetLine1Input}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  pickupStreetLine1EditingRef.current = true;
                                  setPickupStreetLine1Input(next);
                                  setPickupSearch(next);
                                  setPickupStreetSelected(false);
                                  setPickupNumberError(null);
                                  setDealershipCoords(null);
                                  const split = splitLine1ToNumberStreet(next);
                                  setPickupAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                                }}
                                onFocus={() => {
                                  pickupStreetLine1EditingRef.current = true;
                                }}
                                onBlur={() => {
                                  pickupStreetLine1EditingRef.current = false;
                                  const normalized = normalizeWhitespace(pickupStreetLine1Input);
                                  setPickupStreetLine1Input(normalized);
                                  setPickupSearch(normalized);
                                  const split = splitLine1ToNumberStreet(normalized);
                                  setPickupAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                                placeholder="e.g., 123 Main St"
                              />
                              {(pickupSuggestLoading || pickupSuggestions.length > 0) && pickupStreetLine1Input.trim().length >= 3 ? (
                                <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
                                  {pickupSuggestLoading ? <div className="px-3 py-2 text-sm text-gray-500">Searching...</div> : null}
                                  {pickupSuggestions.map((s) => (
                                    <button
                                      key={`${s.text}-${s.magicKey ?? ''}`}
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        void (async () => {
                                          setPickupSearch(s.text);
                                          setPickupSuggestions([]);
                                          handlePickupAddressChange(s.text);
                                          setPickupStreetSelected(true);
                                          setPickupNumberError(null);
                                          const coords = await geocodeAddress(s.text).catch(() => null);
                                          if (coords) setDealershipCoords(coords);
                                        })();
                                      }}
                                      className="block w-full text-left px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
                                    >
                                      {s.text}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            {pickupNumberError ? <div className="mt-2 text-xs font-medium text-red-600">{pickupNumberError}</div> : null}
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Suite/Apt</label>
                            <input
                              name="pickup_address_line2"
                              autoComplete="shipping address-line2"
                              value={String(formData?.pickup_location?.unit ?? '')}
                              onChange={(e) => {
                                setPickupAddressFromBreakdown({ unit: e.target.value, area: '' });
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="apt/suite #"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">City</label>
                            <input
                              name="pickup_city"
                              autoComplete="shipping address-level2"
                              value={String(formData?.pickup_location?.city ?? '')}
                              onChange={(e) => {
                                setPickupAddressFromBreakdown({ city: e.target.value, area: '' });
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="city"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Province</label>
                            <select
                              name="pickup_province"
                              autoComplete="shipping address-level1"
                              value={String(formData?.pickup_location?.province ?? '')}
                              onChange={(e) => {
                                setPickupAddressFromBreakdown({ province: e.target.value, area: '' });
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                            >
                              <option value="">Select</option>
                              <option value="ON">Ontario</option>
                              <option value="QC">Quebec</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Postal Code</label>
                            <input
                              name="pickup_postal_code"
                              autoComplete="shipping postal-code"
                              value={String(formData?.pickup_location?.postal_code ?? '')}
                              onChange={(e) => setPickupAddressFromBreakdown({ postal_code: e.target.value, area: '' })}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="Postal Code"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Country</label>
                            <input
                              name="pickup_country"
                              autoComplete="shipping country-name"
                              value="CA"
                              readOnly
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-800"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="text-sm font-semibold text-gray-900">Pickup Contact</div>
                        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Company name</label>
                            <input
                              value={String(formData?.pickup_location?.name ?? '')}
                              onChange={(e) => updateFormField('pickup_location', 'name', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="Company name"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Complete name</label>
                            <input
                              value={String((formData?.pickup_location as unknown as Record<string, unknown>)?.contact_name ?? '')}
                              onChange={(e) =>
                                updateFormField('pickup_location', 'contact_name' as keyof FormData['pickup_location'] & string, e.target.value)
                              }
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="Lastname, Firstname"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Email</label>
                            <input
                              value={String((formData?.pickup_location as unknown as Record<string, unknown>)?.email ?? '')}
                              onChange={(e) => updateFormField('pickup_location', 'email' as keyof FormData['pickup_location'] & string, e.target.value)}
                              inputMode="email"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="email"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Phone number</label>
                            <input
                              value={String(formData?.pickup_location?.phone ?? '')}
                              onChange={(e) => updateFormField('pickup_location', 'phone', sanitizePhone(e.target.value))}
                              inputMode="tel"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="phone"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="text-sm font-semibold text-gray-900">Drop-off</div>
                        <div className="mt-1 text-sm text-gray-600">Enter drop-off address and contact details.</div>

                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Street Address</label>
                            <div className="relative">
                              <input
                                name="dropoff_address_line1"
                                autoComplete="billing address-line1"
                                value={dropoffStreetLine1Input}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  dropoffStreetLine1EditingRef.current = true;
                                  setDropoffStreetLine1Input(next);
                                  setDropoffSearch(next);
                                  setDropoffStreetSelected(false);
                                  setDropoffNumberError(null);
                                  updateFormField('dropoff_location', 'lat', '');
                                  updateFormField('dropoff_location', 'lng', '');
                                  const split = splitLine1ToNumberStreet(next);
                                  setDropoffAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                                }}
                                onFocus={() => {
                                  dropoffStreetLine1EditingRef.current = true;
                                }}
                                onBlur={() => {
                                  dropoffStreetLine1EditingRef.current = false;
                                  const normalized = normalizeWhitespace(dropoffStreetLine1Input);
                                  setDropoffStreetLine1Input(normalized);
                                  setDropoffSearch(normalized);
                                  const split = splitLine1ToNumberStreet(normalized);
                                  setDropoffAddressFromBreakdown({ street: split.street, number: split.number, area: '' });
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                                placeholder="e.g., 456 King St"
                              />
                              {(dropoffSuggestLoading || dropoffSuggestions.length > 0) && dropoffStreetLine1Input.trim().length >= 3 ? (
                                <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
                                  {dropoffSuggestLoading ? <div className="px-3 py-2 text-sm text-gray-500">Searching...</div> : null}
                                  {dropoffSuggestions.map((s) => (
                                    <button
                                      key={`${s.text}-${s.magicKey ?? ''}`}
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        void (async () => {
                                          setDropoffSearch(s.text);
                                          setDropoffSuggestions([]);
                                          handleDropoffAddressChange(s.text);
                                          setDropoffStreetSelected(true);
                                          setDropoffNumberError(null);
                                          const coords = await geocodeAddress(s.text).catch(() => null);
                                          if (coords) {
                                            updateFormField('dropoff_location', 'lat', String(coords.lat));
                                            updateFormField('dropoff_location', 'lng', String(coords.lng));
                                          }
                                        })();
                                      }}
                                      className="block w-full text-left px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
                                    >
                                      {s.text}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            {dropoffNumberError ? <div className="mt-2 text-xs font-medium text-red-600">{dropoffNumberError}</div> : null}
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Suite/Apt</label>
                            <input
                              name="dropoff_address_line2"
                              autoComplete="billing address-line2"
                              value={String(formData?.dropoff_location?.unit ?? '')}
                              onChange={(e) => {
                                setDropoffAddressFromBreakdown({ unit: e.target.value, area: '' });
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="apt/suite #"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">City</label>
                            <input
                              name="dropoff_city"
                              autoComplete="billing address-level2"
                              value={String(formData?.dropoff_location?.city ?? '')}
                              onChange={(e) => {
                                setDropoffAddressFromBreakdown({ city: e.target.value, area: '' });
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="city"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Province</label>
                            <select
                              name="dropoff_province"
                              autoComplete="billing address-level1"
                              value={String(formData?.dropoff_location?.province ?? '')}
                              onChange={(e) => {
                                setDropoffAddressFromBreakdown({ province: e.target.value, area: '' });
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white"
                            >
                              <option value="">Select</option>
                              <option value="ON">Ontario</option>
                              <option value="QC">Quebec</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Postal Code</label>
                            <input
                              name="dropoff_postal_code"
                              autoComplete="billing postal-code"
                              value={String(formData?.dropoff_location?.postal_code ?? '')}
                              onChange={(e) => setDropoffAddressFromBreakdown({ postal_code: e.target.value, area: '' })}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="Postal Code"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Country</label>
                            <input
                              name="dropoff_country"
                              autoComplete="billing country-name"
                              value="CA"
                              readOnly
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-800"
                            />
                          </div>
                        </div>
                        <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden bg-white h-60 sm:h-80 relative z-0">
                          <MapContainer
                            center={dropoffCoords ? [dropoffCoords.lat, dropoffCoords.lng] : dealershipCoords ? [dealershipCoords.lat, dealershipCoords.lng] : [45.5017, -73.5673]}
                            zoom={dropoffCoords || dealershipCoords ? 13 : 10}
                            style={{ height: '100%', width: '100%', zIndex: 1 }}
                          >
                            <TileLayer attribution='Tiles &copy; Esri' url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
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

                      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="text-sm font-semibold text-gray-900">Drop-off Contact</div>
                        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Company name</label>
                            <input
                              value={String(formData?.dropoff_location?.name ?? '')}
                              onChange={(e) => updateFormField('dropoff_location', 'name', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="Company name"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Complete name</label>
                            <input
                              value={String((formData?.dropoff_location as unknown as Record<string, unknown>)?.contact_name ?? '')}
                              onChange={(e) =>
                                updateFormField('dropoff_location', 'contact_name' as keyof FormData['dropoff_location'] & string, e.target.value)
                              }
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="Lastname, Firstname"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Email</label>
                            <input
                              value={String((formData?.dropoff_location as unknown as Record<string, unknown>)?.email ?? '')}
                              onChange={(e) => updateFormField('dropoff_location', 'email' as keyof FormData['dropoff_location'] & string, e.target.value)}
                              inputMode="email"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="email"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Phone number</label>
                            <input
                              value={String(formData?.dropoff_location?.phone ?? '')}
                              onChange={(e) => updateFormField('dropoff_location', 'phone', sanitizePhone(e.target.value))}
                              inputMode="tel"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              placeholder="phone"
                            />
                          </div>
                        </div>
                      </div>
                      </>
                    ) : manualWizardStep === 'quote' ? (
                      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="text-sm font-semibold text-gray-900">Quote</div>
                        {!isLoggedIn ? (
                          <>
                            <div className="mt-1 text-sm text-gray-600">Log in with Google to calculate pricing.</div>
                            <button
                              type="button"
                              onClick={() => {
                                void (async () => {
                                  setResumeManualWizardAfterLogin('quote');
                                  hideManualFormKeepState();

                                  const safeCost: CostData | null = costData
                                    ? { distance: costData.distance, cost: costData.cost, duration: costData.duration, pricingStatus: costData.pricingStatus }
                                    : null;

                                  persistManualResumeState({
                                    step: 'quote',
                                    formData,
                                    costData: safeCost,
                                    pickupSearch,
                                    dropoffSearch,
                                  });

                                  await saveDraftBeforeSignIn({ formData, costData: safeCost }).catch(() => null);
                                  onContinueToSignIn?.();
                                })();
                              }}
                              className="mt-4 inline-flex justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                            >
                              Log in with Google
                            </button>
                          </>
                        ) : null}

                        {isLoggedIn ? (
                          <>
                            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                              <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                                <div className="text-xs font-medium text-gray-500">Distance</div>
                                <div className="mt-1 font-semibold text-gray-900">{Number(costData?.distance ?? 0) || 0} km</div>
                              </div>
                              <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                                <div className="text-xs font-medium text-gray-500">Rate</div>
                                <div className="mt-1 font-semibold text-gray-900">${getDistanceRatePerKm()}/km</div>
                              </div>
                              <div className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                                <div className="text-xs font-medium text-gray-500">Minimum</div>
                                <div className="mt-1 font-semibold text-gray-900">$150</div>
                              </div>
                            </div>
                            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
                              <div className="text-xs font-medium text-gray-500">Estimated price (before tax)</div>
                              <div className="mt-1 text-2xl font-bold text-gray-900">${Number(costData?.cost ?? 0) || 0}</div>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : manualWizardStep === 'vehicle' ? (
                      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
                        <div className="text-sm font-semibold text-gray-900">Vehicle details</div>
                        <div className="mt-4">
                          <div className="text-sm font-semibold text-gray-900">Vehicle running / drivable</div>
                          <div className="mt-1 text-sm text-gray-600">Is the vehicle able to run and drive at pickup?</div>
                          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setVehicleCondition('runs_and_drives');
                                setFormData((prev) => (prev ? ({ ...prev, vehicle_condition: 'runs_and_drives' } satisfies FormData) : prev));
                              }}
                              className={`inline-flex items-center justify-center rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
                                vehicleCondition === 'runs_and_drives'
                                  ? 'border-cyan-300 bg-cyan-50 text-cyan-900'
                                  : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50'
                              }`}
                            >
                              Yes (Runs & drives)
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setVehicleCondition('does_not_run_or_drive');
                                setFormData((prev) => (prev ? ({ ...prev, vehicle_condition: 'does_not_run_or_drive' } satisfies FormData) : prev));
                              }}
                              className={`inline-flex items-center justify-center rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${
                                vehicleCondition === 'does_not_run_or_drive'
                                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                                  : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50'
                              }`}
                            >
                              No (Not drivable)
                            </button>
                          </div>
                        </div>

                        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">VIN</label>
                            <div className="flex gap-2">
                              <input
                                value={formData?.vehicle?.vin ?? ''}
                                onChange={(e) => updateFormField('vehicle', 'vin', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  void (async () => {
                                    if (!formData) return;
                                    const vin = String(formData.vehicle.vin ?? '').trim().toUpperCase();
                                    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
                                      setManualWizardError('Enter a valid 17-character VIN to decode.');
                                      return;
                                    }
                                    setManualVinDecodeLoading(true);
                                    setManualWizardError(null);
                                    const info = await decodeVinViaNhtsa(vin).catch(() => null);
                                    setManualVinDecodeLoading(false);
                                    if (!info) {
                                      setManualWizardError('VIN decode failed. Please verify the VIN and try again.');
                                      return;
                                    }
                                    updateFormField('vehicle', 'year', String(info.year ?? ''));
                                    updateFormField('vehicle', 'make', String(info.make ?? ''));
                                    updateFormField('vehicle', 'model', String(info.model ?? ''));
                                  })();
                                }}
                                disabled={manualVinDecodeLoading}
                                className="shrink-0 inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                {manualVinDecodeLoading ? 'Decoding...' : 'Decode'}
                              </button>
                            </div>
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Year</label>
                            <input
                              value={formData?.vehicle?.year ?? ''}
                              onChange={(e) => updateFormField('vehicle', 'year', sanitizeDigits(e.target.value).slice(0, 4))}
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Make</label>
                            <input
                              value={formData?.vehicle?.make ?? ''}
                              onChange={(e) => updateFormField('vehicle', 'make', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-600 mb-1">Model</label>
                            <input
                              value={formData?.vehicle?.model ?? ''}
                              onChange={(e) => updateFormField('vehicle', 'model', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
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

                      <div className="w-full sm:w-auto flex flex-col sm:flex-row gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setManualWizardError(null);
                            if (manualWizardStep === 'locations') return;
                            if (manualWizardStep === 'vehicle') return setManualWizardStep('locations');
                            if (manualWizardStep === 'quote') return setManualWizardStep('vehicle');
                            return setManualWizardStep('quote');
                          }}
                          className="w-full sm:w-auto px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void (async () => {
                              setManualWizardError(null);
                              if (manualWizardStep === 'locations') return setManualWizardStep('vehicle');
                              if (manualWizardStep === 'vehicle') {
                                if (!isLoggedIn) {
                                  setManualWizardStep('quote');
                                  return;
                                }
                                const ok = await computeManualQuote();
                                if (ok) setManualWizardStep('quote');
                                return;
                              }
                              if (manualWizardStep === 'quote') {
                                if (!isLoggedIn) {
                                  setManualWizardError('Please log in to proceed to checkout.');
                                  return;
                                }

                                const hasQuote = Boolean(Number(costData?.cost ?? 0)) && Boolean(Number(costData?.distance ?? 0));
                                if (!hasQuote) {
                                  const ok = await computeManualQuote();
                                  if (!ok) return;
                                }

                                hideManualFormKeepState();
                                await handleProceedWithCost();
                              }
                            })();
                          }}
                          disabled={isSubmitting}
                          className="w-full sm:w-auto px-6 py-3 bg-cyan-500 text-white rounded-lg hover:bg-cyan-600 transition-colors font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {manualWizardStep === 'quote' ? 'Proceed to checkout' : 'Next'}
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {!isManualFormOpen && (uploadedFiles.length > 0 || (formData && String(formData?.draft_source ?? '').trim() !== 'manual')) && (
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
                    <div className="inline-flex items-center gap-2 rounded-full bg-green-50 border border-green-200 px-3 py-1 text-xs font-semibold text-green-700">
                      <CheckCircle className="w-4 h-4" />
                      Required
                    </div>
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
