import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, type LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  iconColor?: string;
  backTo?: string | -1;
  /** Label shown next to the back chevron. Defaults to "Back". */
  backLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

export default function PageHeader({
  title,
  subtitle,
  description,
  icon: Icon,
  iconColor = 'text-accent',
  backTo,
  backLabel = 'Back',
  actions,
  children,
}: PageHeaderProps) {
  const navigate = useNavigate();

  const handleBack = () => {
    if (backTo === -1) navigate(-1);
    else if (typeof backTo === 'string') navigate(backTo);
  };

  return (
    <div>
      {backTo !== undefined && (
        <button
          onClick={handleBack}
          className="breadcrumb"
          aria-label={`${backLabel} (go back)`}
        >
          <ChevronLeft size={14} strokeWidth={2.2} />
          <span>{backLabel}</span>
        </button>
      )}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 ${iconColor}`}>
                <Icon size={16} />
              </div>
            )}
            <h1 className="page-title">{title}</h1>
          </div>
          {description && (
            <p className="mt-1.5 text-[13px] text-fg-muted max-w-3xl leading-relaxed">{description}</p>
          )}
          {subtitle && (
            <p className="mt-1 text-[12px] text-fg-muted">{subtitle}</p>
          )}
          {children}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
