export type ServiceType = 'pickup_one_way' | 'delivery_one_way';
export type VehicleType = 'standard';

export const QUOTE_MARKUP = 35;

const PRICING_OVERRIDES_KEY = 'ed_pricing_overrides';

export const getPricingOverrides = (): Record<string, number> => {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.localStorage.getItem(PRICING_OVERRIDES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const city = String(k ?? '').trim();
      const num = typeof v === 'number' ? v : Number(v);
      if (!city) continue;
      if (!Number.isFinite(num)) continue;
      out[city] = num;
    }
    return out;
  } catch {
    return {};
  }
};

export const setPricingOverrides = (next: Record<string, number>) => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PRICING_OVERRIDES_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

export const clearPricingOverrides = () => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(PRICING_OVERRIDES_KEY);
  } catch {
    // ignore
  }
};

export type PricingRow = {
  route: string;
  vehicle_type: VehicleType;
  northline_cost: number;
  retail_price: number;
  days_min: number;
  days_max: number;
};

export const OFFICIAL_CITY_TOTAL_PRICES: Array<{ city: string; total_price: number; match: (addr: string) => boolean }> = [
  {
    city: 'Toronto (Oshawa Region)',
    total_price: 385,
    match: (addr) => /\boshawa\b/i.test(addr) || /\bajax\b/i.test(addr) || /\bwhitby\b/i.test(addr) || /\bpickering\b/i.test(addr),
  },
  {
    city: 'Toronto (Downtown / Brampton / Mississauga)',
    total_price: 435,
    match: (addr) =>
      /\btoronto\b/i.test(addr) || /\bdowntown\b/i.test(addr) || /\bbrampton\b/i.test(addr) || /\bmississauga\b/i.test(addr),
  },
  { city: 'Hamilton', total_price: 535, match: (addr) => /\bhamilton\b/i.test(addr) },
  { city: 'Niagara Falls', total_price: 585, match: (addr) => /\bniagara\s*falls\b/i.test(addr) },
  { city: 'Windsor', total_price: 635, match: (addr) => /\bwindsor\b/i.test(addr) },
  { city: 'London, Ontario', total_price: 585, match: (addr) => /\blondon\b/i.test(addr) },
  { city: 'Kingston', total_price: 235, match: (addr) => /\bkingston\b/i.test(addr) },
  { city: 'Belleville', total_price: 285, match: (addr) => /\bbelleville\b/i.test(addr) },
  { city: 'Cornwall', total_price: 205, match: (addr) => /\bcornwall\b/i.test(addr) },
  { city: 'Peterborough', total_price: 385, match: (addr) => /\bpeterborough\b/i.test(addr) },
  { city: 'Barrie', total_price: 435, match: (addr) => /\bbarrie\b/i.test(addr) },
  { city: 'North Bay', total_price: 435, match: (addr) => /\bnorth\s*bay\b/i.test(addr) },
  { city: 'Timmins', total_price: 685, match: (addr) => /\btimmins\b/i.test(addr) },
  {
    city: 'Montreal (Trois-Rivières Region)',
    total_price: 335,
    match: (addr) => /\btrois[-\s]*rivi(e|è)res\b/i.test(addr) || /\btrois\s*rivieres\b/i.test(addr),
  },
  { city: 'Montreal', total_price: 285, match: (addr) => /\bmontreal\b/i.test(addr) || /\bmontr(e|é)al\b/i.test(addr) },
  { city: 'Quebec City', total_price: 435, match: (addr) => /\bqu(e|é)bec\s*city\b/i.test(addr) || /\bville\s*de\s*qu(e|é)bec\b/i.test(addr) },
];

const EXTRA_SERVICE_AREAS = ['Ottawa'];

export const SERVICE_AREAS = Array.from(new Set([...OFFICIAL_CITY_TOTAL_PRICES.map((x) => x.city), ...EXTRA_SERVICE_AREAS]));

export const SERVICE_AREA_GEOCODE_QUERY: Record<string, string> = {
  'Toronto (Oshawa Region)': 'Oshawa, ON, Canada',
  'Toronto (Downtown / Brampton / Mississauga)': 'Toronto, ON, Canada',
  Hamilton: 'Hamilton, ON, Canada',
  'Niagara Falls': 'Niagara Falls, ON, Canada',
  Windsor: 'Windsor, ON, Canada',
  'London, Ontario': 'London, ON, Canada',
  Kingston: 'Kingston, ON, Canada',
  Belleville: 'Belleville, ON, Canada',
  Cornwall: 'Cornwall, ON, Canada',
  Peterborough: 'Peterborough, ON, Canada',
  Barrie: 'Barrie, ON, Canada',
  'North Bay': 'North Bay, ON, Canada',
  Timmins: 'Timmins, ON, Canada',
  Ottawa: 'Ottawa, ON, Canada',
  Montreal: 'Montreal, QC, Canada',
  'Montreal (Trois-Rivières Region)': 'Trois-Rivières, QC, Canada',
  'Quebec City': 'Quebec City, QC, Canada',
};

export const getOfficialCityPriceForServiceArea = (serviceArea: string | null | undefined) => {
  const area = String(serviceArea ?? '').trim();
  if (!area) return null;
  const found = OFFICIAL_CITY_TOTAL_PRICES.find((item) => item.city === area);
  if (!found) return null;
  const overrides = getPricingOverrides();
  const override = overrides[found.city];
  const price = Number.isFinite(override) ? override : found.total_price;
  return { city: found.city, total_price: price };
};

export const getOfficialCityPriceForAddress = (address: string | null | undefined) => {
  const addr = String(address ?? '').trim();
  if (!addr) return null;
  const overrides = getPricingOverrides();
  for (const item of OFFICIAL_CITY_TOTAL_PRICES) {
    if (item.match(addr)) {
      const override = overrides[item.city];
      const price = Number.isFinite(override) ? override : item.total_price;
      return { city: item.city, total_price: price };
    }
  }
  return null;
};

export const getFulfillmentDaysForRoute = (route: string | null | undefined) => {
  const r = String(route ?? '').trim().toLowerCase();
  const isMontreal = r.includes('montreal');
  return isMontreal ? { days_min: 1, days_max: 2 } : { days_min: 3, days_max: 8 };
};

export const PRICING_TABLE: PricingRow[] = OFFICIAL_CITY_TOTAL_PRICES.map((item) => {
  const days = getFulfillmentDaysForRoute(item.city);
  return {
    route: item.city,
    vehicle_type: 'standard',
    northline_cost: Math.max(0, item.total_price - QUOTE_MARKUP),
    retail_price: item.total_price,
    days_min: days.days_min,
    days_max: days.days_max,
  };
});

export const getPricingRow = (route: string | null | undefined, vehicleType: VehicleType = 'standard'): PricingRow | null => {
  const r = String(route ?? '').trim();
  if (!r) return null;
  const base = PRICING_TABLE.find((row) => row.route === r && row.vehicle_type === vehicleType) ?? null;
  if (!base) return null;
  const overrides = getPricingOverrides();
  const override = overrides[base.route];
  if (!Number.isFinite(override)) return base;
  return {
    ...base,
    retail_price: override,
    northline_cost: Math.max(0, override - QUOTE_MARKUP),
  };
};
