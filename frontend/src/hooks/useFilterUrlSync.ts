import { useEffect } from 'react';
import { useFilterStore } from '@/store/filterStore';

// Two-way sync between the filter store and the URL `?filters=...`
// query parameter, giving us "saved views as shareable URLs" (UiPath)
// for free. On mount we read the URL once and hydrate the store; on
// every chip change we update the URL without adding history entries.
export function useFilterUrlSync(eventLogId?: string | null) {
  const deserialise = useFilterStore((s) => s.deserialise);
  const setEventLog = useFilterStore((s) => s.setEventLog);
  const serialise = useFilterStore((s) => s.serialise);
  const chips = useFilterStore((s) => s.chips);
  const disabled = useFilterStore((s) => s.disabled);

  // Hydrate on first mount / when the event log changes.
  useEffect(() => {
    if (eventLogId !== undefined) setEventLog(eventLogId ?? null);
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('filters');
    if (raw) {
      try {
        deserialise(decodeURIComponent(raw));
      } catch {
        // Ignore — the URL had a malformed payload.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventLogId]);

  // Push chip changes back to the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (chips.length === 0) {
      params.delete('filters');
    } else {
      params.set('filters', encodeURIComponent(serialise()));
    }
    const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    // replaceState — don't pollute browser history with every chip tweak.
    window.history.replaceState(null, '', newUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips, disabled]);
}
