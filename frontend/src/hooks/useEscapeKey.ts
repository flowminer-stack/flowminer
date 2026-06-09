import { useEffect } from 'react';

/**
 * Close-on-Escape for slide-over drawers and ad-hoc overlays that don't use
 * the shared Modal component. `active` gates the listener so it only exists
 * while the surface is actually open.
 */
export function useEscapeKey(onClose: () => void, active: boolean = true): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, active]);
}
