import { useEffect, useState } from 'react';
import HomePage from './components/HomePage';
import Dashboard from './components/Dashboard';
import AdminPortal from './components/AdminPortal';
import ChatBot from './components/ChatBot';
import { supabase } from './lib/supabaseClient';

const STORAGE_RECEIPTS_PENDING = 'ed_receipts_pending';
const PENDING_RECEIPT_PREFIX = 'ed_pending_receipt_order_';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [isAdminRoute, setIsAdminRoute] = useState(false);

  useEffect(() => {
    const compute = () => {
      try {
        const url = new URL(window.location.href);
        const hash = String(url.hash ?? '');
        const path = String(url.pathname ?? '');
        const adminHash = hash.startsWith('#/admin') || hash === '#admin' || hash.startsWith('#admin');
        const adminPath = path.endsWith('/admin');
        setIsAdminRoute(Boolean(adminHash || adminPath));
      } catch {
        setIsAdminRoute(false);
      }
    };

    compute();
    window.addEventListener('hashchange', compute);
    window.addEventListener('popstate', compute);
    return () => {
      window.removeEventListener('hashchange', compute);
      window.removeEventListener('popstate', compute);
    };
  }, []);

  useEffect(() => {
    const claimPaidReceiptFromUrl = () => {
      try {
        const url = new URL(window.location.href);
        const checkout = String(url.searchParams.get('checkout') ?? '').trim().toLowerCase();
        const order = String(url.searchParams.get('order') ?? '').trim();
        if (!order || checkout !== 'success') return;

        const pending = String(localStorage.getItem(`${PENDING_RECEIPT_PREFIX}${order}`) ?? '').trim();
        if (!pending) return;

        const persistToSupabase = async () => {
          if (!supabase) return;
          try {
            const { data } = await supabase.auth.getSession();
            const user = data?.session?.user;
            if (!user?.id) return;

            const { data: existing } = await supabase
              .from('receipts')
              .select('id')
              .eq('user_id', user.id)
              .eq('order_code', order)
              .limit(1);

            const exists = Array.isArray(existing) && existing.length > 0;
            if (exists) return;

            await supabase.from('receipts').insert({ user_id: user.id, order_code: order, text: pending });
          } catch {
            // ignore
          }
        };

        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          createdAt: new Date().toISOString(),
          text: pending,
        };

        const existingRaw = localStorage.getItem(STORAGE_RECEIPTS_PENDING);
        const existing = existingRaw ? (JSON.parse(existingRaw) as unknown) : [];
        const list = Array.isArray(existing) ? existing : [];
        localStorage.setItem(STORAGE_RECEIPTS_PENDING, JSON.stringify([entry, ...list]));
        localStorage.removeItem(`${PENDING_RECEIPT_PREFIX}${order}`);

        void persistToSupabase();

        url.searchParams.delete('checkout');
        url.searchParams.delete('order');
        const nextSearch = url.searchParams.toString();
        window.history.replaceState(null, '', `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}`);
      } catch {
        // ignore
      }
    };

    claimPaidReceiptFromUrl();

    const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';
    if (isLocalDev) {
      try {
        localStorage.setItem('ed_dev_auth', '1');
        window.dispatchEvent(new Event('ed_dev_auth_change'));
      } catch {
        // ignore
      }
      setIsLoggedIn(true);
      setAuthReady(true);
      return;
    }

    const client = supabase;

    if (!client) {
      setIsLoggedIn(false);
      setAuthReady(true);
      return;
    }

    let active = true;

    const initAuth = async () => {
      try {
        const currentUrl = new URL(window.location.href);
        const authCode = String(currentUrl.searchParams.get('code') ?? '').trim();
        const hash = String(window.location.hash ?? '');
        const hasAuthError = String(currentUrl.searchParams.get('error') ?? '').trim() !== '';

        if (authCode) {
          await client.auth.exchangeCodeForSession(authCode);

          try {
            currentUrl.searchParams.delete('code');
            currentUrl.searchParams.delete('error');
            currentUrl.searchParams.delete('error_description');
            currentUrl.hash = '';
            const nextSearch = currentUrl.searchParams.toString();
            window.history.replaceState(null, '', `${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ''}`);
          } catch {
            // ignore
          }
        } else if (hash.includes('access_token=') || hasAuthError) {
          let hasSessionFromUrl = false;

          if (hash.includes('access_token=')) {
            const pre = await client.auth.getSession();
            hasSessionFromUrl = Boolean(pre?.data?.session);

            if (!hasSessionFromUrl) {
              const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
              const access_token = params.get('access_token');
              const refresh_token = params.get('refresh_token');

              if (access_token && refresh_token) {
                await client.auth.setSession({ access_token, refresh_token });
                const post = await client.auth.getSession();
                hasSessionFromUrl = Boolean(post?.data?.session);
              }
            }
          }

          if (hasSessionFromUrl || hasAuthError) {
            try {
              const cleaned = new URL(window.location.href);
              cleaned.searchParams.delete('code');
              cleaned.searchParams.delete('error');
              cleaned.searchParams.delete('error_description');
              cleaned.hash = '';
              const nextSearch = cleaned.searchParams.toString();
              window.history.replaceState(null, '', `${cleaned.pathname}${nextSearch ? `?${nextSearch}` : ''}`);
            } catch {
              // ignore
            }
          }
        }

        const { data } = await client.auth.getSession();
        if (!active) return;
        setIsLoggedIn(Boolean(data?.session));
        setAuthReady(true);
      } catch {
        if (!active) return;
        setIsLoggedIn(false);
        setAuthReady(true);
      }
    };

    void initAuth();

    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setIsLoggedIn(Boolean(session));
      setAuthReady(true);
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  const handleLogin = () => {
    const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';
    if (isLocalDev) {
      try {
        localStorage.setItem('ed_dev_auth', '1');
      } catch {
        // ignore
      }
    }
    setIsLoggedIn(true);
  };

  const handleLogout = () => {
    const isLocalDev = import.meta.env.DEV && window.location.hostname === 'localhost';
    if (isLocalDev) {
      try {
        localStorage.removeItem('ed_dev_auth');
        window.dispatchEvent(new Event('ed_dev_auth_change'));
      } catch {
        // ignore
      }
    }
    setIsLoggedIn(false);
  };

  return (
    <>
      {isAdminRoute ? (
        <AdminPortal
          onExit={() => {
            try {
              const url = new URL(window.location.href);
              url.hash = '';
              window.history.replaceState(null, '', `${url.pathname}${url.search}`);
            } catch {
              // ignore
            }
            setIsAdminRoute(false);
          }}
        />
      ) : !authReady ? null : !isLoggedIn ? (
        <HomePage onLogin={handleLogin} />
      ) : (
        <Dashboard onLogout={handleLogout} />
      )}
      <ChatBot />
    </>
  );
}

export default App;
