import { Eye, EyeOff, Info } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface SapConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

const MODES: { value: string; label: string; hint: string }[] = [
  { value: 'odata', label: 'OData', hint: 'REST/OData gateway service' },
  { value: 'change_documents', label: 'Change documents', hint: 'CDHDR/CDPOS event log' },
  { value: 'rfc', label: 'RFC', hint: 'Direct RFC function module' },
];

export function SapConfig({ config, onChange, showPassword, onTogglePassword }: SapConfigProps) {
  const mode = config.mode || 'odata';

  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">SAP Settings</h3>

      {/* Mode selector */}
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Mode</label>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => onChange('mode', m.value)}
              className={
                mode === m.value
                  ? 'rounded-lg border border-accent bg-accent/10 px-3 py-2 text-left ring-1 ring-accent/30'
                  : 'rounded-lg border border-line bg-surface-2 px-3 py-2 text-left hover:border-line-strong'
              }
            >
              <div
                className={
                  mode === m.value
                    ? 'text-[12px] font-semibold text-accent'
                    : 'text-[12px] font-semibold text-fg'
                }
              >
                {m.label}
              </div>
              <div className="text-[10px] text-fg-faint">{m.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ─── OData / Change documents share base_url + basic auth ─── */}
      {(mode === 'odata' || mode === 'change_documents') && (
        <>
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">OData base URL</label>
            <input
              type="url"
              value={config.base_url || ''}
              onChange={(e) => onChange('base_url', e.target.value)}
              placeholder="https://sap-gw.company.com/sap/opu/odata/sap/ZSERVICE"
              className="input w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">Username</label>
              <input
                type="text"
                value={config.username || ''}
                onChange={(e) => onChange('username', e.target.value)}
                placeholder="RFCUSER"
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={config.password || ''}
                  onChange={(e) => onChange('password', e.target.value)}
                  placeholder="password"
                  className="input w-full pr-10"
                />
                <button
                  type="button"
                  onClick={onTogglePassword}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ─── OData entity-set mode ─── */}
      {mode === 'odata' && (
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Entity set</label>
          <input
            type="text"
            value={config.entity_set || ''}
            onChange={(e) => onChange('entity_set', e.target.value)}
            placeholder="PurchaseOrderSet"
            className="input w-full font-mono"
          />
          <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
            <Info className="w-3 h-3" />
            The OData entity set to read (appended to the base URL).
          </p>
        </div>
      )}

      {/* ─── Change-documents (CDHDR/CDPOS) mode ─── */}
      {mode === 'change_documents' && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">CDHDR entity set</label>
              <input
                type="text"
                value={config.cdhdr_entity_set || ''}
                onChange={(e) => onChange('cdhdr_entity_set', e.target.value)}
                placeholder="CDHDRSet"
                className="input w-full font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">CDPOS entity set</label>
              <input
                type="text"
                value={config.cdpos_entity_set || ''}
                onChange={(e) => onChange('cdpos_entity_set', e.target.value)}
                placeholder="CDPOSSet"
                className="input w-full font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">Object class</label>
            <input
              type="text"
              value={config.object_class || ''}
              onChange={(e) => onChange('object_class', e.target.value)}
              placeholder="EINKBELEG"
              className="input w-full font-mono"
            />
            <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
              <Info className="w-3 h-3" />
              Restrict to a single OBJECTCLAS (e.g. EINKBELEG for POs, VERKBELEG for sales orders).
            </p>
          </div>
          <Disclosure label="Advanced settings" hint="CDPOS batch size">
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                CDPOS filter batch size
              </label>
              <input
                type="number"
                value={config.cdpos_filter_batch_size ?? 50}
                onChange={(e) => onChange('cdpos_filter_batch_size', Number(e.target.value))}
                min={1}
                className="input w-full"
              />
            </div>
          </Disclosure>
        </>
      )}

      {/* ─── RFC mode ─── */}
      {mode === 'rfc' && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">App server host</label>
              <input
                type="text"
                value={config.ashost || ''}
                onChange={(e) => onChange('ashost', e.target.value)}
                placeholder="sap-server.company.com"
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">System number</label>
              <input
                type="text"
                value={config.sysnr || ''}
                onChange={(e) => onChange('sysnr', e.target.value)}
                placeholder="00"
                className="input w-full font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">Client</label>
              <input
                type="text"
                value={config.client || ''}
                onChange={(e) => onChange('client', e.target.value)}
                placeholder="100"
                className="input w-full font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">Username</label>
              <input
                type="text"
                value={config.username || ''}
                onChange={(e) => onChange('username', e.target.value)}
                placeholder="RFCUSER"
                className="input w-full"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={config.password || ''}
                onChange={(e) => onChange('password', e.target.value)}
                placeholder="password"
                className="input w-full pr-10"
              />
              <button
                type="button"
                onClick={onTogglePassword}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">Function module</label>
            <input
              type="text"
              value={config.function_module || ''}
              onChange={(e) => onChange('function_module', e.target.value)}
              placeholder="Z_GET_EVENTS"
              className="input w-full font-mono"
            />
            <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
              <Info className="w-3 h-3" />
              RFC-enabled function module returning a table-like structure.
            </p>
          </div>
        </>
      )}

      {/* Shared record limit (used by every mode) */}
      <Disclosure label="Record limit" hint="max records per sync">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max records</label>
          <input
            type="number"
            value={config.limit ?? 10000}
            onChange={(e) => onChange('limit', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </Disclosure>
    </div>
  );
}
