import { ChevronDown } from 'lucide-react';

interface CsvWatchConfigProps {
  filePath: string;
  setFilePath: (v: string) => void;
  delimiter: string;
  setDelimiter: (v: string) => void;
  encoding: string;
  setEncoding: (v: string) => void;
}

export function CsvWatchConfig({
  filePath,
  setFilePath,
  delimiter,
  setDelimiter,
  encoding,
  setEncoding,
}: CsvWatchConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">
        CSV Settings
      </h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          File Path or Directory
        </label>
        <input
          type="text"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
          placeholder="/data/incoming/events.csv"
          className="input w-full font-mono"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Delimiter
          </label>
          <div className="relative">
            <select
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value)}
              className="select w-full"
            >
              <option value=",">Comma (,)</option>
              <option value=";">Semicolon (;)</option>
              <option value="\t">Tab (\t)</option>
              <option value="|">Pipe (|)</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Encoding
          </label>
          <div className="relative">
            <select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value)}
              className="select w-full"
            >
              <option value="utf-8">UTF-8</option>
              <option value="utf-16">UTF-16</option>
              <option value="latin1">Latin-1</option>
              <option value="ascii">ASCII</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
          </div>
        </div>
      </div>
    </div>
  );
}
