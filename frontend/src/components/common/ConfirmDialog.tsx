import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import clsx from 'clsx';

/* ── Imperative confirm/prompt dialogs ────────────────────────────────────
 * Drop-in replacement for window.confirm / window.prompt: styled, themed,
 * Esc/Enter-aware, and awaitable from any event handler:
 *
 *   if (!(await confirmDialog({ title: 'Delete project?', danger: true }))) return;
 *
 *   const v = await promptDialog({ title: 'Snapshot', fields: [{ key: 'name', label: 'Name', required: true }] });
 *   if (!v) return;            // cancelled
 *   createSnapshot(v.name);
 *
 * The host component is mounted once by Layout; calls from anywhere resolve
 * through a tiny zustand store.
 */

export interface PromptField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  initialValue?: string;
  multiline?: boolean;
}

interface DialogOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive styling: red confirm button + warning icon. */
  danger?: boolean;
  fields?: PromptField[];
}

interface PendingDialog {
  opts: DialogOptions;
  resolve: (result: Record<string, string> | null) => void;
}

interface ConfirmStore {
  pending: PendingDialog | null;
  open: (p: PendingDialog) => void;
  settle: (result: Record<string, string> | null) => void;
}

const useConfirmStore = create<ConfirmStore>((set, get) => ({
  pending: null,
  open: (p) => {
    // A second dialog while one is open cancels the first (shouldn't happen
    // in practice, but never leave a promise hanging).
    get().pending?.resolve(null);
    set({ pending: p });
  },
  settle: (result) => {
    get().pending?.resolve(result);
    set({ pending: null });
  },
}));

/** window.confirm replacement. Resolves true when the user confirms. */
export function confirmDialog(opts: Omit<DialogOptions, 'fields'>): Promise<boolean> {
  return new Promise((resolve) =>
    useConfirmStore.getState().open({ opts, resolve: (r) => resolve(r !== null) }),
  );
}

/** window.prompt replacement. Resolves the field values, or null on cancel. */
export function promptDialog(
  opts: DialogOptions & { fields: PromptField[] },
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => useConfirmStore.getState().open({ opts, resolve }));
}

export default function ConfirmDialogHost() {
  const pending = useConfirmStore((s) => s.pending);
  const settle = useConfirmStore((s) => s.settle);
  const [values, setValues] = useState<Record<string, string>>({});
  const confirmRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const opts = pending?.opts;

  // Initialize field values + focus when a dialog opens; restore focus after.
  useEffect(() => {
    if (!pending) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const init: Record<string, string> = {};
    for (const f of pending.opts.fields ?? []) init[f.key] = f.initialValue ?? '';
    setValues(init);
    requestAnimationFrame(() => (firstFieldRef.current ?? confirmRef.current)?.focus());
    const previous = previouslyFocused.current;
    return () => {
      if (previous && document.body.contains(previous)) previous.focus();
    };
  }, [pending]);

  // Esc cancels from anywhere.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settle(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pending, settle]);

  if (!pending || !opts) return null;

  const fields = opts.fields ?? [];
  const requiredMissing = fields.some((f) => f.required && !(values[f.key] ?? '').trim());
  const submit = () => {
    if (requiredMissing) return;
    settle(fields.length > 0 ? values : {});
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm"
        onClick={() => settle(null)}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        className="relative w-full max-w-sm animate-slide-up rounded-2xl border border-line bg-surface-2 p-4"
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        <div className="flex items-start gap-3">
          <div
            className={clsx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
              opts.danger ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent',
            )}
          >
            {opts.danger ? <AlertTriangle size={15} /> : <HelpCircle size={15} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold leading-snug text-fg">{opts.title}</h2>
            {opts.message && (
              <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{opts.message}</p>
            )}
          </div>
        </div>

        {fields.length > 0 && (
          <div className="mt-3 space-y-2.5">
            {fields.map((f, i) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[11px] font-medium text-fg-muted">
                  {f.label}
                  {f.required && <span className="text-danger"> *</span>}
                </span>
                {f.multiline ? (
                  <textarea
                    ref={i === 0 ? (el) => { firstFieldRef.current = el; } : undefined}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    rows={3}
                    className="w-full rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                  />
                ) : (
                  <input
                    ref={i === 0 ? (el) => { firstFieldRef.current = el; } : undefined}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submit();
                    }}
                    placeholder={f.placeholder}
                    className="w-full rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                  />
                )}
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => settle(null)} className="btn-secondary text-[12px]">
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            onClick={submit}
            disabled={requiredMissing}
            className={clsx(
              'text-[12px] disabled:cursor-not-allowed disabled:opacity-50',
              opts.danger ? 'btn-danger' : 'btn-primary',
            )}
          >
            {opts.confirmLabel ?? (opts.danger ? 'Delete' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
