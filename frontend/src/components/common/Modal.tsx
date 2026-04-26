import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/**
 * Accessible modal with:
 *   - role="dialog" + aria-modal
 *   - Escape to close
 *   - Focus trap: tab / shift-tab cycles inside the dialog
 *   - Auto-focus on the first tabbable element when opened
 *   - Focus restore to the element that triggered the modal when closed
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Latest onClose held in a ref so the keydown listener can be installed
  // exactly once per open instead of being torn down on every parent re-render.
  // Without this, every keystroke in a parent-controlled input would re-run
  // the effect and yank focus back to the modal's first tabbable element.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    // Focus the first meaningful field (skip the Close button) on open.
    requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      const autoFocus = root.querySelector<HTMLElement>('[autofocus]');
      if (autoFocus) {
        autoFocus.focus();
        return;
      }
      const field = root.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])',
      );
      if (field) {
        field.focus();
        return;
      }
      const firstFocusable = root.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    });

    const previous = previouslyFocused.current;
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      if (previous && document.body.contains(previous)) {
        previous.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
        className={clsx(
          'relative w-full animate-slide-up rounded-2xl border border-line bg-surface-2',
          sizeClasses[size],
        )}
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 id="modal-title" className="text-[15px] font-bold tracking-tight text-fg">
              {title}
            </h2>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-lg p-1.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}

        {!title && (
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="absolute right-3.5 top-3.5 rounded-lg p-1.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}

        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line/60 bg-surface-1/50 px-5 py-3.5 rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
