import { useState } from 'react';
import { FileSpreadsheet, FileText } from 'lucide-react';
import clsx from 'clsx';
import { mining } from '@/api/client';

interface ExportButtonsProps {
  eventLogId: string;
  analysis: string;
}

export default function ExportButtons({ eventLogId, analysis }: ExportButtonsProps) {
  const [exporting, setExporting] = useState<string | null>(null);

  const handleExport = async (format: 'csv' | 'excel') => {
    setExporting(format);
    try {
      if (format === 'csv') {
        await mining.exportCsv(eventLogId, analysis);
      } else {
        await mining.exportExcel(eventLogId, analysis);
      }
    } catch {
      // silently fail
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => handleExport('csv')}
        disabled={!!exporting}
        className={clsx(
          'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
          'text-fg-muted hover:bg-tint hover:text-fg-secondary',
          exporting === 'csv' && 'opacity-50 cursor-not-allowed',
        )}
        title="Export as CSV"
      >
        {exporting === 'csv' ? (
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
        ) : (
          <FileText size={12} />
        )}
        CSV
      </button>
      <button
        onClick={() => handleExport('excel')}
        disabled={!!exporting}
        className={clsx(
          'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
          'text-fg-muted hover:bg-tint hover:text-fg-secondary',
          exporting === 'excel' && 'opacity-50 cursor-not-allowed',
        )}
        title="Export as Excel"
      >
        {exporting === 'excel' ? (
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
        ) : (
          <FileSpreadsheet size={12} />
        )}
        Excel
      </button>
    </div>
  );
}
