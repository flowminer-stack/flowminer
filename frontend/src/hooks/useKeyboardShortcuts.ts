import { useEffect } from 'react';

export function useKeyboardShortcuts() {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip if typing in an input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.querySelector('header input[type="text"]') as HTMLInputElement;
        searchInput?.focus();
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        document.dispatchEvent(new CustomEvent('show-shortcuts'));
      }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
