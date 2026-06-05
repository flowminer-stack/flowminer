import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X, ChevronRight, Sparkles } from 'lucide-react';
import { TOURS, type TourStep } from './tours.config';

// Guided product tour (Signavio / most enterprise tools).
// A tour is an ordered list of steps, each pointing at a DOM element
// via query selector. Tours are loaded from ``tours.config.ts`` and
// keyed by route prefix so the right tour runs on the right page.
// Completion is stored per-tour-id in localStorage, so the first-time
// experience never repeats but users who navigate to a new area of
// the app still get its dedicated intro.

// Master kill-switch for tours — used by automated tests, screenshots,
// and live demos. Pass ``?tours=off`` once (it persists to localStorage so
// SPA navigation stays tour-free) or set the flag directly. Checked
// synchronously on mount, before any tour is scheduled, so even the first
// page never flashes a tour.
function toursDisabled(): boolean {
  try {
    if (localStorage.getItem('flowminer-tours-off') === '1') return true;
    if (new URLSearchParams(window.location.search).get('tours') === 'off') {
      localStorage.setItem('flowminer-tours-off', '1');
      return true;
    }
  } catch {
    /* localStorage unavailable — fall through */
  }
  return false;
}

export function ProductTour() {
  const location = useLocation();
  const [tourId, setTourId] = useState<string | null>(null);
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [idx, setIdx] = useState<number | null>(null);
  const [spotlight, setSpotlight] = useState<DOMRect | null>(null);

  // Pick the best tour for the current route. A tour declares a
  // ``routePrefix`` (default '/') and the longest matching prefix
  // wins, so '/process/:id' gets the process-view tour instead of
  // the generic welcome one.
  useEffect(() => {
    if (toursDisabled()) return;
    const candidates = TOURS.filter((t) =>
      location.pathname.startsWith(t.routePrefix),
    ).sort((a, b) => b.routePrefix.length - a.routePrefix.length);
    const tour = candidates[0];
    if (!tour) return;
    const key = `flowminer-tour-done::${tour.id}`;
    if (localStorage.getItem(key) === '1') return;
    // Delay so the page has a chance to mount its target elements.
    const t = setTimeout(() => {
      setTourId(tour.id);
      setSteps(tour.steps);
      setIdx(0);
    }, 800);
    return () => clearTimeout(t);
  }, [location.pathname]);

  useEffect(() => {
    if (idx === null) return;
    const step = steps[idx];
    if (!step) return;
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) {
      // Dev-time guard: a step pointing at a selector that no longer
      // exists in the DOM means the tour silently highlights nothing.
      // Warn loudly during development so this drift is caught the
      // moment a target element is renamed or removed.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ProductTour] step ${idx + 1} selector "${step.selector}" matched no element — the tour will show no spotlight. Add the matching data-tour attribute or fix the selector.`,
        );
      }
      setSpotlight(null);
      return;
    }
    setSpotlight(el.getBoundingClientRect());
    const update = () => setSpotlight(el.getBoundingClientRect());
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [idx, steps]);

  const skip = () => {
    if (tourId) {
      localStorage.setItem(`flowminer-tour-done::${tourId}`, '1');
    }
    setTourId(null);
    setSteps([]);
    setIdx(null);
  };
  const next = () => {
    if (idx === null) return;
    if (idx >= steps.length - 1) {
      skip();
    } else {
      setIdx(idx + 1);
    }
  };

  if (idx === null) return null;
  const step = steps[idx];
  if (!step) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]">
      {/* Dark backdrop with a cut-out around the target, plus the
          tour card floating next to it. */}
      <div className="absolute inset-0 bg-black/60" onClick={skip} />
      {spotlight && (
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-accent"
          style={{
            top: spotlight.top - 4,
            left: spotlight.left - 4,
            width: spotlight.width + 8,
            height: spotlight.height + 8,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      )}
      <div
        className="pointer-events-auto absolute max-w-sm rounded-lg border border-accent bg-surface-0 p-4 shadow-2xl"
        style={{
          top: spotlight
            ? Math.min(window.innerHeight - 200, (spotlight.bottom ?? 0) + 12)
            : window.innerHeight / 2 - 80,
          left: spotlight
            ? Math.max(16, Math.min(window.innerWidth - 360, spotlight.left))
            : window.innerWidth / 2 - 160,
        }}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={13} className="text-accent" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">
              Tour · {idx + 1} / {steps.length}
            </span>
          </div>
          <button
            type="button"
            onClick={skip}
            className="rounded p-1 text-fg-muted hover:bg-tint hover:text-fg"
          >
            <X size={12} />
          </button>
        </div>
        <p className="text-[13px] font-semibold text-fg">{step.title}</p>
        <p className="mt-1 text-[11px] text-fg-muted">{step.body}</p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={next}
            className="btn-primary text-[11px]"
          >
            {idx >= steps.length - 1 ? 'Finish' : 'Next'}
            <ChevronRight size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
