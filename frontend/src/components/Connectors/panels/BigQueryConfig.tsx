import { Info } from 'lucide-react';

interface BigQueryConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
}

export function BigQueryConfig({ config, onChange }: BigQueryConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">BigQuery Settings</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Project ID</label>
          <input
            type="text"
            value={config.project_id || ''}
            onChange={(e) => onChange('project_id', e.target.value)}
            placeholder="my-gcp-project"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Dataset</label>
          <input
            type="text"
            value={config.dataset || ''}
            onChange={(e) => onChange('dataset', e.target.value)}
            placeholder="events_dataset"
            className="input w-full font-mono"
          />
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Service Account Key (JSON)
        </label>
        <textarea
          value={config.credentials_json || ''}
          onChange={(e) => onChange('credentials_json', e.target.value)}
          placeholder='{"type": "service_account", "project_id": "...", ...}'
          rows={4}
          className="input w-full font-mono resize-none text-[11px]"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          Paste the contents of your GCP service account JSON key file
        </p>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">SQL Query or Table</label>
        <textarea
          value={config.query || ''}
          onChange={(e) => onChange('query', e.target.value)}
          placeholder="SELECT * FROM `project.dataset.event_log` WHERE created_at > '{{last_sync}}'"
          rows={3}
          className="input w-full font-mono resize-none"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          Use {'{{last_sync}}'} as a placeholder for incremental fetching
        </p>
      </div>
    </div>
  );
}
