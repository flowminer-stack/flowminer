import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';

const shortcuts = [
  { keys: ['/'], description: 'Focus search' },
  { keys: ['Esc'], description: 'Close modal / panel' },
  { keys: ['?'], description: 'Show this help' },
];

export default function ShortcutsModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    document.addEventListener('show-shortcuts', handler);
    return () => document.removeEventListener('show-shortcuts', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div className="w-80 rounded-xl border border-line bg-surface-2 shadow-2xl animate-fade-in">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <Keyboard size={15} className="text-accent" />
            <span className="text-[13px] font-semibold text-fg">Keyboard Shortcuts</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4">
          <table className="w-full">
            <tbody>
              {shortcuts.map((s, i) => (
                <tr key={i} className={i > 0 ? 'border-t border-line/40' : ''}>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-1">
                      {s.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border border-line bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-fg-secondary"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 text-[12px] text-fg-muted">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
