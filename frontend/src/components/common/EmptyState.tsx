import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import clsx from 'clsx';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-dashed border-line text-center',
        compact ? 'p-6' : 'p-12',
        className,
      )}
    >
      {Icon && (
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-surface-3 text-fg-faint">
          <Icon size={20} />
        </div>
      )}
      <p className={clsx('font-semibold text-fg', compact ? 'mt-2 text-[12px]' : 'mt-3 text-[13px]')}>
        {title}
      </p>
      {description && (
        <div className={clsx('mx-auto max-w-md text-fg-muted', compact ? 'mt-1 text-[11px]' : 'mt-1.5 text-[12px]')}>
          {description}
        </div>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
