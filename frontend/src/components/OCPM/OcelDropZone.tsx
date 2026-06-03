import { useRef, useState } from 'react';
import { UploadCloud, RefreshCw } from 'lucide-react';
import clsx from 'clsx';

// ─── File Drop Zone ───────────────────────────────────────────────────────────

export default function OcelDropZone({
  onFile,
  loading,
}: {
  onFile: (file: File) => void;
  loading: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !loading && inputRef.current?.click()}
      className={clsx(
        'relative flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center transition-all',
        dragOver
          ? 'border-accent/60 bg-accent/5'
          : 'border-line bg-surface-1 hover:border-accent/40 hover:bg-surface-2',
        loading && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".json,.jsonocel,.xml,.xmlocel,.sqlite"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <div className={clsx('rounded-lg p-2.5', dragOver ? 'bg-accent/10 text-accent' : 'bg-tint text-fg-muted')}>
        {loading ? <RefreshCw size={22} className="animate-spin" /> : <UploadCloud size={22} />}
      </div>
      <div>
        <p className="text-[13px] font-medium text-fg-secondary">
          {loading ? 'Uploading OCEL file…' : 'Drop an OCEL file here'}
        </p>
        <p className="mt-1 text-[11px] text-fg-muted">
          or <span className="font-medium text-accent">browse</span>
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {['.json', '.jsonocel', '.xml', '.xmlocel', '.sqlite'].map((ext) => (
          <span key={ext} className="rounded bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
            {ext}
          </span>
        ))}
      </div>
    </div>
  );
}
