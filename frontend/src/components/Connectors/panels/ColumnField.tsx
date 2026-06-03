import { ChevronDown } from 'lucide-react';

interface ColumnFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  columns: string[];
}

export function ColumnField({ label, value, onChange, placeholder, columns }: ColumnFieldProps) {
  if (columns.length > 0) {
    return (
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">{label}</label>
        <div className="relative">
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="select w-full"
          >
            <option value="">— select column —</option>
            {columns.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-[11px] font-medium text-fg-faint mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input w-full"
      />
    </div>
  );
}
