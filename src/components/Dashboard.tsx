import { useEffect, useMemo, useState } from 'react';
import { FileText, LogOut, Package, Clock, Home } from 'lucide-react';
import FileUploadSection from './FileUploadSection';
import { supabase } from '../lib/supabaseClient';
import LocalOrders from './LocalOrders';
import ReceiptHistory from './ReceiptHistory';

type CheckoutDraft = {
  id: string;
  createdAt: string;
  formData: unknown;
  costData: unknown;
  docCount: number;
};

 const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

 const readNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

interface DashboardProps {
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [isDeleteDraftOpen, setIsDeleteDraftOpen] = useState(false);
  const [deleteDraftId, setDeleteDraftId] = useState<string | null>(null);
  const [accountLabel, setAccountLabel] = useState('Account');
  const [accountName, setAccountName] = useState('');
  const [accountAvatarUrl, setAccountAvatarUrl] = useState<string | null>(null);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [showReceiptHistory, setShowReceiptHistory] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  const [isDraftsOpen, setIsDraftsOpen] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const [drafts, setDrafts] = useState<CheckoutDraft[]>([]);

  const loadDrafts = () => {
    try {
      const raw = localStorage.getItem('ed_checkout_drafts');
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      setDrafts(Array.isArray(parsed) ? (parsed as CheckoutDraft[]) : []);
    } catch {
      setDrafts([]);
    }
  };

  const requestDeleteDraft = (id: string) => {
    setDeleteDraftId(id);
    setIsDeleteDraftOpen(true);
  };

  const clearUploadDraft = () => {
    try {
      localStorage.removeItem('ed_extractedFormData');
      localStorage.removeItem('ed_submitMessage');
      localStorage.removeItem('ed_submitError');
    } catch {
      // ignore
    }
  };

  const deleteDraft = (id: string) => {
    const next = drafts.filter((d) => d.id !== id);
    setDrafts(next);
    try {
      localStorage.setItem('ed_checkout_drafts', JSON.stringify(next));
    } catch {
      // ignore
    }

    try {
      window.dispatchEvent(new CustomEvent('ed_draft_deleted', { detail: { id } }));
    } catch {
      // ignore
    }

    try {
      window.dispatchEvent(new Event('ed_drafts_updated'));
    } catch {
      // ignore
    }
  };

  const resumeDraft = (draft: CheckoutDraft) => {
    setShowOrders(false);
    setShowReceiptHistory(false);
    setShowDrafts(false);
    try {
      window.setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent('ed_resume_draft', { detail: draft }));
        } catch {
          // ignore
        }
      }, 60);
    } catch {
      // ignore
    }
    setIsDraftsOpen(false);
  };

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!active) return;
        const email = String(data?.user?.email ?? '').trim();
        const meta = (data?.user?.user_metadata ?? null) as unknown;
        const metaObj = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
        const name = String(metaObj?.name ?? '').trim();
        const avatar = String(metaObj?.avatar_url ?? metaObj?.picture ?? '').trim();
        setAccountLabel(email || 'Account');
        setAccountName(name);
        setAccountAvatarUrl(avatar || null);
      })
      .catch(() => {
        if (!active) return;
        setAccountLabel('Account');
        setAccountName('');
        setAccountAvatarUrl(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    loadDrafts();
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'ed_checkout_drafts') loadDrafts();
    };
    const onDraftsUpdated = () => loadDrafts();
    window.addEventListener('storage', onStorage);
    window.addEventListener('ed_drafts_updated', onDraftsUpdated);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('ed_drafts_updated', onDraftsUpdated);
    };
  }, []);

  useEffect(() => {
    const onOpenReceipts = () => {
      setShowOrders(false);
      setShowReceiptHistory(true);
    };
    window.addEventListener('ed_open_receipts', onOpenReceipts);
    return () => {
      window.removeEventListener('ed_open_receipts', onOpenReceipts);
    };
  }, []);

  const accountLabelText = useMemo(() => accountLabel, [accountLabel]);


  const handleLogout = () => {
    clearUploadDraft();
    try {
      localStorage.removeItem('ed_open_receipt_id');
    } catch {
      // ignore
    }
    if (supabase) {
      void supabase.auth.signOut();
    }
    onLogout();
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {isDraftsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setIsDraftsOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
          <div className="relative w-full max-w-xl max-h-[85vh] rounded-xl sm:rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden flex flex-col">
            <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100">
              <div className="text-base sm:text-lg font-semibold text-gray-900">Drafts</div>
              <div className="mt-1 text-xs sm:text-sm text-gray-600">Pending payments saved from checkout</div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5">
              {drafts.length === 0 ? (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">No drafts yet.</div>
              ) : (
                <div className="space-y-3">
                  {drafts.map((d) => {
                    const created = new Date(d.createdAt);

                    const costData = isRecord(d.costData) ? d.costData : null;
                    const formData = isRecord(d.formData) ? d.formData : null;

                    const pricingCity = costData && typeof costData.pricingCity === 'string' ? costData.pricingCity : null;
                    const dropoffLocation = formData && isRecord(formData.dropoff_location) ? formData.dropoff_location : null;
                    const serviceArea = dropoffLocation && typeof dropoffLocation.service_area === 'string' ? dropoffLocation.service_area : null;

                    const label =
                      pricingCity ? String(pricingCity) : serviceArea ? String(serviceArea) : '-';

                    const costValue = costData && typeof costData.cost === 'number' ? costData.cost : null;
                    const total =
                      typeof costValue === 'number' && Number.isFinite(costValue)
                        ? `$${costValue}`
                        : '';
                    return (
                      <div key={d.id} className="rounded-xl border border-gray-200 bg-white p-4">
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-gray-900">{label}</div>
                            <div className="mt-1 text-xs text-gray-600">
                              Saved: {Number.isFinite(created.getTime()) ? created.toLocaleString() : d.createdAt}
                            </div>
                            <div className="mt-2 text-sm text-gray-700">
                              {total ? `Subtotal: ${total}` : 'Subtotal: -'}
                            </div>
                            <div className="mt-1 text-xs text-gray-500">Documents: {Number(d.docCount) || 0}</div>
                          </div>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <button
                              type="button"
                              onClick={() => resumeDraft(d)}
                              className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                            >
                              Resume
                            </button>
                            <button
                              type="button"
                              onClick={() => requestDeleteDraft(d.id)}
                              className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="border-t border-gray-200 bg-white p-4">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsDraftsOpen(false)}
                  className="inline-flex justify-center rounded-lg sm:rounded-xl border border-gray-300 bg-white px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isLogoutOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setIsLogoutOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
          <div className="relative w-full max-w-sm sm:max-w-md rounded-xl sm:rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
            <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100">
              <div className="text-base sm:text-lg font-semibold text-gray-900">Confirm logout</div>
              <div className="mt-1 text-xs sm:text-sm text-gray-600">Are you sure you want to log out of {accountLabelText}?</div>
            </div>
            <div className="px-4 sm:px-6 py-4 sm:py-5">
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={() => setIsLogoutOpen(false)}
                  className="inline-flex justify-center rounded-lg sm:rounded-xl border border-gray-300 bg-white px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsLogoutOpen(false);
                    handleLogout();
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

      {isDeleteDraftOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setIsDeleteDraftOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
          <div className="relative w-full max-w-sm sm:max-w-md rounded-xl sm:rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
            <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100">
              <div className="text-base sm:text-lg font-semibold text-gray-900">Delete draft?</div>
              <div className="mt-1 text-xs sm:text-sm text-gray-600">This will remove it from Drafts and delete any saved file(s).</div>
            </div>
            <div className="px-4 sm:px-6 py-4 sm:py-5">
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setIsDeleteDraftOpen(false);
                    setDeleteDraftId(null);
                  }}
                  className="inline-flex justify-center rounded-lg sm:rounded-xl border border-gray-300 bg-white px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = deleteDraftId;
                    setIsDeleteDraftOpen(false);
                    setDeleteDraftId(null);
                    if (id) deleteDraft(id);
                  }}
                  className="inline-flex justify-center rounded-lg sm:rounded-xl bg-red-600 px-4 py-2 sm:py-2.5 text-xs sm:text-sm font-semibold text-white hover:bg-red-700 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAccountMenuOpen && (
        <div
          className="fixed inset-0 z-40"
          onPointerDown={() => {
            setIsAccountMenuOpen(false);
          }}
        />
      )}
      <nav className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-2">
              <img
                src="/logoclick.png"
                alt="NORTHLINE"
                className="h-9 w-auto"
              />
            </div>
            <div className="flex items-center gap-1 sm:gap-2 md:gap-4 overflow-x-auto sm:overflow-visible whitespace-nowrap touch-pan-x">
              <button
                type="button"
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  setShowOrders(false);
                  setShowReceiptHistory(false);
                  setShowDrafts(false);
                }}
                className="flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3 py-2 rounded-lg text-gray-600 hover:text-cyan-500 hover:bg-cyan-50 transition-all"
              >
                <Home className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline text-sm">Home</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  setShowOrders(true);
                  setShowReceiptHistory(false);
                  setShowDrafts(false);
                }}
                className="flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3 py-2 rounded-lg text-gray-600 hover:text-cyan-500 hover:bg-cyan-50 transition-all"
              >
                <Package className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline text-sm">Tracking</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  setShowReceiptHistory(true);
                  setShowOrders(false);
                  setShowDrafts(false);
                }}
                className="flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3 py-2 rounded-lg text-gray-600 hover:text-cyan-500 hover:bg-cyan-50 transition-all"
              >
                <FileText className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline text-sm">Receipts</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  loadDrafts();
                  setShowDrafts(true);
                  setShowReceiptHistory(false);
                  setShowOrders(false);
                }}
                className="flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3 py-2 rounded-lg text-gray-600 hover:text-cyan-500 hover:bg-cyan-50 transition-all"
              >
                <Clock className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline text-sm">Drafts</span>
                {drafts.length ? (
                  <span className="ml-1 inline-flex items-center justify-center rounded-full bg-gray-900 text-white text-[10px] font-semibold px-2 py-0.5">
                    {drafts.length}
                  </span>
                ) : null}
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsAccountMenuOpen((v) => !v)}
                  className="flex items-center gap-2 px-2 sm:px-3 py-2 rounded-lg text-gray-600 hover:text-cyan-500 hover:bg-cyan-50 transition-all shrink-0"
                  aria-haspopup="menu"
                  aria-expanded={isAccountMenuOpen}
                >
                  {accountAvatarUrl ? (
                    <img
                      src={accountAvatarUrl}
                      alt="Account"
                      className="h-7 w-7 rounded-full object-cover border border-gray-200"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 text-gray-700 text-xs font-semibold border border-gray-300">
                      {String(accountName || accountLabelText || 'A').trim().slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="hidden sm:inline text-sm">Account</span>
                </button>

                {isAccountMenuOpen && (
                  <div
                    role="menu"
                    className="fixed sm:absolute right-4 sm:right-0 top-16 sm:top-full mt-2 w-[calc(100vw-2rem)] sm:w-72 rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden z-50"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    <div className="px-4 py-3 border-b border-gray-100">
                      <div className="flex items-center gap-3">
                        {accountAvatarUrl ? (
                          <img
                            src={accountAvatarUrl}
                            alt="Account"
                            className="h-10 w-10 rounded-full object-cover border border-gray-200"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-gray-200 text-gray-700 text-sm font-semibold border border-gray-300">
                            {String(accountName || accountLabelText || 'A').trim().slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-gray-900 truncate">{accountName || 'Account'}</div>
                          <div className="text-xs text-gray-600 truncate">{accountLabelText}</div>
                        </div>
                      </div>
                    </div>

                    <div className="p-2">
                      <button
                        type="button"
                        onClick={() => {
                          setIsAccountMenuOpen(false);
                          setIsLogoutOpen(true);
                        }}
                        className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        <LogOut className="h-4 w-4" />
                        Logout
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div className="flex-1 w-full">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
          {showReceiptHistory ? (
            <ReceiptHistory embed onBack={() => setShowReceiptHistory(false)} />
          ) : showOrders ? (
            <LocalOrders embed onBack={() => setShowOrders(false)} />
          ) : showDrafts ? (
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm">
              <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100 flex items-center justify-start">
                <div>
                  <div className="text-base sm:text-lg font-semibold text-gray-900">Drafts</div>
                  <div className="text-xs sm:text-sm text-gray-600">Pending payments saved from checkout</div>
                </div>
              </div>
              <div className="px-4 sm:px-6 py-4 sm:py-5">
                {drafts.length === 0 ? (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">No drafts yet.</div>
                ) : (
                  <div className="space-y-3">
                    {drafts.map((d) => {
                      const created = new Date(d.createdAt);
                      const costData = isRecord(d.costData) ? (d.costData as Record<string, unknown>) : null;
                      const formData = isRecord(d.formData) ? (d.formData as Record<string, unknown>) : null;
                      const pricingCity = costData && typeof costData.pricingCity === 'string' ? costData.pricingCity : null;
                      const dropoffLocation = formData && isRecord(formData.dropoff_location) ? (formData.dropoff_location as Record<string, unknown>) : null;
                      const serviceArea = dropoffLocation && typeof dropoffLocation.service_area === 'string' ? dropoffLocation.service_area : null;
                      const label = pricingCity ? String(pricingCity) : serviceArea ? String(serviceArea) : '-';
                      const costValue = costData ? readNumber(costData.cost) : NaN;
                      const total = Number.isFinite(costValue) ? `$${costValue}` : '';
                      return (
                        <div
                          key={d.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => resumeDraft(d)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              resumeDraft(d);
                            }
                          }}
                          className="rounded-xl border border-gray-200 bg-white p-4 cursor-pointer hover:border-cyan-300 hover:shadow-sm transition-colors"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-gray-900">{label}</div>
                              <div className="mt-1 text-xs text-gray-600">Saved: {Number.isFinite(created.getTime()) ? created.toLocaleString() : d.createdAt}</div>
                              <div className="mt-2 text-sm text-gray-700">{total ? `Subtotal: ${total}` : 'Subtotal: -'}</div>
                              <div className="mt-1 text-xs text-gray-500">Documents: {Number(d.docCount) || 0}</div>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  resumeDraft(d);
                                }}
                                className="inline-flex justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
                              >
                                Resume
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestDeleteDraft(d.id);
                                }}
                                className="inline-flex justify-center rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-white border border-gray-200 shadow-sm p-4 sm:p-6">
              <FileUploadSection
                onContinueToSignIn={() => {
                  setIsLogoutOpen(true);
                }}
              />
            </div>
          )}
        </div>
      </div>

      <footer className="hidden md:block bg-white text-gray-700 border-t border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <div className="text-base font-semibold text-gray-900">Northline Auto Transport</div>
              <div className="mt-1 inline-flex items-center gap-2 text-sm text-gray-600">
                <span>Powered by</span>
                <img src="/EDC.png" alt="EDC" className="h-5 w-auto" />
              </div>
            </div>
            <div className="text-sm text-gray-600 md:text-right">
              <div>Fast vehicle transport quotes and secure checkout.</div>
              <div className="mt-1">&copy; {new Date().getFullYear()} Northline Auto Transport. All rights reserved.</div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
