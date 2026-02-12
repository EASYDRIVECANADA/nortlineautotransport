import { useEffect, useState } from 'react';
import { Gavel, KeyRound, Lock, Pencil, Plus, ShieldCheck, Unlock, Users } from 'lucide-react';
import AdminPanel from './AdminPanel';
import { supabase } from '../lib/supabaseClient';
import {
  listPendingOffersAsStaff,
  updateOfferAsStaff,
  updateOrderPricingAndStageAsStaff,
  type StaffOfferRow,
} from '../orders/supabaseOrders';
import { listLocalPendingOffersAsStaff, resolveLocalOfferAsStaff } from '../orders/localOrders';
import {
  DEFAULT_DISTANCE_RATE_PER_KM,
  OFFICIAL_CITY_TOTAL_PRICES,
  clearDistanceRatePerKm,
  clearPricingOverrides,
  getDistanceRatePerKm,
  getPricingOverrides,
  setDistanceRatePerKm,
  setPricingOverrides,
} from '../pricing/pricingTable';

const STORAGE_STAFF_SESSION = 'ed_staff_session';
const STORAGE_STAFF_CREDS = 'ed_staff_creds';
const STORAGE_EMPLOYEES = 'ed_staff_employees';

type StaffRole = 'admin' | 'employee';

type StaffSession = {
  username: string;
  role: StaffRole;
};

type StaffProfileRow = {
  role: 'admin' | 'employee';
  active: boolean;
  email: string | null;
  name: string | null;
};

type StaffCreds = {
  adminPassword: string;
};

type LocalEmployeeRecord = {
  id: string;
  username: string;
  password: string;
  name?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type ManagedEmployee = {
  id: string;
  label: string;
  name: string | null;
  active: boolean;
  createdAt: string;
  source: 'local' | 'supabase';
};

type BillingProfileRow = {
  user_id: string;
  has_saved_payment_method: boolean;
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
};

type OrderMiniRow = {
  user_id: string | null;
  customer_email: string | null;
  created_at: string;
};

type AdminUserSummary = {
  userId: string;
  email: string;
  ordersCount: number;
  lastOrderAt: string;
  hasSavedPaymentMethod: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
};

const DEFAULT_STAFF_CREDS: StaffCreds = { adminPassword: 'admin123' };

interface AdminPortalProps {
  onExit: () => void;
}

export default function AdminPortal({ onExit }: AdminPortalProps) {
  const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<StaffSession | null>(null);
  const [creds, setCreds] = useState<StaffCreds>(DEFAULT_STAFF_CREDS);
  const [error, setError] = useState<string | null>(null);

  const [adminCurrent, setAdminCurrent] = useState('');
  const [adminNext, setAdminNext] = useState('');
  const [adminConfirm, setAdminConfirm] = useState('');

  const [showSecurity, setShowSecurity] = useState(false);
  const [showEmployees, setShowEmployees] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showOffers, setShowOffers] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const [employees, setEmployees] = useState<ManagedEmployee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [employeesQuery, setEmployeesQuery] = useState('');

  const [newEmpEmailOrUsername, setNewEmpEmailOrUsername] = useState('');
  const [newEmpPassword, setNewEmpPassword] = useState('');
  const [newEmpConfirm, setNewEmpConfirm] = useState('');
  const [newEmpName, setNewEmpName] = useState('');

  const [resetEmpId, setResetEmpId] = useState<string | null>(null);
  const [resetEmpPassword, setResetEmpPassword] = useState('');
  const [resetEmpConfirm, setResetEmpConfirm] = useState('');

  const [pricingDraft, setPricingDraft] = useState<Record<string, string>>({});
  const [distanceRateDraft, setDistanceRateDraft] = useState('');

  const [offers, setOffers] = useState<StaffOfferRow[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersActionLoading, setOffersActionLoading] = useState<string | null>(null);
  const [offersQuery, setOffersQuery] = useState('');
  const [offerAdminNotes, setOfferAdminNotes] = useState<Record<string, string>>({});

  const readLocalEmployees = (): LocalEmployeeRecord[] => {
    try {
      const raw = localStorage.getItem(STORAGE_EMPLOYEES);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (!Array.isArray(parsed)) return [];
      return (parsed as unknown[])
        .map((it) => {
          const r = it && typeof it === 'object' ? (it as Record<string, unknown>) : null;
          if (!r) return null;
          const id = String(r.id ?? '').trim();
          const username = String(r.username ?? '').trim();
          const password = String(r.password ?? '').trim();
          if (!id || !username || !password) return null;
          const createdAt = String(r.createdAt ?? '').trim() || new Date().toISOString();
          const updatedAt = String(r.updatedAt ?? '').trim() || createdAt;
          return {
            id,
            username,
            password,
            name: typeof r.name === 'string' ? String(r.name) : undefined,
            active: typeof r.active === 'boolean' ? r.active : true,
            createdAt,
            updatedAt,
          };
        })
        .filter(Boolean) as LocalEmployeeRecord[];
    } catch {
      return [];
    }
  };

  const writeLocalEmployees = (next: LocalEmployeeRecord[]) => {
    try {
      localStorage.setItem(STORAGE_EMPLOYEES, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const getAccessToken = async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  };

  const loadEmployees = async () => {
    if (!session || session.role !== 'admin') return;
    setEmployeesLoading(true);
    setError(null);
    try {
      if (isLocalDev) {
        const local = readLocalEmployees();
        const mapped: ManagedEmployee[] = local
          .map((e) => ({
            id: e.id,
            label: e.username,
            name: e.name ?? null,
            active: e.active,
            createdAt: e.createdAt,
            source: 'local' as const,
          }))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        setEmployees(mapped);
        return;
      }

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/.netlify/functions/manage-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_employees', access_token: token }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Failed to load employees');
      }
      const json = (await res.json().catch(() => null)) as { employees?: unknown } | null;
      const rows = Array.isArray(json?.employees) ? (json?.employees as unknown[]) : [];
      const mapped: ManagedEmployee[] = rows
        .map((it) => {
          const r = it && typeof it === 'object' ? (it as Record<string, unknown>) : null;
          if (!r) return null;
          const userId = String(r.user_id ?? '').trim();
          if (!userId) return null;
          const email = String(r.email ?? '').trim() || '-';
          const name = typeof r.name === 'string' ? String(r.name) : null;
          const createdAt = String(r.created_at ?? '').trim() || '';
          return {
            id: userId,
            label: email,
            name,
            active: Boolean(r.active),
            createdAt,
            source: 'supabase' as const,
          };
        })
        .filter(Boolean) as ManagedEmployee[];
      setEmployees(mapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load employees');
    } finally {
      setEmployeesLoading(false);
    }
  };

  const openEmployees = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    setEmployeesQuery('');
    setResetEmpId(null);
    setResetEmpPassword('');
    setResetEmpConfirm('');
    setNewEmpEmailOrUsername('');
    setNewEmpPassword('');
    setNewEmpConfirm('');
    setNewEmpName('');
    setShowEmployees(true);
    void loadEmployees();
  };

  const loadOffers = async () => {
    if (!session || session.role !== 'admin') return;
    setOffersLoading(true);
    setError(null);
    try {
      const rows = isLocalDev ? (listLocalPendingOffersAsStaff() as unknown as StaffOfferRow[]) : await listPendingOffersAsStaff();
      setOffers(rows);
      setOfferAdminNotes((prev) => {
        const next = { ...prev };
        for (const r of rows) {
          if (typeof next[r.id] !== 'string') next[r.id] = '';
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load offers');
    } finally {
      setOffersLoading(false);
    }
  };

  const openOffers = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    setOffersQuery('');
    setShowOffers(true);
    void loadOffers();
  };

  const resolveOffer = async (offer: StaffOfferRow, action: 'approved' | 'declined') => {
    if (!session || session.role !== 'admin') return;
    const adminNote = String(offerAdminNotes[offer.id] ?? '').trim() || null;
    setOffersActionLoading(offer.id);
    setMessage(null);
    setError(null);
    try {
      if (isLocalDev) {
        resolveLocalOfferAsStaff(offer.id, action, adminNote);
      } else {
        await updateOfferAsStaff(offer.id, action, adminNote);
        if (action === 'approved') {
          await updateOrderPricingAndStageAsStaff(offer.order_id, {
            final_price_before_tax: Number(offer.offer_amount),
            order_stage: 'pending_payment',
          });
        } else {
          await updateOrderPricingAndStageAsStaff(offer.order_id, {
            final_price_before_tax: null,
            order_stage: 'draft',
          });
        }
      }
      setMessage(action === 'approved' ? 'Offer approved.' : 'Offer declined.');
      await loadOffers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update offer');
    } finally {
      setOffersActionLoading(null);
    }
  };

  const createEmployee = async () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);

    const label = newEmpEmailOrUsername.trim();
    const pwd = newEmpPassword;
    const confirm = newEmpConfirm;
    const name = newEmpName.trim();

    if (!label) {
      setError(isLocalDev ? 'Username is required.' : 'Email is required.');
      return;
    }
    if (!pwd || pwd.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (pwd !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    try {
      if (isLocalDev) {
        const existing = readLocalEmployees();
        if (existing.some((e) => e.username === label)) {
          setError('Username already exists.');
          return;
        }
        const now = new Date().toISOString();
        const next: LocalEmployeeRecord = {
          id: `emp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          username: label,
          password: pwd,
          name: name || undefined,
          active: true,
          createdAt: now,
          updatedAt: now,
        };
        writeLocalEmployees([next, ...existing]);
        setMessage('Employee created.');
        await loadEmployees();
        return;
      }

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/.netlify/functions/manage-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_employee', access_token: token, email: label, password: pwd, name }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Failed to create employee');
      }
      setMessage('Employee created.');
      await loadEmployees();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create employee');
    }
  };

  const setEmployeeActive = async (emp: ManagedEmployee, active: boolean) => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    try {
      if (isLocalDev && emp.source === 'local') {
        const existing = readLocalEmployees();
        const next = existing.map((e) => (e.id === emp.id ? { ...e, active, updatedAt: new Date().toISOString() } : e));
        writeLocalEmployees(next);
        setMessage('Employee updated.');
        await loadEmployees();
        return;
      }

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/.netlify/functions/manage-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_employee_active', access_token: token, user_id: emp.id, active }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Failed to update employee');
      }
      setMessage('Employee updated.');
      await loadEmployees();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update employee');
    }
  };

  const resetEmployeePassword = async () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);

    const id = String(resetEmpId ?? '').trim();
    if (!id) return;
    if (!resetEmpPassword || resetEmpPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (resetEmpPassword !== resetEmpConfirm) {
      setError('Passwords do not match.');
      return;
    }

    try {
      const target = employees.find((e) => e.id === id) ?? null;
      if (isLocalDev && target?.source === 'local') {
        const existing = readLocalEmployees();
        const next = existing.map((e) =>
          e.id === id ? { ...e, password: resetEmpPassword, updatedAt: new Date().toISOString() } : e
        );
        writeLocalEmployees(next);
        setMessage('Password updated.');
        setResetEmpPassword('');
        setResetEmpConfirm('');
        setResetEmpId(null);
        return;
      }

      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/.netlify/functions/manage-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_employee_password', access_token: token, user_id: id, password: resetEmpPassword }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || 'Failed to reset password');
      }
      setMessage('Password updated.');
      setResetEmpPassword('');
      setResetEmpConfirm('');
      setResetEmpId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset password');
    }
  };

  const openPricing = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    const overrides = getPricingOverrides();
    const next: Record<string, string> = {};
    for (const row of OFFICIAL_CITY_TOTAL_PRICES) {
      const override = overrides[row.city];
      next[row.city] = Number.isFinite(override) ? String(override) : '';
    }
    setPricingDraft(next);
    const rate = getDistanceRatePerKm();
    setDistanceRateDraft(Number.isFinite(rate) ? String(rate) : String(DEFAULT_DISTANCE_RATE_PER_KM));
    setShowPricing(true);
  };

  const savePricing = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);

    const rawRate = String(distanceRateDraft ?? '').trim();
    if (rawRate) {
      const numRate = Number(rawRate);
      if (!Number.isFinite(numRate) || numRate <= 0) {
        setError('Invalid distance rate ($/km).');
        return;
      }
      setDistanceRatePerKm(numRate);
    } else {
      clearDistanceRatePerKm();
    }

    const next: Record<string, number> = {};
    for (const row of OFFICIAL_CITY_TOTAL_PRICES) {
      const raw = String(pricingDraft[row.city] ?? '').trim();
      if (!raw) continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) {
        setError(`Invalid price for ${row.city}.`);
        return;
      }
      next[row.city] = Math.round(num);
    }
    setPricingOverrides(next);
    setMessage('Pricing updated.');
  };

  const resetPricing = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    clearDistanceRatePerKm();
    clearPricingOverrides();
    const next: Record<string, string> = {};
    for (const row of OFFICIAL_CITY_TOTAL_PRICES) {
      next[row.city] = '';
    }
    setPricingDraft(next);
    setDistanceRateDraft(String(DEFAULT_DISTANCE_RATE_PER_KM));
    setMessage('Pricing reset to defaults.');
  };

  useEffect(() => {
    if (!session) return;

    const isOnAdminRoute = () => {
      try {
        const url = new URL(window.location.href);
        const hash = String(url.hash ?? '');
        const path = String(url.pathname ?? '');
        const adminHash = hash.startsWith('#/admin') || hash === '#admin' || hash.startsWith('#admin');
        const adminPath = path.endsWith('/admin');
        return Boolean(adminHash || adminPath);
      } catch {
        return false;
      }
    };

    const forceAdminRoute = () => {
      try {
        const url = new URL(window.location.href);
        if (!String(url.hash ?? '').startsWith('#/admin')) {
          url.hash = '#/admin';
          window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
        }
      } catch {
        // ignore
      }
    };

    const handler = () => {
      if (!session) return;
      if (isOnAdminRoute()) return;
      forceAdminRoute();
      setShowLogoutConfirm(true);
    };

    window.addEventListener('hashchange', handler);
    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('hashchange', handler);
      window.removeEventListener('popstate', handler);
    };
  }, [session]);

  useEffect(() => {
    try {
      const rawCreds = localStorage.getItem(STORAGE_STAFF_CREDS);
      const parsedCreds = rawCreds ? (JSON.parse(rawCreds) as unknown) : null;
      const obj = parsedCreds && typeof parsedCreds === 'object' ? (parsedCreds as Record<string, unknown>) : null;
      const adminPassword = typeof obj?.adminPassword === 'string' && String(obj.adminPassword).trim() ? String(obj.adminPassword) : DEFAULT_STAFF_CREDS.adminPassword;
      setCreds({ adminPassword });

      const rawSession = localStorage.getItem(STORAGE_STAFF_SESSION);
      const parsedSession = rawSession ? (JSON.parse(rawSession) as unknown) : null;
      const sessObj = parsedSession && typeof parsedSession === 'object' ? (parsedSession as Record<string, unknown>) : null;
      const role = String(sessObj?.role ?? '').trim() as StaffRole;
      const uname = String(sessObj?.username ?? '').trim();
      if ((role === 'admin' || role === 'employee') && uname) {
        setSession({ role, username: uname });
      } else {
        setSession(null);
      }
    } catch {
      setCreds(DEFAULT_STAFF_CREDS);
      setSession(null);
    }
  }, []);

  const logout = () => {
    if (!isLocalDev && supabase) {
      void supabase.auth.signOut();
    }
    try {
      localStorage.removeItem(STORAGE_STAFF_SESSION);
    } catch {
      // ignore
    }
    setMessage(null);
    setError(null);
    setAdminCurrent('');
    setAdminNext('');
    setAdminConfirm('');
    setUsername('');
    setPassword('');
    setShowSecurity(false);
    setShowEmployees(false);
    setShowPricing(false);
    setShowUsers(false);
    setShowOffers(false);
    setSession(null);
  };

  const login = async () => {
    setMessage(null);
    setError(null);
    const u = username.trim();
    const p = password;
    if (!u || !p) {
      setError('Enter email and password.');
      return;
    }

    if (isLocalDev) {
      if (u === 'admin' && p === creds.adminPassword) {
        const next: StaffSession = { username: 'admin', role: 'admin' };
        try {
          localStorage.setItem(STORAGE_STAFF_SESSION, JSON.stringify(next));
        } catch {
          // ignore
        }
        setPassword('');
        setSession(next);
        return;
      }

      const localEmployees = readLocalEmployees();
      const found = localEmployees.find((e) => e.active && e.username === u && e.password === p);
      if (found) {
        const next: StaffSession = { username: found.username, role: 'employee' };
        try {
          localStorage.setItem(STORAGE_STAFF_SESSION, JSON.stringify(next));
        } catch {
          // ignore
        }
        setPassword('');
        setSession(next);
        return;
      }

      setError('Incorrect username or password.');
      return;
    }

    if (!supabase) {
      setError('Admin access is currently unavailable.');
      return;
    }

    try {
      const email = u;
      if (!email.includes('@')) {
        setError('Enter email and password.');
        return;
      }

      const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password: p });
      if (authErr || !authData?.user?.id) {
        setError('Incorrect email or password.');
        return;
      }

      const { data: profile, error: profileErr } = await supabase
        .from('staff_profiles')
        .select('role, active, email, name')
        .eq('user_id', authData.user.id)
        .maybeSingle();

      if (profileErr) {
        setError(profileErr.message || 'This account is not authorized for staff access.');
        return;
      }

      if (!profile) {
        setError('This account is not authorized for staff access.');
        return;
      }

      const row = profile as StaffProfileRow;
      if (!row.active) {
        setError('This staff account is inactive.');
        return;
      }

      const role: StaffRole = row.role === 'admin' ? 'admin' : 'employee';
      const next: StaffSession = { username: u, role };
      try {
        localStorage.setItem(STORAGE_STAFF_SESSION, JSON.stringify(next));
      } catch {
        // ignore
      }
      setPassword('');
      setSession(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    }
  };

  const persistCreds = (next: StaffCreds) => {
    try {
      localStorage.setItem(STORAGE_STAFF_CREDS, JSON.stringify(next));
    } catch {
      // ignore
    }
    setCreds(next);
  };

  const changeAdminPassword = () => {
    setMessage(null);
    setError(null);
    if (!session || session.role !== 'admin') return;
    if (adminCurrent !== creds.adminPassword) {
      setError('Current admin password is incorrect.');
      return;
    }
    if (!adminNext.trim() || adminNext.length < 6) {
      setError('New admin password must be at least 6 characters.');
      return;
    }
    if (adminNext !== adminConfirm) {
      setError('New admin passwords do not match.');
      return;
    }
    persistCreds({ ...creds, adminPassword: adminNext });
    setAdminCurrent('');
    setAdminNext('');
    setAdminConfirm('');
    setMessage('Admin password updated.');
  };

  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersQuery, setUsersQuery] = useState('');

  const loadUsers = async () => {
    if (!supabase) return;
    setUsersLoading(true);
    setError(null);
    try {
      const { data: ordersData, error: ordersErr } = await supabase
        .from('orders')
        .select('user_id, customer_email, created_at')
        .not('user_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (ordersErr) throw ordersErr;

      const { data: billingData, error: billingErr } = await supabase
        .from('billing_profiles')
        .select('user_id, has_saved_payment_method, card_brand, card_last4, card_exp_month, card_exp_year');

      if (billingErr) throw billingErr;

      const orderRows = (Array.isArray(ordersData) ? ordersData : []) as OrderMiniRow[];
      const billingRows = (Array.isArray(billingData) ? billingData : []) as BillingProfileRow[];

      const ordersByUser = new Map<
        string,
        {
          email: string;
          ordersCount: number;
          lastOrderAt: string;
        }
      >();

      for (const row of orderRows) {
        const uid = typeof row.user_id === 'string' ? row.user_id : '';
        if (!uid) continue;
        const existing = ordersByUser.get(uid);
        if (!existing) {
          ordersByUser.set(uid, {
            email: typeof row.customer_email === 'string' && row.customer_email.trim() ? row.customer_email.trim() : '-',
            ordersCount: 1,
            lastOrderAt: String(row.created_at ?? '').trim(),
          });
        } else {
          existing.ordersCount += 1;
        }
      }

      const billingByUser = new Map<string, BillingProfileRow>();
      for (const row of billingRows) {
        if (row && typeof row.user_id === 'string' && row.user_id.trim()) {
          billingByUser.set(row.user_id.trim(), row);
        }
      }

      const ids = new Set<string>([...ordersByUser.keys(), ...billingByUser.keys()]);
      const next: AdminUserSummary[] = [];
      for (const id of ids) {
        const ord = ordersByUser.get(id);
        const bill = billingByUser.get(id);
        next.push({
          userId: id,
          email: ord?.email ?? '-',
          ordersCount: ord?.ordersCount ?? 0,
          lastOrderAt: ord?.lastOrderAt ?? '',
          hasSavedPaymentMethod: Boolean(bill?.has_saved_payment_method),
          cardBrand: bill?.card_brand ?? null,
          cardLast4: bill?.card_last4 ?? null,
          cardExpMonth: typeof bill?.card_exp_month === 'number' ? bill.card_exp_month : null,
          cardExpYear: typeof bill?.card_exp_year === 'number' ? bill.card_exp_year : null,
        });
      }

      next.sort((a, b) => {
        const atA = new Date(a.lastOrderAt).getTime();
        const atB = new Date(b.lastOrderAt).getTime();
        const safeA = Number.isFinite(atA) ? atA : 0;
        const safeB = Number.isFinite(atB) ? atB : 0;
        return safeB - safeA;
      });

      setUsers(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  };

  const openUsers = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    setUsersQuery('');
    setShowUsers(true);
    void loadUsers();
  };

  const openSecurity = () => {
    if (!session || session.role !== 'admin') return;
    setMessage(null);
    setError(null);
    setShowSecurity(true);
  };

  if (session) {
    return (
      <>
        {showLogoutConfirm && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center px-4"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setShowLogoutConfirm(false);
            }}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div className="relative w-full max-w-sm sm:max-w-md rounded-xl sm:rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
              <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100">
                <div className="text-base sm:text-lg font-semibold text-gray-900">Confirm logout</div>
                <div className="mt-1 text-xs sm:text-sm text-gray-600">You must log out before leaving the admin portal.</div>
              </div>
              <div className="px-4 sm:px-6 py-4 sm:py-5">
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={() => setShowLogoutConfirm(false)}
                    className="inline-flex justify-center rounded-lg sm:rounded-xl border border-gray-300 bg-white px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowLogoutConfirm(false);
                      logout();
                    }}
                    className="inline-flex justify-center rounded-lg sm:rounded-xl bg-gray-900 px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-600 text-white shrink-0">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm sm:text-base font-bold text-gray-900 truncate">Staff Portal</div>
                    <div className="text-xs text-gray-600 truncate">{session.role === 'admin' ? 'Admin' : 'Employee'} • {session.username}</div>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap justify-end">
                {session.role === 'admin' ? (
                  <>
                    <button
                      type="button"
                      onClick={openEmployees}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      <Users className="h-4 w-4" />
                      <span className="hidden sm:inline">Employees</span>
                    </button>
                    <button
                      type="button"
                      onClick={openUsers}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      <Users className="h-4 w-4" />
                      <span className="hidden sm:inline">Users</span>
                    </button>
                    <button
                      type="button"
                      onClick={openOffers}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      <Gavel className="h-4 w-4" />
                      <span className="hidden sm:inline">Offers</span>
                    </button>
                    <button
                      type="button"
                      onClick={openSecurity}
                      className="inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                    >
                      <KeyRound className="h-4 w-4" />
                      <span className="hidden sm:inline">Security</span>
                    </button>
                    <button
                      type="button"
                      onClick={openPricing}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      <Pencil className="h-4 w-4" />
                      <span className="hidden sm:inline">Pricing</span>
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirm(true)}
                  className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                >
                  <Lock className="h-4 w-4" />
                  Logout
                </button>
              </div>
            </div>
          </div>
        </div>

        {(showSecurity || showEmployees || showPricing || showUsers || showOffers) && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setShowSecurity(false);
                setShowEmployees(false);
                setShowPricing(false);
                setShowUsers(false);
                setShowOffers(false);
                setError(null);
                setMessage(null);
              }
            }}
          >
            <div className="absolute inset-0 bg-black/60" />
            <div
              className={
                showPricing
                  ? 'relative w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden'
                  : showEmployees
                    ? 'relative w-full max-w-3xl rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden'
                    : showUsers
                      ? 'relative w-full max-w-4xl rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden'
                      : showOffers
                        ? 'relative w-full max-w-4xl rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden'
                        : 'relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden'
              }
            >
              <div className="px-5 py-4 border-b border-gray-100">
                <div className="text-base font-bold text-gray-900">
                  {showEmployees ? 'Employees' : showUsers ? 'Users' : showOffers ? 'Offers' : showPricing ? 'Pricing' : 'Security'}
                </div>
                <div className="text-xs text-gray-600">Admin only</div>
              </div>

              <div className="p-5 space-y-4">
                {showEmployees ? (
                  <>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">Create employee</div>
                          <div className="mt-1 text-xs text-gray-600">
                            {isLocalDev ? 'Local accounts (saved in this browser).' : 'Supabase accounts (email/password).'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void createEmployee()}
                          disabled={employeesLoading}
                          className="inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <Plus className="h-4 w-4" />
                          Create
                        </button>
                      </div>

                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          value={newEmpEmailOrUsername}
                          onChange={(e) => setNewEmpEmailOrUsername(e.target.value)}
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          placeholder={isLocalDev ? 'Username' : 'Employee email'}
                        />
                        <input
                          value={newEmpName}
                          onChange={(e) => setNewEmpName(e.target.value)}
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          placeholder="Name (optional)"
                        />
                        <input
                          value={newEmpPassword}
                          onChange={(e) => setNewEmpPassword(e.target.value)}
                          type="password"
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          placeholder="Password (min 6 chars)"
                        />
                        <input
                          value={newEmpConfirm}
                          onChange={(e) => setNewEmpConfirm(e.target.value)}
                          type="password"
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          placeholder="Confirm password"
                        />
                      </div>
                    </div>

                    <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                      <div className="px-4 py-3 border-b border-gray-100">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-gray-900">Employees</div>
                            <div className="text-xs text-gray-600">Enable/disable and reset passwords.</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void loadEmployees()}
                            disabled={employeesLoading}
                            className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-800 hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {employeesLoading ? 'Loading...' : 'Refresh'}
                          </button>
                        </div>
                        <input
                          value={employeesQuery}
                          onChange={(e) => setEmployeesQuery(e.target.value)}
                          className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          placeholder="Search employees"
                        />
                      </div>
                      <div className="p-4 space-y-2 max-h-[45vh] overflow-auto">
                        {employees
                          .filter((e) => {
                            const q = employeesQuery.trim().toLowerCase();
                            if (!q) return true;
                            return (
                              String(e.label ?? '').toLowerCase().includes(q) ||
                              String(e.name ?? '').toLowerCase().includes(q)
                            );
                          })
                          .map((e) => (
                            <div
                              key={e.id}
                              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-gray-900 truncate">{e.label}</div>
                                <div className="text-xs text-gray-600 truncate">
                                  {(e.name || 'Employee') + ' • ' + (e.active ? 'active' : 'disabled')}
                                </div>
                              </div>
                              <div className="flex flex-col sm:flex-row gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEmployeeActive(e, !e.active)}
                                  className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                                >
                                  {e.active ? 'Disable' : 'Enable'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setResetEmpId(e.id);
                                    setResetEmpPassword('');
                                    setResetEmpConfirm('');
                                  }}
                                  className="inline-flex justify-center rounded-xl bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 transition-colors"
                                >
                                  Reset password
                                </button>
                              </div>
                            </div>
                          ))}
                        {employees.length === 0 ? <div className="text-sm text-gray-600">No employees yet.</div> : null}
                      </div>
                    </div>

                    {resetEmpId ? (
                      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                        <div className="text-sm font-semibold text-gray-900">Reset employee password</div>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            value={resetEmpPassword}
                            onChange={(e) => setResetEmpPassword(e.target.value)}
                            type="password"
                            className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                            placeholder="New password (min 6 chars)"
                          />
                          <input
                            value={resetEmpConfirm}
                            onChange={(e) => setResetEmpConfirm(e.target.value)}
                            type="password"
                            className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                            placeholder="Confirm new password"
                          />
                        </div>
                        <div className="mt-3 flex flex-col sm:flex-row gap-2">
                          <button
                            type="button"
                            onClick={() => void resetEmployeePassword()}
                            className="inline-flex justify-center rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                          >
                            Save password
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setResetEmpId(null);
                              setResetEmpPassword('');
                              setResetEmpConfirm('');
                            }}
                            className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}

                {showPricing ? (
                  <>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-sm font-semibold text-gray-900">Distance-based pricing</div>
                      <div className="mt-1 text-xs text-gray-600">Default rate: ${DEFAULT_DISTANCE_RATE_PER_KM}/km (admin can override).</div>
                      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="rounded-xl border border-gray-200 bg-white p-3">
                          <div className="text-xs font-semibold text-gray-700">Rate ($/km)</div>
                          <div className="mt-1 text-xs text-gray-500">Leave blank to reset to default.</div>
                          <input
                            value={distanceRateDraft}
                            onChange={(e) => setDistanceRateDraft(e.target.value)}
                            inputMode="decimal"
                            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                            placeholder={String(DEFAULT_DISTANCE_RATE_PER_KM)}
                          />
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-white p-3">
                          <div className="text-xs font-semibold text-gray-700">Minimum charge</div>
                          <div className="mt-1 text-xs text-gray-500">Applied to all quotes.</div>
                          <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800">$150</div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-sm font-semibold text-gray-900">Official city total prices</div>
                      <div className="mt-1 text-xs text-gray-600">Leave blank to use default. Changes apply immediately to quotes.</div>
                      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[45vh] overflow-auto">
                        {OFFICIAL_CITY_TOTAL_PRICES.map((row) => (
                          <div key={row.city} className="rounded-xl border border-gray-200 bg-white p-3">
                            <div className="text-xs font-semibold text-gray-700">{row.city}</div>
                            <div className="mt-1 text-xs text-gray-500">Default: ${row.total_price}</div>
                            <input
                              value={pricingDraft[row.city] ?? ''}
                              onChange={(e) => setPricingDraft((prev) => ({ ...prev, [row.city]: e.target.value }))}
                              inputMode="numeric"
                              className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                              placeholder="Override price (e.g., 435)"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2">
                      <button
                        type="button"
                        onClick={savePricing}
                        className="inline-flex justify-center rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                      >
                        Save pricing
                      </button>
                      <button
                        type="button"
                        onClick={resetPricing}
                        className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                      >
                        Reset to defaults
                      </button>
                    </div>
                  </>
                ) : null}

                {showUsers ? (
                  <>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">Customers / Dealers</div>
                          <div className="mt-1 text-xs text-gray-600">Saved card status and basic order counts.</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void loadUsers()}
                          disabled={usersLoading}
                          className="inline-flex justify-center rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {usersLoading ? 'Loading...' : 'Refresh'}
                        </button>
                      </div>

                      <input
                        value={usersQuery}
                        onChange={(e) => setUsersQuery(e.target.value)}
                        className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        placeholder="Search by email or user id"
                      />

                      <div className="mt-4 overflow-auto max-h-[50vh]">
                        <div className="min-w-[720px] grid grid-cols-12 gap-2 text-xs font-semibold text-gray-600 px-2 pb-2 border-b border-gray-200">
                          <div className="col-span-4">Email</div>
                          <div className="col-span-3">User ID</div>
                          <div className="col-span-2">Orders</div>
                          <div className="col-span-3">Saved card</div>
                        </div>
                        <div className="divide-y divide-gray-200">
                          {users
                            .filter((u) => {
                              const q = usersQuery.trim().toLowerCase();
                              if (!q) return true;
                              return String(u.email ?? '').toLowerCase().includes(q) || String(u.userId ?? '').toLowerCase().includes(q);
                            })
                            .map((u) => {
                              const exp =
                                u.hasSavedPaymentMethod && u.cardExpMonth && u.cardExpYear
                                  ? ` (exp ${String(u.cardExpMonth).padStart(2, '0')}/${String(u.cardExpYear)})`
                                  : '';
                              const safeCard = u.hasSavedPaymentMethod
                                ? `${String(u.cardBrand ?? '').toUpperCase() || 'CARD'} •••• ${String(u.cardLast4 ?? '')}${exp}`
                                : 'No';
                              return (
                                <div key={u.userId} className="grid grid-cols-12 gap-2 px-2 py-2 text-sm text-gray-800">
                                  <div className="col-span-4 truncate" title={u.email}>
                                    {u.email}
                                  </div>
                                  <div className="col-span-3 truncate" title={u.userId}>
                                    {u.userId}
                                  </div>
                                  <div className="col-span-2">{u.ordersCount}</div>
                                  <div className="col-span-3">
                                    <span
                                      className={
                                        u.hasSavedPaymentMethod
                                          ? 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100'
                                          : 'inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-200'
                                      }
                                    >
                                      {safeCard}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                {showOffers ? (
                  <>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">Pending offers</div>
                          <div className="mt-1 text-xs text-gray-600">Approve or decline customer offers (one active pending offer per order).</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void loadOffers()}
                          disabled={offersLoading}
                          className="inline-flex justify-center rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {offersLoading ? 'Loading...' : 'Refresh'}
                        </button>
                      </div>

                      <input
                        value={offersQuery}
                        onChange={(e) => setOffersQuery(e.target.value)}
                        className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                        placeholder="Search by order code or user id"
                      />

                      <div className="mt-4 overflow-auto max-h-[55vh]">
                        <div className="min-w-[920px] grid grid-cols-12 gap-2 text-xs font-semibold text-gray-600 px-2 pb-2 border-b border-gray-200">
                          <div className="col-span-2">Order</div>
                          <div className="col-span-3">User</div>
                          <div className="col-span-2">Base</div>
                          <div className="col-span-2">Offer</div>
                          <div className="col-span-3">Actions</div>
                        </div>

                        <div className="divide-y divide-gray-200">
                          {offers
                            .filter((o) => {
                              const q = offersQuery.trim().toLowerCase();
                              if (!q) return true;
                              const code = String(o.orders?.order_code ?? '').toLowerCase();
                              const uid = String(o.user_id ?? '').toLowerCase();
                              return code.includes(q) || uid.includes(q);
                            })
                            .map((o) => {
                              const orderCode = String(o.orders?.order_code ?? '').trim() || '-';
                              const base = Number(o.orders?.price_before_tax ?? 0);
                              const offerAmt = Number(o.offer_amount ?? 0);
                              const busy = offersActionLoading === o.id;
                              return (
                                <div key={o.id} className="grid grid-cols-12 gap-2 px-2 py-3 text-sm text-gray-800 items-start">
                                  <div className="col-span-2">
                                    <div className="font-semibold text-gray-900 truncate" title={orderCode}>
                                      {orderCode}
                                    </div>
                                    <div className="text-xs text-gray-500 truncate" title={String(o.order_id)}>
                                      {String(o.order_id).slice(0, 8)}…
                                    </div>
                                  </div>
                                  <div className="col-span-3">
                                    <div className="truncate" title={o.user_id}>
                                      {o.user_id}
                                    </div>
                                    <div className="text-xs text-gray-500 truncate" title={String(o.created_at)}>
                                      {new Date(o.created_at).toLocaleString()}
                                    </div>
                                  </div>
                                  <div className="col-span-2">{Number.isFinite(base) && base > 0 ? `$${base.toFixed(2)}` : '-'}</div>
                                  <div className="col-span-2 font-semibold text-gray-900">
                                    {Number.isFinite(offerAmt) && offerAmt > 0 ? `$${offerAmt.toFixed(2)}` : '-'}
                                  </div>
                                  <div className="col-span-3 space-y-2">
                                    <textarea
                                      value={String(offerAdminNotes[o.id] ?? '')}
                                      onChange={(e) => setOfferAdminNotes((prev) => ({ ...prev, [o.id]: e.target.value }))}
                                      rows={2}
                                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs"
                                      placeholder="Admin note (optional)"
                                    />
                                    <div className="flex flex-col sm:flex-row gap-2">
                                      <button
                                        type="button"
                                        onClick={() => void resolveOffer(o, 'approved')}
                                        disabled={busy || offersLoading}
                                        className="inline-flex justify-center rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                      >
                                        {busy ? 'Working...' : 'Approve'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void resolveOffer(o, 'declined')}
                                        disabled={busy || offersLoading}
                                        className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-800 hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                      >
                                        Decline
                                      </button>
                                    </div>
                                    {o.notes ? <div className="text-xs text-gray-600">Customer note: {o.notes}</div> : null}
                                  </div>
                                </div>
                              );
                            })}
                          {!offersLoading && offers.length === 0 ? (
                            <div className="px-2 py-4 text-sm text-gray-600">No pending offers right now.</div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                {showSecurity ? (
                  <>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="text-sm font-semibold text-gray-900">Change admin password</div>
                      <div className="mt-1 text-xs text-gray-600">Requires current admin password.</div>
                      <div className="mt-3 grid grid-cols-1 gap-2">
                        <input
                          value={adminCurrent}
                          onChange={(e) => setAdminCurrent(e.target.value)}
                          type="password"
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                          placeholder="Current admin password"
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            value={adminNext}
                            onChange={(e) => setAdminNext(e.target.value)}
                            type="password"
                            className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                            placeholder="New admin password"
                          />
                          <input
                            value={adminConfirm}
                            onChange={(e) => setAdminConfirm(e.target.value)}
                            type="password"
                            className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                            placeholder="Confirm new admin password"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={changeAdminPassword}
                          className="rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-700 transition-colors"
                        >
                          Update admin password
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                {message ? <div className="text-sm text-green-700">{message}</div> : null}
                {error ? <div className="text-sm text-red-700">{error}</div> : null}
              </div>

              <div className="px-5 py-4 border-t border-gray-100 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowSecurity(false);
                    setShowEmployees(false);
                    setShowPricing(false);
                    setShowUsers(false);
                    setShowOffers(false);
                    setError(null);
                    setMessage(null);
                  }}
                  className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        <AdminPanel onBack={() => {}} embedded role={session.role} />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-600 text-white">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <div className="text-xl font-bold text-gray-900">Staff Portal</div>
            <div className="text-sm text-gray-600">Admin & employee access</div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold text-gray-900">Staff login</div>
          <div className="mt-2 text-xs text-gray-600">Enter your staff credentials to continue.</div>

          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            type="text"
            className="mt-4 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
            placeholder={isLocalDev ? 'Username (admin or employee)' : 'Staff email'}
          />

          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
            placeholder="Password"
          />

          {error ? <div className="mt-3 text-sm text-red-700">{error}</div> : null}

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={onExit}
              className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            <button
              type="button"
              onClick={login}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
            >
              <Unlock className="h-4 w-4" />
              Enter
            </button>
          </div>
        </div>

        <div className="mt-4 text-xs text-gray-500">If you need access, contact the administrator for staff credentials.</div>
      </div>
    </div>
  );
}
