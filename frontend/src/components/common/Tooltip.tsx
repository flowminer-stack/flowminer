interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

export default function Tooltip({ text, children }: TooltipProps) {
  return (
    <span className="relative group inline-flex items-center gap-1 cursor-help">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max max-w-[250px] rounded-md bg-surface-4 px-2.5 py-1.5 text-[10px] text-fg-secondary opacity-0 shadow-lg transition-opacity group-hover:opacity-100 z-50">
        {text}
      </span>
    </span>
  );
}
