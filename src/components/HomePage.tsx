import { useCallback, useEffect, useState } from 'react';
import { Truck, Package, MapPin, Clock, CheckCircle, ArrowRight, X, Menu } from 'lucide-react';
import FileUploadSection from './FileUploadSection';
import { supabase } from '../lib/supabaseClient';

interface HomePageProps {
  onLogin: () => void;
}

export default function HomePage({ onLogin }: HomePageProps) {
  const [isSignInOpen, setIsSignInOpen] = useState(false);
  const [gisError, setGisError] = useState<string | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const [activeServiceArea, setActiveServiceArea] = useState<'ontario' | 'quebec' | null>(null);

  const serviceAreaCities = {
    ontario: [
      'Toronto (Oshawa Region)',
      'Toronto (Downtown / Brampton / Mississauga)',
      'Hamilton',
      'Niagara Falls',
      'Windsor',
      'London',
      'Kingston',
      'Belleville',
      'Cornwall',
      'Peterborough',
      'Barrie',
      'North Bay',
      'Timmins',
    ],
    quebec: ['Montreal', 'Montreal (Trois-Rivières Region)', 'Quebec City'],
  } as const;

  const startGoogleLogin = useCallback(async () => {
    if (import.meta.env.DEV && window.location.hostname === 'localhost') {
      setGisError(null);
      onLogin();
      setIsSignInOpen(false);
      return;
    }

    if (!supabase) {
      setGisError('Missing Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
      return;
    }
    setGisError(null);

    try {
      await new Promise<void>((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        window.setTimeout(done, 350);
        try {
          window.dispatchEvent(new CustomEvent('ed_before_sign_in', { detail: { resolve: done } }));
        } catch {
          done();
        }
      });
    } catch {
      // ignore
    }

    const redirectTo = `${window.location.origin}/`;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
      },
    });
  }, [onLogin]);
  const partnershipSlides = [
    'Northline Auto Transport is proudly partnered with EASYDRIVE CANADA, one of the region’s most trusted and professional licensed vehicle carriers, servicing Ontario and Quebec.',
    'EASYDRIVE CANADA delivers advanced user interface, instant pricing engine, order intake workflow, and automation capabilities that make the vehicle transportation fast, transparent, and effortless for your customers.',
    'All transportation services booked through Northline Auto Transport  uses EDC’s advanced platform. All transportation orders are fulfilled by Northline Auto Transport’s experienced logistics and carrier team, backed by full commercial insurance coverage up to $2,000,000.',
    'This partnership combines EDC’s technology-driven customer experience with Northline Auto Transport’s proven delivery excellence - ensuring reliable, efficient, and professional transportation from end to end.',
  ];
  const [partnershipSlideIndex, setPartnershipSlideIndex] = useState(0);
  const [partnershipSlideFading, setPartnershipSlideFading] = useState(false);

  const openSignIn = useCallback(() => setIsSignInOpen(true), []);
  const closeSignIn = useCallback(() => setIsSignInOpen(false), []);
  const scrollToQuote = useCallback(() => {
    try {
      const el = document.getElementById('quote-form');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch {
      // ignore
    }
    setIsMobileMenuOpen(false);
  }, []);

  useEffect(() => {
    const intervalMs = 4000;
    const fadeMs = 160;

    const intervalId = window.setInterval(() => {
      setPartnershipSlideFading(true);

      window.setTimeout(() => {
        setPartnershipSlideIndex((prev) => (prev + 1) % partnershipSlides.length);
        setPartnershipSlideFading(false);
      }, fadeMs);
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [partnershipSlides.length]);

  useEffect(() => {
    void onLogin;
  }, [onLogin]);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="sticky top-0 inset-x-0 z-50 bg-white/90 backdrop-blur border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Left side - Both Logos */}
            <div className="flex items-center space-x-4">
              <img
                src="/logoclick.png"
                alt="NORTHLINE"
                className="h-9 w-auto"
              />
            </div>
            
            {/* Center - Navigation Links (Desktop) */}
            <div className="hidden md:flex items-center space-x-7">
              <a href="#home" className="text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold">Home</a>
              <a href="#about" className="text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold">About Us</a>
              <a href="#contact" className="text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold">Contact</a>
            </div>
            
            {/* Right side - Buttons (Desktop) */}
            <div className="hidden md:flex items-center space-x-3">
              <button
                onClick={openSignIn}
                className="text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold px-3 py-2"
              >
                Log In
              </button>
              <button 
                onClick={scrollToQuote}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-base font-semibold hover:bg-blue-700 transition-colors"
              >
                Get Quote Now
              </button>
            </div>

            {/* Mobile menu button */}
            <div className="md:hidden">
              <button
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                className="text-gray-600 hover:text-gray-900 p-2"
              >
                <Menu className="h-6 w-6" />
              </button>
            </div>
          </div>

          {/* Mobile menu */}
          {isMobileMenuOpen && (
            <div className="md:hidden bg-white border-t border-gray-200">
              <div className="px-2 pt-2 pb-3 space-y-1">
                <a href="#home" className="block px-3 py-2 text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold">Home</a>
                <a href="#about" className="block px-3 py-2 text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold">About Us</a>
                <a href="#contact" className="block px-3 py-2 text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold">Contact</a>
                <div className="border-t border-gray-200 pt-2 mt-2">
                  <button
                    onClick={openSignIn}
                    className="block w-full text-left px-3 py-2 text-gray-700 hover:text-gray-900 transition-colors text-base font-semibold"
                  >
                    Log In
                  </button>
                  <button 
                    onClick={scrollToQuote}
                    className="block w-full text-left px-3 py-2 bg-blue-600 text-white rounded-lg text-base font-semibold hover:bg-blue-700 transition-colors mt-2"
                  >
                    Get Quote Now
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </nav>

      <section
        id="home"
        className="relative isolate overflow-hidden bg-gradient-to-br from-gray-800 via-gray-700 to-gray-900 text-white"
      >
        <div className="pointer-events-none absolute inset-0 bg-black/40" />
        <div
          className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-25"
          style={{
            backgroundImage: 'url(/homebroad.png)',
          }}
        />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex min-h-[56vh] flex-col items-center justify-center text-center pt-10 sm:pt-12 md:pt-14">
            <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold leading-tight">
              Vehicle Transportation
              <span className="block text-cyan-400 mt-1 sm:mt-2">Made Simple</span>
            </h1>
            <p className="mt-4 sm:mt-6 text-base sm:text-lg md:text-xl lg:text-2xl text-gray-200 max-w-3xl mx-auto px-2">
              One-way vehicle pickup or delivery from Ottawa made simple-instant pricing, easy booking, document uploads.
            </p>

            <div id="quote-form" className="mt-7 w-full max-w-4xl rounded-2xl bg-white/95 backdrop-blur-md shadow-2xl border border-white/20 overflow-hidden">
              <div className="p-3 sm:p-4">
                <FileUploadSection
                  hideHeader
                  persistState={false}
                  onContinueToSignIn={() => {
                    openSignIn();
                  }}
                />
              </div>
            </div>
          </div>

          <div className="pb-10 sm:pb-14 md:pb-16">
            <div className="mt-10 sm:mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
              <div className="floating bg-white rounded-lg p-6 sm:p-8 border border-gray-200 hover:border-cyan-300 transition-all duration-300 shadow-lg min-h-[100px] sm:min-h-[140px] md:min-h-[180px] flex flex-col justify-center">
                <div className="text-3xl sm:text-4xl font-bold text-gray-900">1000+</div>
                <div className="text-gray-900 mt-2 sm:mt-3 font-medium text-sm sm:text-base">Vehicles Transported</div>
              </div>
              <div className="floating bg-white rounded-lg p-6 sm:p-8 border border-gray-200 hover:border-cyan-300 transition-all duration-300 shadow-lg min-h-[100px] sm:min-h-[140px] md:min-h-[180px] flex flex-col justify-center" style={{ animationDelay: '0.2s' }}>
                <div className="text-3xl sm:text-4xl font-bold text-gray-900">24/7</div>
                <div className="text-gray-900 mt-2 sm:mt-3 font-medium text-sm sm:text-base">Support Available</div>
              </div>
              <div className="floating bg-white rounded-lg p-6 sm:p-8 border border-gray-200 hover:border-cyan-300 transition-all duration-300 shadow-lg min-h-[100px] sm:min-h-[140px] md:min-h-[180px] flex flex-col justify-center" style={{ animationDelay: '0.4s' }}>
                <div className="text-3xl sm:text-4xl font-bold text-gray-900">98%</div>
                <div className="text-gray-900 mt-2 sm:mt-3 font-medium text-sm sm:text-base">On-Time Delivery</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {isSignInOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeSignIn();
          }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
          <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <div className="text-lg font-semibold text-gray-900">Sign in</div>
                <div className="text-sm text-gray-500">Continue to EASYDRIVE</div>
              </div>
              <button
                type="button"
                onClick={closeSignIn}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5">
              {gisError && <div className="mb-3 text-sm font-medium text-red-600">{gisError}</div>}

              <div className="w-full">
                <button
                  type="button"
                  onClick={startGoogleLogin}
                  className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
                >
                  Continue with Google
                </button>
              </div>

              <div className="mt-4 text-xs text-gray-500 text-center">
                By continuing, you agree to our terms and privacy policy.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="relative overflow-hidden bg-gradient-to-b from-gray-50 via-gray-50 to-white py-12 sm:py-16 md:py-20" style={{
        background: 'linear-gradient(to bottom, rgba(249,250,251,0.5) 0%, rgba(249,250,251,0.8) 30%, rgb(255,255,255) 100%)',
        backdropFilter: 'blur(1px)'
      }}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-white/60 via-white/30 to-transparent backdrop-blur-xl"></div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10 sm:mb-12 md:mb-16">
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-800 mb-3 sm:mb-4 px-2">Why Choose Northline Auto Transport?</h2>
          <p className="text-base sm:text-lg md:text-xl text-gray-600 max-w-2xl mx-auto px-4">
            A complete transportation solution designed for car dealerships and retail customers
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
          <div className="text-center group px-4">
            <div className="bg-cyan-50 w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center mx-auto mb-3 sm:mb-4 group-hover:bg-cyan-500 transition-colors">
              <MapPin className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-500 group-hover:text-white transition-colors" />
            </div>
            <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-2">Instant Pricing</h3>
            <p className="text-sm sm:text-base text-gray-600">
              Get real-time quotes for pickup or delivery services instantly
            </p>
          </div>

          <div className="text-center group px-4">
            <div className="bg-cyan-50 w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center mx-auto mb-3 sm:mb-4 group-hover:bg-cyan-500 transition-colors">
              <Package className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-500 group-hover:text-white transition-colors" />
            </div>
            <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-2">Easy Ordering</h3>
            <p className="text-sm sm:text-base text-gray-600">
              Place orders quickly with our streamlined booking process
            </p>
          </div>

          <div className="text-center group px-4">
            <div className="bg-cyan-50 w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center mx-auto mb-3 sm:mb-4 group-hover:bg-cyan-500 transition-colors">
              <CheckCircle className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-500 group-hover:text-white transition-colors" />
            </div>
            <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-2">Document Upload</h3>
            <p className="text-sm sm:text-base text-gray-600">
              Securely upload vehicle release forms and work orders
            </p>
          </div>
        </div>
        </div>
      </div>

      <section className="relative overflow-hidden bg-gradient-to-b from-gray-50 via-white to-gray-50 py-12 sm:py-16 md:py-20 lg:py-24">
        <div className="pointer-events-none absolute inset-0">
          <div className="ed-blob-a absolute -top-20 -left-24 h-72 w-72 rounded-full bg-cyan-200/35 blur-3xl"></div>
          <div className="ed-blob-b absolute -bottom-28 -right-24 h-80 w-80 rounded-full bg-sky-200/30 blur-3xl"></div>
          <div className="ed-blob-c absolute top-32 right-10 h-56 w-56 rounded-full bg-gray-200/40 blur-3xl"></div>
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-white/80 via-white/40 to-transparent"></div>
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-white/80 via-white/40 to-transparent"></div>
        </div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="inline-flex items-center rounded-full bg-cyan-50 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-cyan-700 ring-1 ring-cyan-100">
              Trusted Carrier Partnership
            </div>
            <h2 className="mt-3 sm:mt-4 text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-gray-900 px-2">Northline Auto Transport + EASYDRIVE CANADA</h2>
            <p className="mt-3 sm:mt-4 max-w-3xl mx-auto text-sm sm:text-base md:text-lg text-gray-600 px-4">
              Technology-driven booking by EDC, fulfilled end-to-end by Northline Auto Transport-licensed, professional service across Ontario and Quebec.
            </p>
          </div>

          <div className="mt-8 sm:mt-10 md:mt-12 space-y-6">
            {/* Top large section - Partnership Overview */}
            <div className="rounded-2xl sm:rounded-3xl bg-gradient-to-b from-white/85 to-white/65 backdrop-blur-md p-6 sm:p-8 md:p-10 ring-1 ring-black/5 shadow-xl shadow-gray-900/5">
              <div className="text-center">
                <div className="text-sm sm:text-base font-semibold tracking-wide text-gray-500">Partnership Overview</div>
                <div className="mt-2 text-xl sm:text-2xl md:text-3xl font-bold text-gray-900">Built for speed. Backed by experience.</div>
              </div>

              <div className="mt-6 sm:mt-8">
                <p
                  key={partnershipSlideIndex}
                  className={`text-center text-sm sm:text-base md:text-lg text-gray-700 leading-relaxed transition-opacity duration-200 max-w-4xl mx-auto ${
                    partnershipSlideFading ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  {partnershipSlides[partnershipSlideIndex]}
                </p>

                <div className="mt-4 sm:mt-6 flex items-center justify-center gap-2">
                  {partnershipSlides.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setPartnershipSlideIndex(idx)}
                      className={`h-2 rounded-full transition-all ${
                        idx === partnershipSlideIndex ? 'w-8 bg-cyan-500' : 'w-3 bg-gray-300 hover:bg-gray-400'
                      }`}
                      aria-label={`Go to slide ${idx + 1}`}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-6 sm:mt-8 h-px w-full bg-gradient-to-r from-transparent via-gray-200 to-transparent" />

              <div className="mt-6 sm:mt-8 flex justify-center">
                <div className="flex items-start gap-3 sm:gap-4 rounded-xl sm:rounded-2xl bg-white/60 p-4 sm:p-6 ring-1 ring-black/5 max-w-3xl">
                  <CheckCircle className="mt-0.5 h-5 w-5 sm:h-6 sm:w-6 text-cyan-600 flex-shrink-0" />
                  <div className="text-sm sm:text-base text-gray-700 leading-relaxed">
                    This partnership combines EDC's technology-driven customer experience with Northline Auto Transport's proven delivery excellence - ensuring reliable, efficient, and professional transportation from end to end.
                  </div>
                </div>
              </div>
            </div>

            {/* Two medium sections side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="rounded-xl sm:rounded-2xl bg-white/70 backdrop-blur-md p-6 sm:p-8 ring-1 ring-black/5 shadow-xl shadow-gray-900/5 transition-transform duration-300 hover:-translate-y-1">
                <div className="flex items-center gap-3 sm:gap-4 mb-4">
                  <div className="flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-lg sm:rounded-xl bg-cyan-50 ring-1 ring-cyan-100">
                    <Truck className="h-6 w-6 sm:h-7 sm:w-7 text-cyan-600" />
                  </div>
                  <div>
                    <div className="text-sm sm:text-base font-semibold text-gray-900">Carrier Partner</div>
                    <div className="text-sm sm:text-base text-gray-600">Northline Auto Transport</div>
                  </div>
                </div>
                <div className="text-sm sm:text-base text-gray-600 leading-relaxed">
                  Licensed, professional vehicle carrier serving Ontario and Quebec.
                </div>
              </div>

              <div className="rounded-xl sm:rounded-2xl bg-white/70 backdrop-blur-md p-6 sm:p-8 ring-1 ring-black/5 shadow-xl shadow-gray-900/5 transition-transform duration-300 hover:-translate-y-1">
                <div className="flex items-center gap-3 sm:gap-4 mb-4">
                  <div className="flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-lg sm:rounded-xl bg-cyan-50 ring-1 ring-cyan-100">
                    <CheckCircle className="h-6 w-6 sm:h-7 sm:w-7 text-cyan-600" />
                  </div>
                  <div>
                    <div className="text-sm sm:text-base font-semibold text-gray-900">Fully Insured</div>
                    <div className="text-sm sm:text-base text-gray-600">Up to $2,000,000 coverage</div>
                  </div>
                </div>
                <div className="text-sm sm:text-base text-gray-600 leading-relaxed">
                  Commercial insurance coverage for peace of mind from pickup to delivery.
                </div>
              </div>
            </div>

            {/* Full-width bottom section */}
            <div className="rounded-2xl sm:rounded-3xl bg-gray-900/95 p-6 sm:p-8 md:p-10 ring-1 ring-white/10 shadow-2xl shadow-black/30">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 lg:gap-8">
                <div className="flex-1">
                  <div className="text-sm sm:text-base font-semibold text-cyan-300">Technology + Delivery Excellence</div>
                  <div className="mt-2 text-2xl sm:text-3xl md:text-4xl font-bold text-white">Fast, transparent, effortless</div>
                  <div className="mt-3 sm:mt-4 text-sm sm:text-base md:text-lg text-gray-300 leading-relaxed max-w-3xl">
                    EASYDRIVE CANADA provides the instant pricing engine, order intake workflow, and automation- while Northline Auto Transport's experienced logistics and carrier team fulfills your transportation professionally end-to-end.
                  </div>
                </div>
                <div className="flex-shrink-0">
                  <button
                    onClick={scrollToQuote}
                    className="inline-flex items-center gap-2 bg-cyan-500 text-white px-6 sm:px-8 py-3 sm:py-4 rounded-lg sm:rounded-xl hover:bg-cyan-400 transition-all transform hover:scale-105 font-semibold text-sm sm:text-base shadow-lg shadow-cyan-500/30 whitespace-nowrap"
                  >
                    Get Started Now
                    <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-12 sm:mt-16 md:mt-20">
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 sm:gap-6">
              <div>
                <div className="inline-flex items-center rounded-full bg-gray-900 px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-white">How It Works</div>
                <h3 className="mt-3 sm:mt-4 text-xl sm:text-2xl md:text-3xl font-bold text-gray-900">Technology from EDC. Delivery by Northline Auto Transport.</h3>
                <p className="mt-2 sm:mt-3 text-xs sm:text-sm md:text-base text-gray-600 max-w-2xl">
                  From quote to dispatch to final delivery, the experience stays simple while the transport is handled professionally.
                </p>
              </div>
            </div>

            <div className="mt-6 sm:mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
              <div className="rounded-xl sm:rounded-2xl bg-white/70 backdrop-blur-md p-4 sm:p-5 md:p-6 ring-1 ring-black/5 shadow-xl shadow-gray-900/5 transition-transform duration-300 hover:-translate-y-1">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-lg sm:rounded-xl bg-cyan-50 ring-1 ring-cyan-100">
                    <Package className="h-5 w-5 sm:h-6 sm:w-6 text-cyan-600" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm font-semibold text-gray-900">1 ) Get instant pricing</div>
                    <div className="text-xs sm:text-sm text-gray-600">Book in minutes</div>
                  </div>
                </div>
                <p className="mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600 leading-relaxed">
                  EDC provides the modern interface and instant pricing engine so you can request transport quickly and transparently.
                </p>
              </div>

              <div className="rounded-xl sm:rounded-2xl bg-white/70 backdrop-blur-md p-4 sm:p-5 md:p-6 ring-1 ring-black/5 shadow-xl shadow-gray-900/5 transition-transform duration-300 hover:-translate-y-1">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-lg sm:rounded-xl bg-cyan-50 ring-1 ring-cyan-100">
                    <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-cyan-600" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm font-semibold text-gray-900">2 ) We confirm & dispatch</div>
                    <div className="text-xs sm:text-sm text-gray-600">Professional logistics</div>
                  </div>
                </div>
                <p className="mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600 leading-relaxed">
                  North Line’s experienced logistics team coordinates pickup and delivery with a licensed, professional carrier operation.
                </p>
              </div>

              <div className="rounded-xl sm:rounded-2xl bg-white/70 backdrop-blur-md p-4 sm:p-5 md:p-6 ring-1 ring-black/5 shadow-xl shadow-gray-900/5 transition-transform duration-300 hover:-translate-y-1">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-lg sm:rounded-xl bg-cyan-50 ring-1 ring-cyan-100">
                    <Clock className="h-5 w-5 sm:h-6 sm:w-6 text-cyan-600" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm font-semibold text-gray-900">3 ) Delivered end-to-end</div>
                    <div className="text-xs sm:text-sm text-gray-600">Reliable execution</div>
                  </div>
                </div>
                <p className="mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600 leading-relaxed">
                  Your transport is completed by North Line’s carrier team with clear communication and a professional handoff.
                </p>
              </div>
            </div>

            <div className="mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
              <div className="lg:col-span-2 rounded-xl sm:rounded-2xl bg-white/70 backdrop-blur-md p-5 sm:p-6 md:p-7 ring-1 ring-black/5 shadow-xl shadow-gray-900/5">
                <div className="text-xs sm:text-sm font-semibold text-gray-900">Service Area</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveServiceArea((prev) => (prev === 'ontario' ? null : 'ontario'))}
                    className={`inline-flex items-center rounded-full px-2.5 sm:px-3 py-1 text-xs font-semibold ring-1 transition-colors ${
                      activeServiceArea === 'ontario'
                        ? 'bg-cyan-600 text-white ring-cyan-600'
                        : 'bg-cyan-50 text-cyan-700 ring-cyan-100 hover:bg-cyan-100'
                    }`}
                  >
                    <MapPin className="mr-1 h-3 w-3 sm:h-4 sm:w-4" /> Ontario
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveServiceArea((prev) => (prev === 'quebec' ? null : 'quebec'))}
                    className={`inline-flex items-center rounded-full px-2.5 sm:px-3 py-1 text-xs font-semibold ring-1 transition-colors ${
                      activeServiceArea === 'quebec'
                        ? 'bg-cyan-600 text-white ring-cyan-600'
                        : 'bg-cyan-50 text-cyan-700 ring-cyan-100 hover:bg-cyan-100'
                    }`}
                  >
                    <MapPin className="mr-1 h-3 w-3 sm:h-4 sm:w-4" /> Quebec
                  </button>
                </div>

                {activeServiceArea ? (
                  <div className="mt-3 rounded-xl border border-gray-200 bg-white/80 px-4 py-3">
                    <div className="text-xs font-semibold text-gray-800">
                      {activeServiceArea === 'ontario' ? 'Ontario coverage' : 'Quebec coverage'}
                    </div>
                    <div
                      className={`mt-2 grid gap-x-6 gap-y-1 text-xs sm:text-sm text-gray-700 ${
                        activeServiceArea === 'ontario' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'
                      }`}
                    >
                      {(activeServiceArea === 'ontario' ? serviceAreaCities.ontario : serviceAreaCities.quebec).map((city) => (
                        <div key={city} className="flex items-start gap-2">
                          <div className="mt-[6px] h-1.5 w-1.5 rounded-full bg-cyan-500" />
                          <div className="min-w-0">{city}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className="mt-2 sm:mt-3 text-xs sm:text-sm text-gray-600 leading-relaxed">
                  Transportation services booked through EDC are fulfilled by Northline Auto Transport within Ontario and Quebec.
                </p>
              </div>

              <div className="rounded-xl sm:rounded-2xl bg-gray-900/95 p-5 sm:p-6 md:p-7 ring-1 ring-white/10 shadow-2xl shadow-black/30">
                <div className="text-xs sm:text-sm font-semibold text-cyan-300">Commercial Insurance</div>
                <div className="mt-1.5 sm:mt-2 text-xl sm:text-2xl font-bold text-white">Up to $2,000,000</div>
                <p className="mt-2 sm:mt-3 text-xs sm:text-sm text-gray-300 leading-relaxed">
                  Every fulfilled transport is backed by full commercial insurance coverage for added confidence.
                </p>
              </div>
            </div>
          </div>
        </div>

        <style>{`
          @keyframes edFloatA {
            0% { transform: translate3d(0, 0, 0) scale(1); }
            50% { transform: translate3d(40px, 18px, 0) scale(1.08); }
            100% { transform: translate3d(0, 0, 0) scale(1); }
          }
          @keyframes edFloatB {
            0% { transform: translate3d(0, 0, 0) scale(1); }
            50% { transform: translate3d(-34px, -22px, 0) scale(1.1); }
            100% { transform: translate3d(0, 0, 0) scale(1); }
          }
          @keyframes edFloatC {
            0% { transform: translate3d(0, 0, 0) scale(1); }
            50% { transform: translate3d(10px, -28px, 0) scale(1.06); }
            100% { transform: translate3d(0, 0, 0) scale(1); }
          }
          .ed-blob-a { animation: edFloatA 14s ease-in-out infinite; }
          .ed-blob-b { animation: edFloatB 16s ease-in-out infinite; }
          .ed-blob-c { animation: edFloatC 18s ease-in-out infinite; }

          @media (prefers-reduced-motion: reduce) {
            .ed-blob-a, .ed-blob-b, .ed-blob-c { animation: none; }
          }
        `}</style>
      </section>

      <div className="bg-gray-800 text-white py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-6">Perfect for Dealers & Retail Customers</h2>
              <div className="space-y-4">
                <div className="flex items-start">
                  <CheckCircle className="w-6 h-6 text-cyan-400 mr-3 flex-shrink-0 mt-1" />
                  <div>
                    <h4 className="font-semibold mb-1">One-Way Transportation</h4>
                    <p className="text-gray-300">Flexible pickup or delivery options to meet your needs</p>
                  </div>
                </div>
                <div className="flex items-start">
                  <CheckCircle className="w-6 h-6 text-cyan-400 mr-3 flex-shrink-0 mt-1" />
                  <div>
                    <h4 className="font-semibold mb-1">Transparent Pricing</h4>
                    <p className="text-gray-300">No hidden fees, get accurate quotes instantly</p>
                  </div>
                </div>
                <div className="flex items-start">
                  <CheckCircle className="w-6 h-6 text-cyan-400 mr-3 flex-shrink-0 mt-1" />
                  <div>
                    <h4 className="font-semibold mb-1">Secure Documentation</h4>
                    <p className="text-gray-300">Upload and manage all necessary paperwork digitally</p>
                  </div>
                </div>
                <div className="flex items-start">
                  <CheckCircle className="w-6 h-6 text-cyan-400 mr-3 flex-shrink-0 mt-1" />
                  <div>
                    <h4 className="font-semibold mb-1">Order Management</h4>
                    <p className="text-gray-300">Track all your transportation orders in one place</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-gray-700 p-8 rounded-lg">
              <h3 className="text-2xl font-bold mb-6">Ready to Get Started?</h3>
              <p className="text-gray-300 mb-6">
                Join hundreds of dealers and customers who trust Northline Auto Transport for their vehicle transportation needs.
              </p>
              <button
                onClick={openSignIn}
                className="w-full bg-cyan-500 text-white px-6 py-3 rounded-lg hover:bg-cyan-600 transition-colors font-semibold flex items-center justify-center"
              >
                Sign In with Google <ArrowRight className="ml-2 w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <footer className="bg-white text-gray-700 border-t border-gray-200">
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
