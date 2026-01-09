import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Clipboard, CheckCircle, FileText, X, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

interface ReceiptHistoryProps {
  onBack: () => void;
  embed?: boolean; // when true, do not render the component's own header/nav so parent header stays visible
}

type ReceiptEntry = {
  id: string;
  createdAt: string;
  text: string;
};

type DocumentReceiptRow = {
  id?: unknown;
  created_at?: unknown;
  text?: unknown;
};

const STORAGE_RECEIPTS_PENDING = 'ed_receipts_pending';
const STORAGE_RECEIPTS_BY_USER_PREFIX = 'ed_receipts_by_user_';

const readLocalReceipts = (storageKey: string): ReceiptEntry[] => {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => {
        if (typeof r !== 'object' || r === null) return null;
        const obj = r as Record<string, unknown>;
        return {
          id: typeof obj.id === 'string' ? obj.id : String(obj.id ?? ''),
          createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : String(obj.createdAt ?? ''),
          text: typeof obj.text === 'string' ? obj.text : String(obj.text ?? ''),
        } as ReceiptEntry;
      })
      .filter((r): r is ReceiptEntry => Boolean(r?.id && r.text));
  } catch {
    return [];
  }
};

const writeLocalReceipts = (storageKey: string, next: ReceiptEntry[]) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // ignore
  }
};

const removeLocalReceiptById = (storageKey: string, id: string) => {
  const existing = readLocalReceipts(storageKey);
  const next = existing.filter((r) => r.id !== id);
  writeLocalReceipts(storageKey, next);
};

function extractReceiptPrice(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const amountRegex = /(?:\$|USD\s*)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i;
  const preferredLineRegex = /(total|amount|price|quote|rate|cost|grand\s*total)/i;

  for (const line of lines) {
    if (!preferredLineRegex.test(line)) continue;
    const match = line.match(amountRegex);
    if (!match) continue;

    const prefix = /\$/.test(line) ? '$' : /\bUSD\b/i.test(line) ? 'USD ' : '$';
    return `${prefix}${match[1]}`;
  }

  for (const line of lines) {
    const match = line.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/);
    if (match) return `$${match[1]}`;
  }

  for (const line of lines) {
    const match = line.match(/\bUSD\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/i);
    if (match) return `USD ${match[1]}`;
  }

  return null;
}

export default function ReceiptHistory({ onBack, embed = false }: ReceiptHistoryProps) {
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [receiptCopied, setReceiptCopied] = useState(false);
  const [receiptsVersion, setReceiptsVersion] = useState(0);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<ReceiptEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [localReceiptsCount, setLocalReceiptsCount] = useState(0);

  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userKey, setUserKey] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setUserEmail(null);
      setUserKey(null);
      return;
    }

    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        const user = data?.session?.user;
        setUserEmail(user?.email ?? null);
        setUserKey(user?.id ?? user?.email ?? null);
      })
      .catch(() => {
        if (!active) return;
        setUserEmail(null);
        setUserKey(null);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      setUserEmail(user?.email ?? null);
      setUserKey(user?.id ?? user?.email ?? null);
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const localKey = userKey ? `${STORAGE_RECEIPTS_BY_USER_PREFIX}${userKey}` : null;

    // Load local receipts first (works even if the user is logged out).
    const localUserReceipts = localKey ? readLocalReceipts(localKey) : [];
    const localPendingReceipts = readLocalReceipts(STORAGE_RECEIPTS_PENDING);

    // If user is signed in, automatically claim pending receipts into the user's local bucket.
    if (localKey && localPendingReceipts.length > 0) {
      const existingIds = new Set(localUserReceipts.map((r) => r.id));
      const merged = [...localPendingReceipts.filter((r) => !existingIds.has(r.id)), ...localUserReceipts];
      writeLocalReceipts(localKey, merged);
      writeLocalReceipts(STORAGE_RECEIPTS_PENDING, []);
    }

    const effectiveLocal = localKey ? readLocalReceipts(localKey) : localPendingReceipts;
    setLocalReceiptsCount(effectiveLocal.length);
    setReceipts(effectiveLocal);

    if (!userEmail) {
      setIsLoading(false);
      setLoadError(effectiveLocal.length ? null : 'Please sign in to sync receipts across devices.');
      return;
    }
    if (!supabase) {
      setIsLoading(false);
      setLoadError(effectiveLocal.length ? null : 'Supabase is not configured. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
      return;
    }
    if (!userKey) {
      setIsLoading(false);
      setLoadError(effectiveLocal.length ? null : 'Please sign in to sync receipts across devices.');
      return;
    }

    const sb = supabase;

    let isMounted = true;
    const run = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const { data, error } = await sb
          .from('receipts')
          .select('id, created_at, text')
          .eq('user_id', userKey)
          .order('created_at', { ascending: false });

        if (error) throw error;

        const remote = (Array.isArray(data) ? data : [])
          .map((row: DocumentReceiptRow) => ({
            id: String(row?.id ?? ''),
            createdAt: String(row?.created_at ?? new Date().toISOString()),
            text: String(row?.text ?? ''),
          }))
          .filter((r) => r.id && r.text);

        const localNow = localKey ? readLocalReceipts(localKey) : [];
        const dedup = new Map<string, ReceiptEntry>();
        for (const r of [...remote, ...localNow]) dedup.set(r.id, r);
        const next = Array.from(dedup.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

        if (isMounted) setReceipts(next);
      } catch (err) {
        if (!isMounted) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load receipts');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    run();
    return () => {
      isMounted = false;
    };
  }, [userEmail, userKey, receiptsVersion]);

  const syncLocalReceipts = async () => {
    if (!supabase || !userKey) return;
    const localKey = `${STORAGE_RECEIPTS_BY_USER_PREFIX}${userKey}`;
    const local = readLocalReceipts(localKey);
    if (!local.length) return;
    setSyncing(true);
    try {
      const payload = local.map((r) => ({ user_id: userKey, text: r.text }));
      const { error } = await supabase.from('receipts').insert(payload);
      if (error) throw error;
      writeLocalReceipts(localKey, []);
      setReceiptsVersion((v) => v + 1);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to sync receipts');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    try {
      const openId = String(localStorage.getItem('ed_open_receipt_id') ?? '').trim();
      if (!openId) return;
      if (!receipts.some((r) => r.id === openId)) return;
      setSelectedReceiptId(openId);
      setReceiptCopied(false);
      localStorage.removeItem('ed_open_receipt_id');
    } catch {
      // ignore
    }
  }, [receipts]);

  const selectedReceipt = useMemo(() => {
    if (!selectedReceiptId) return null;
    return receipts.find((r) => r.id === selectedReceiptId) ?? null;
  }, [receipts, selectedReceiptId]);

  const deleteReceiptConfirmed = async (id: string) => {
    const localKey = userKey ? `${STORAGE_RECEIPTS_BY_USER_PREFIX}${userKey}` : null;
    if (localKey) removeLocalReceiptById(localKey, id);
    removeLocalReceiptById(STORAGE_RECEIPTS_PENDING, id);

    if (userKey && supabase) {
      try {
        const { error } = await supabase.from('receipts').delete().eq('id', id).eq('user_id', userKey);
        if (error) throw error;
      } catch {
        // ignore
      }
    }

    if (selectedReceiptId === id) {
      setSelectedReceiptId(null);
      setReceiptCopied(false);
    }
    setReceiptsVersion((v) => v + 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-cyan-50/30 to-gray-50">
      {embed ? null : (
        <nav className="bg-white/80 backdrop-blur-md shadow-lg border-b border-gray-200/50 sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap justify-between items-center gap-3 py-3">
              <div className="flex items-center space-x-3">
                <img
                  src="/logoclick.png"
                  alt="NORTHLINE"
                  className="h-9 w-auto"
                />
              </div>
              <button
                onClick={onBack}
                className="flex items-center space-x-2 px-4 py-2 rounded-xl text-gray-700 hover:text-cyan-600 hover:bg-cyan-50 transition-all duration-200 font-medium"
              >
                <ArrowLeft className="w-5 h-5" />
                <span className="hidden sm:inline">Back to Dashboard</span>
              </button>
            </div>
          </div>
        </nav>
      )}

      {deleteTargetId && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleteTargetId(null);
          }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-gray-900/95 text-white shadow-2xl">
            <div className="px-6 py-5">
              <div className="text-sm font-semibold text-white">Delete this receipt?</div>
              <div className="mt-1 text-xs text-white/70">This action cannot be undone.</div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <button
                type="button"
                onClick={() => setDeleteTargetId(null)}
                className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteReceiptConfirmed(deleteTargetId);
                  setDeleteTargetId(null);
                }}
                className="inline-flex items-center justify-center rounded-xl bg-red-500 px-4 py-2 text-xs font-semibold text-white hover:bg-red-400 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedReceipt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedReceiptId(null);
              setReceiptCopied(false);
            }
          }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

          <div className="relative w-full max-w-3xl overflow-hidden rounded-3xl border border-white/10 bg-white shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)]">
            <div className="flex items-center justify-between gap-4 bg-gradient-to-r from-cyan-500 via-sky-500 to-blue-600 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/20">
                  <FileText className="h-5 w-5 text-white" />
                </div>
                <div>
                  <div className="text-lg font-bold text-white">Receipt Details</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs font-medium text-white/85">
                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-white/15">
                      <CheckCircle className="h-3 w-3 text-white" />
                    </div>
                    Created: {new Date(selectedReceipt.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTargetId(selectedReceipt.id)}
                  title="Delete receipt"
                  aria-label="Delete receipt"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20 text-white hover:bg-white/20 transition-colors"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(selectedReceipt.text);
                      setReceiptCopied(true);
                      window.setTimeout(() => setReceiptCopied(false), 1500);
                    } catch {
                      setReceiptCopied(false);
                    }
                  }}
                  title={receiptCopied ? 'Copied' : 'Copy receipt'}
                  aria-label={receiptCopied ? 'Copied' : 'Copy receipt'}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20 text-white hover:bg-white/20 transition-colors"
                >
                  {receiptCopied ? <CheckCircle className="h-5 w-5" /> : <Clipboard className="h-5 w-5" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedReceiptId(null);
                    setReceiptCopied(false);
                  }}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20 text-white hover:bg-white/20 transition-colors"
                  aria-label="Close"
                  title="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="p-6 sm:p-7">
              <pre className="whitespace-pre-wrap text-sm leading-7 text-gray-800 max-h-[70vh] overflow-auto rounded-2xl border-2 border-gray-200 bg-gradient-to-br from-gray-50 to-white p-5 sm:p-7 shadow-inner font-mono">
                {selectedReceipt.text}
              </pre>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
        <div className="mb-6 sm:mb-10">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-cyan-600 shadow-xl shadow-cyan-500/30">
              <FileText className="h-7 w-7 text-white" />
            </div>
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-gray-900 via-gray-800 to-gray-700 bg-clip-text text-transparent">Receipt History</h1>
              <p className="mt-1 text-sm sm:text-base text-gray-600">View and manage your submission receipts</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:gap-8">
          <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-xl border border-gray-200/50 overflow-hidden transition-all duration-300 hover:shadow-2xl">
            <div className="p-5 sm:p-6 bg-gradient-to-r from-cyan-50 to-cyan-100/50 border-b border-cyan-200/50">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="text-lg font-bold text-gray-900">All Receipts</div>
                <div className="flex items-center gap-3">
                  {userEmail && supabase && localReceiptsCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => void syncLocalReceipts()}
                      disabled={syncing}
                      className="inline-flex items-center rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-60"
                      title="Upload local receipts to your account"
                    >
                      {syncing ? 'Syncing…' : `Sync ${localReceiptsCount} local`}
                    </button>
                  ) : null}
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-500 text-xs font-bold text-white shadow-lg shadow-cyan-500/30">{receipts.length}</div>
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-6">
              {isLoading ? (
                <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 p-6 text-center">
                  <div className="text-sm font-medium text-gray-700">Loading receipts…</div>
                </div>
              ) : loadError ? (
                <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 p-6 text-center">
                  <p className="text-sm font-medium text-gray-700">{loadError}</p>
                </div>
              ) : receipts.length === 0 ? (
                <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 p-6 text-center">
                  <FileText className="mx-auto h-10 w-10 text-gray-400 mb-3" />
                  <p className="text-sm font-medium text-gray-700">No receipts yet</p>
                  <p className="mt-1 text-xs text-gray-500">Submit a document to generate your first receipt</p>
                </div>
              ) : (
                <div className="max-h-[calc(100vh-20rem)] overflow-auto rounded-xl space-y-2">
                  {receipts.map((r, idx) => (
                    <div
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedReceiptId(r.id);
                        setReceiptCopied(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedReceiptId(r.id);
                          setReceiptCopied(false);
                        }
                      }}
                      className={`w-full text-left px-4 py-4 rounded-xl border transition-all duration-200 ${
                        selectedReceiptId === r.id
                          ? 'bg-gradient-to-r from-cyan-50 to-cyan-100/50 border-cyan-300 shadow-lg shadow-cyan-500/10 scale-[1.02]'
                          : 'bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300 hover:shadow-md'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2">
                          <div className={`flex h-6 w-6 items-center justify-center rounded-lg text-xs font-bold ${
                            selectedReceiptId === r.id ? 'bg-cyan-500 text-white' : 'bg-gray-200 text-gray-600'
                          }`}>
                            {idx + 1}
                          </div>
                          <div className="text-sm font-bold text-gray-900">Receipt</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-xs font-medium text-gray-500">
                            {new Date(r.createdAt).toLocaleDateString()}
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDeleteTargetId(r.id);
                            }}
                            title="Delete receipt"
                            aria-label="Delete receipt"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-lg font-extrabold text-cyan-700">
                          {extractReceiptPrice(r.text) ?? '-'}
                        </div>
                        <div className="text-[11px] font-medium text-gray-500">Tap to view</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
