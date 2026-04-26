import clsx from 'clsx';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  text?: string;
  className?: string;
  fullPage?: boolean;
}

const sizeClasses = {
  sm: 'h-4 w-4 border-[1.5px]',
  md: 'h-6 w-6 border-2',
  lg: 'h-8 w-8 border-2',
  xl: 'h-10 w-10 border-[3px]',
};

const textSizeClasses = {
  sm: 'text-[11px]',
  md: 'text-[12px]',
  lg: 'text-[13px]',
  xl: 'text-sm',
};

export default function LoadingSpinner({
  size = 'md',
  text,
  className,
  fullPage = false,
}: LoadingSpinnerProps) {
  const spinner = (
    <div className={clsx('flex flex-col items-center gap-3', className)}>
      <div
        className={clsx(
          'animate-spin rounded-full border-line border-t-cyan-500',
          sizeClasses[size],
        )}
      />
      {text && (
        <p
          className={clsx(
            'font-medium text-fg-muted',
            textSizeClasses[size],
          )}
        >
          {text}
        </p>
      )}
    </div>
  );

  if (fullPage) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        {spinner}
      </div>
    );
  }

  return spinner;
}
