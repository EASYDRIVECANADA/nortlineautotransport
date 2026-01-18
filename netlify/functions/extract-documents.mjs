const sanitizeFilename = (name) => {
  const base = String(name ?? '').trim() || 'document';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
};

const getCorsHeaders = (event) => {
  const origin = String(event?.headers?.origin ?? event?.headers?.Origin ?? '').trim();
  const allowOrigin = origin || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
};

const normalizeMime = (name, type) => {
  const t = String(type ?? '').trim().toLowerCase();
  const n = String(name ?? '').trim().toLowerCase();
  if (t && t !== 'application/octet-stream') return t;
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (t === 'application/msword') return 'application/msword';
  return 'application/octet-stream';
};

const normalizeWhitespace = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const repairStreetNameOcr = (street) => {
  const raw = normalizeWhitespace(String(street ?? ''));
  if (!raw) return '';
  return raw
    .replace(/\b(?:loe|l0e|i0e)\b(?=\s+(?:avenue|ave\.?|av\.?|rue)\b)/i, '10e')
    .replace(/\b10E\b(?=\s+(?:avenue|ave\.?|av\.?|rue)\b)/i, '10e');
};

const normalizePostalCode = (value) => {
  const raw = normalizeWhitespace(String(value ?? '').toUpperCase());
  if (!raw) return '';
  const compact = raw.replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 6) return raw;
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
};

const PROVINCE_NAME_TO_CODE = {
  ALBERTA: 'AB',
  'BRITISHCOLUMBIA': 'BC',
  MANITOBA: 'MB',
  'NEWBRUNSWICK': 'NB',
  'NEWFOUNDLANDANDLABRADOR': 'NL',
  'NORTHWESTTERRITORIES': 'NT',
  NOVASCOTIA: 'NS',
  NUNAVUT: 'NU',
  ONTARIO: 'ON',
  'PRINCEEDWARDISLAND': 'PE',
  QUEBEC: 'QC',
  SASKATCHEWAN: 'SK',
  YUKON: 'YT',
};

const CAN_PROVINCE_CODES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

const isValidCanadianPostalCode = (value) => /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(String(value ?? ''));

const normalizeProvinceCode = (value) => {
  const raw = normalizeWhitespace(String(value ?? ''));
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && CAN_PROVINCE_CODES.has(upper)) return upper;
  const key = upper.replace(/[^A-Z]/g, '');
  return PROVINCE_NAME_TO_CODE[key] ?? '';
};

const parseCanadianAddressMatch = ({ line1Raw, cityRaw, provinceRaw, postalRaw }) => {
  const line1 = normalizeWhitespace(line1Raw);
  const city = normalizeWhitespace(cityRaw);
  const province = normalizeProvinceCode(provinceRaw);
  const postal_code = normalizePostalCode(postalRaw);
  const country = 'Canada';

  if (!line1 || !city || !province || !isValidCanadianPostalCode(postal_code)) return null;

  const unitMatch =
    line1.match(/\b(?:apt|apartment|suite|unit)\b\s*#?\s*([A-Za-z0-9-]+)\b/i) || line1.match(/\s#\s*([A-Za-z0-9-]+)\b/i);
  const unit = unitMatch ? normalizeWhitespace(unitMatch[0]) : '';
  const line1NoUnit = unitMatch ? normalizeWhitespace(line1.replace(unitMatch[0], '').trim()) : line1;

  const numberStreet = line1NoUnit.match(/^\s*(\d{1,6}[A-Za-z]?)\s+(.+)$/);
  const number = numberStreet?.[1] ? String(numberStreet[1]).trim() : '';
  const street = repairStreetNameOcr(numberStreet?.[2] ? String(numberStreet[2]).trim() : line1NoUnit);

  const address = buildAddress({ number, street, unit, city, province, postal_code, country });
  if (!address) return null;

  return {
    name: '',
    phone: '',
    address,
    street,
    number,
    unit,
    area: '',
    city,
    province,
    postal_code,
    country,
  };
};

const extractFirstCanadianAddressFromText = (text) => {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.trim()) return null;

  const patterns = [
    /\b(\d{1,6}[A-Za-z]?)\s+([^\n,]{3,90}?)\s*,\s*([A-Za-zÀ-ÿ .'-]{2,50})\s*,\s*([A-Za-z]{2}|[A-Za-zÀ-ÿ .'-]{3,30})\s*,?\s*([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/gi,
    /\b(\d{1,6}[A-Za-z]?)\s+([^\n,]{3,90}?)\s*,\s*([A-Za-zÀ-ÿ .'-]{2,50})\s*[,\s]+([A-Za-z]{2}|[A-Za-zÀ-ÿ .'-]{3,30})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/gi,
  ];

  const scoreWindow = (startIdx) => {
    const windowStart = Math.max(0, startIdx - 220);
    const window = raw.slice(windowStart, startIdx).toLowerCase();

    const hasPickup = /\bpick\s*-?up\b|\bpickup\b|\bvehicle\s+location\b|\blocation\b/.test(window);
    const hasDropoff = /\bdrop\s*-?off\b|\bdropoff\b/.test(window);
    const hasSellerDealer = /\bseller\b|\bdealership\b|\bdealer\b|\bselling\b/.test(window);
    const hasBuyer = /\bbuyer\b/.test(window);

    let score = 0;
    if (hasPickup) score += 4;
    if (hasDropoff) score += 1;
    if (hasSellerDealer) score -= 3;
    if (hasBuyer) score -= 1;
    return score;
  };

  let best = null;
  let bestScore = -999;

  for (const re of patterns) {
    for (const m of raw.matchAll(re)) {
      const startIdx = typeof m.index === 'number' ? m.index : 0;
      const parsed = parseCanadianAddressMatch({
        line1Raw: `${m[1]} ${m[2]}`,
        cityRaw: m[3],
        provinceRaw: m[4],
        postalRaw: m[5],
      });
      if (!parsed) continue;
      const score = scoreWindow(startIdx);
      if (score > bestScore) {
        bestScore = score;
        best = parsed;
      }
    }
  }

  return best;
};

const buildAddress = ({ number, street, unit, city, province, postal_code, country }) => {
  const parts = [];
  const line1 = normalizeWhitespace(`${String(number ?? '').trim()} ${String(street ?? '').trim()}`.trim());
  if (line1) parts.push(line1);
  const u = normalizeWhitespace(unit);
  if (u) parts.push(u);
  const c = normalizeWhitespace(city);
  if (c) parts.push(c);
  const prov = normalizeWhitespace(province);
  const postal = normalizePostalCode(postal_code);
  const provPostal = normalizeWhitespace(`${prov} ${postal}`.trim());
  if (provPostal) parts.push(provPostal);
  const co = normalizeWhitespace(country);
  if (co) parts.push(co);
  return parts.join(', ');
};

const extractPickupLocationFromText = (text) => {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.trim()) return null;

  const pickupHeading = /\bP[IL]CKUP\s+LOCAT[IL]ON\b/i;
  const idx = raw.search(pickupHeading);
  const windowText = idx >= 0 ? raw.slice(idx, idx + 700) : raw;

  const addressRegex =
    /(\b\d{1,6}[A-Za-z]?\s+[^\n,]{3,90}),\s*([A-Za-zÀ-ÿ .'-]{2,50}),\s*([A-Za-z]{2}|[A-Za-zÀ-ÿ .'-]{3,30})\s*,?\s*([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i;
  const m = windowText.match(addressRegex) || raw.match(addressRegex);
  if (m) {
    const parsed = parseCanadianAddressMatch({
      line1Raw: m[1],
      cityRaw: m[2],
      provinceRaw: m[3],
      postalRaw: m[4],
    });
    if (parsed) return parsed;
  }

  return extractFirstCanadianAddressFromText(raw);
};

const extractTextFromTxt = (base64) => {
  try {
    return Buffer.from(String(base64 ?? '').trim(), 'base64').toString('utf8');
  } catch {
    return '';
  }
};

const extractTextFromDocx = async (base64) => {
  const raw = String(base64 ?? '').trim();
  if (!raw) return '';
  try {
    const mammoth = await import('mammoth');
    const buf = Buffer.from(raw, 'base64');
    const result = await mammoth.extractRawText({ buffer: buf });
    return String(result?.value ?? '').trim();
  } catch {
    return '';
  }
};

const extractTextFromPdf = async (base64) => {
  const raw = String(base64 ?? '').trim();
  if (!raw) return '';
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(Buffer.from(raw, 'base64'));
    const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;
    const pages = Math.min(Number(doc.numPages ?? 0) || 0, 30);
    const parts = [];
    for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = Array.isArray(content?.items) ? content.items : [];
      const pageText = items
        .map((it) => (it && typeof it === 'object' && 'str' in it ? String(it.str ?? '') : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) parts.push(pageText);
    }
    const combined = parts.join('\n\n').trim();
    return combined;
  } catch {
    return '';
  }
};

const ocrSpaceExtract = async ({ base64, mime, name }) => {
  const key = String(process.env.OCR_SPACE_API_KEY ?? '').trim();
  if (!key) {
    throw new Error('Missing OCR_SPACE_API_KEY (Netlify environment variable)');
  }

  const ext = String(name ?? '').toLowerCase();
  const dataUrl = `data:${mime};base64,${base64}`;
  const params = new URLSearchParams();
  params.set('apikey', key);
  params.set('language', 'eng');
  params.set('detectOrientation', 'true');
  params.set('isOverlayRequired', 'false');
  params.set('base64Image', dataUrl);
  if (mime === 'application/pdf' || ext.endsWith('.pdf')) params.set('filetype', 'PDF');

  const res = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `OCR request failed (${res.status})`);
  }

  const json = await res.json().catch(() => null);
  const err = json && typeof json === 'object' ? json.ErrorMessage : null;
  if (err && String(err).trim()) {
    throw new Error(String(err));
  }

  const parsedResults = json && typeof json === 'object' ? json.ParsedResults : null;
  if (Array.isArray(parsedResults) && parsedResults.length) {
    const texts = parsedResults
      .map((r) => (r && typeof r === 'object' ? String(r.ParsedText ?? '').trim() : ''))
      .filter((t) => t && String(t).trim());
    const combined = texts.join('\n\n').trim();
    if (combined) return combined;
  }

  return '';
};

const shouldOcrPdfText = (text) => {
  const raw = String(text ?? '').trim();
  if (!raw) return true;
  if (raw.length < 180) return true;
  const hasYmm = hasVehicleYmmStrict(raw);
  if (!hasYmm) return true;
  return false;
};

const extractVehicleYmmFromText = (text) => {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.trim()) return { year: '', make: '', model: '' };

  const blacklist = new Set([
    'vehicle',
    'buyer',
    'seller',
    'date',
    'due',
    'pickup',
    'location',
    'proof',
    'purchase',
    'paid',
    'keeper',
  ]);

  const lines = raw
    .split('\n')
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(/\b((?:19|20)[0-9IlOo]{2})\b\s+([A-Za-z][A-Za-z0-9&.'\/-]{1,})\s+([^\r\n]{2,80})/);
    if (!m) continue;
    const repairedYear = String(m[1])
      .replace(/[Il]/g, '1')
      .replace(/[Oo]/g, '0');
    const year = (repairedYear.match(/\b(19\d{2}|20\d{2})\b/) ?? [])[1] ?? '';
    if (!year) continue;

    const make = String(m[2] ?? '').trim();
    const model = String(m[3] ?? '').trim();
    if (!make || !model) continue;
    if (blacklist.has(make.toLowerCase())) continue;
    if (!/[A-Za-z]/.test(model)) continue;
    return { year, make, model };
  }

  return { year: '', make: '', model: '' };
};

const hasVehicleYmmStrict = (text) => {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.trim()) return false;
  const blacklist = new Set([
    'vehicle',
    'buyer',
    'seller',
    'date',
    'due',
    'pickup',
    'location',
    'proof',
    'purchase',
    'paid',
    'keeper',
  ]);

  const lines = raw
    .split('\n')
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(/\b((?:19|20)[0-9IlOo]{2})\b\s+([A-Za-z][A-Za-z0-9&.'\/-]{1,})\s+([^\r\n]{2,80})/);
    if (!m) continue;
    const repairedYear = String(m[1])
      .replace(/[Il]/g, '1')
      .replace(/[Oo]/g, '0');
    const year = (repairedYear.match(/\b(19\d{2}|20\d{2})\b/) ?? [])[1] ?? '';
    if (!year) continue;
    const make = String(m[2] ?? '').trim();
    const model = String(m[3] ?? '').trim();
    if (!make || !model) continue;
    if (blacklist.has(make.toLowerCase())) continue;
    if (!/[A-Za-z]/.test(model)) continue;
    return true;
  }
  return false;
};

const extractVinFromText = (text) => {
  const raw = String(text ?? '').toUpperCase();
  if (!raw) return '';
  const cleaned = raw.replace(/[^A-Z0-9\s\-]/g, ' ');
  const direct = cleaned.match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) ?? [];
  if (direct.length) return String(direct[0] ?? '').trim();

  const labeled = cleaned.match(/\bVIN\b[^A-Z0-9]{0,10}([A-HJ-NPR-Z0-9\s\-]{17,40})/);
  if (labeled?.[1]) {
    const compact = String(labeled[1]).replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17);
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(compact)) return compact;
  }
  return '';
};

const decodeVinViaNhtsa = async (vin) => {
  const v = String(vin ?? '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return null;
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${encodeURIComponent(v)}?format=json`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const results = json && typeof json === 'object' ? json.Results : null;
  const first = Array.isArray(results) && results.length ? results[0] : null;
  if (!first || typeof first !== 'object') return null;
  const year = String(first.ModelYear ?? '').trim();
  const make = String(first.Make ?? '').trim();
  const model = String(first.Model ?? '').trim();
  if (!year && !make && !model) return null;
  return { vin: v, year, make, model };
};

const extractTextForFile = async (file) => {
  const name = sanitizeFilename(file?.name);
  const mime = normalizeMime(name, file?.type);
  const base64 = String(file?.base64 ?? '').trim();

  if (!base64) return { name, mime, text: '' };

  if (mime === 'text/plain' || name.toLowerCase().endsWith('.txt')) {
    return { name, mime, text: extractTextFromTxt(base64) };
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.toLowerCase().endsWith('.docx')
  ) {
    return { name, mime, text: await extractTextFromDocx(base64) };
  }

  if (mime === 'application/pdf') {
    const pdfText = await extractTextFromPdf(base64);
    if (pdfText && !shouldOcrPdfText(pdfText)) return { name, mime, text: pdfText };
    const ocrText = await ocrSpaceExtract({ base64, mime, name }).catch(() => '');
    const merged = [pdfText, ocrText]
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    return { name, mime, text: merged };
  }

  if (mime.startsWith('image/')) {
    return { name, mime, text: await ocrSpaceExtract({ base64, mime, name }) };
  }

  return { name, mime, text: '' };
};

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);
  try {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
        },
        body: '',
      };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { ...corsHeaders }, body: 'Method Not Allowed' };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const filesRaw = Array.isArray(body?.files) ? body.files : [];

    if (!filesRaw.length) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Missing files' }),
      };
    }

    const texts = [];
    const fileResults = [];

    for (let i = 0; i < filesRaw.length; i += 1) {
      const f = filesRaw[i] && typeof filesRaw[i] === 'object' ? filesRaw[i] : null;
      if (!f) continue;
      const { name, mime, text } = await extractTextForFile(f);
      const docType = String(f?.docType ?? '').trim();
      fileResults.push({ name, type: mime, docType: docType || 'unknown', text: text || '' });
      if (text && String(text).trim()) {
        texts.push(String(text).trim());
      }
    }

    const combinedText = texts.join('\n\n');

    const vin = extractVinFromText(combinedText);
    const ymmFromText = extractVehicleYmmFromText(combinedText);
    const baseVehicle = {
      vin: vin || '',
      year: String(ymmFromText?.year ?? '').trim(),
      make: String(ymmFromText?.make ?? '').trim(),
      model: String(ymmFromText?.model ?? '').trim(),
    };
    const shouldDecodeVin =
      !!baseVehicle.vin && (!baseVehicle.year.trim() || !baseVehicle.make.trim() || !baseVehicle.model.trim());
    const decodedVehicle = shouldDecodeVin ? await decodeVinViaNhtsa(baseVehicle.vin).catch(() => null) : null;
    const vehicle = decodedVehicle
      ? {
          vin: baseVehicle.vin || decodedVehicle.vin,
          year: baseVehicle.year || decodedVehicle.year,
          make: baseVehicle.make || decodedVehicle.make,
          model: baseVehicle.model || decodedVehicle.model,
        }
      : baseVehicle;

    const pickup_location = extractPickupLocationFromText(combinedText);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          output: {
            text: combinedText,
            raw_text: combinedText,
            vehicle,
            pickup_location,
            files: fileResults,
          },
        },
      ]),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: err instanceof Error ? err.message : 'Unknown error' }),
    };
  }
};
