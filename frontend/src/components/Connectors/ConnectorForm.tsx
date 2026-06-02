import React, { useState } from 'react';
import clsx from 'clsx';
import {
  Database,
  ChevronDown,
  Globe,
  Github,
  FileText,
  Server,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  Zap,
  Clock,
  Info,
  Columns,
} from 'lucide-react';
import { parseCronToHuman } from '../../utils/format';
import { connectors as connectorsApi } from '@/api/client';

interface Connector {
  id: string;
  name: string;
  type: string;
  config: Record<string, any>;
  schedule?: string;
  is_active: boolean;
  last_sync?: string;
  created_at: string;
}

interface ConnectorFormProps {
  connector?: Connector;
  onSave: (data: any) => void;
  onCancel: () => void;
  onTest: (data: any) => void;
}

type ConnectorType =
  | 'postgresql'
  | 'mysql'
  | 'sqlserver'
  | 'csv_watch'
  | 'api_endpoint'
  | 'jira'
  | 'github'
  | 'odoo'
  | 'zendesk'
  | 'sap'
  | 'salesforce'
  | 'servicenow'
  | 'snowflake'
  | 'bigquery'
  | 'oracle'
  | 'workday'
  | 'oracle_fusion'
  | 'coupa'
  | 'ariba';

const types: {
  value: ConnectorType;
  label: string;
  icon: React.ReactNode;
  description: string;
}[] = [
  {
    value: 'postgresql',
    label: 'PostgreSQL',
    icon: <Database className="w-5 h-5" />,
    description: 'Connect to a PostgreSQL database',
  },
  {
    value: 'mysql',
    label: 'MySQL',
    icon: <Database className="w-5 h-5" />,
    description: 'Connect to a MySQL database',
  },
  {
    value: 'sqlserver',
    label: 'SQL Server',
    icon: <Server className="w-5 h-5" />,
    description: 'Connect to Microsoft SQL Server',
  },
  {
    value: 'oracle',
    label: 'Oracle DB',
    icon: <Database className="w-5 h-5" />,
    description: 'Connect to an Oracle database',
  },
  {
    value: 'snowflake',
    label: 'Snowflake',
    icon: <Database className="w-5 h-5" />,
    description: 'Connect to Snowflake data warehouse',
  },
  {
    value: 'bigquery',
    label: 'BigQuery',
    icon: <Database className="w-5 h-5" />,
    description: 'Connect to Google BigQuery',
  },
  {
    value: 'csv_watch',
    label: 'CSV Watch',
    icon: <FileText className="w-5 h-5" />,
    description: 'Watch a directory for CSV files',
  },
  {
    value: 'api_endpoint',
    label: 'REST API',
    icon: <Globe className="w-5 h-5" />,
    description: 'Fetch data from a REST API',
  },
  {
    value: 'jira',
    label: 'Jira',
    icon: <Globe className="w-5 h-5" />,
    description: 'Import issues from Jira',
  },
  {
    value: 'github',
    label: 'GitHub',
    icon: <Github className="w-5 h-5" />,
    description: 'Import PRs or issues from GitHub',
  },
  {
    value: 'salesforce',
    label: 'Salesforce',
    icon: <Globe className="w-5 h-5" />,
    description: 'Connect to Salesforce CRM',
  },
  {
    value: 'servicenow',
    label: 'ServiceNow',
    icon: <Globe className="w-5 h-5" />,
    description: 'Import tickets from ServiceNow',
  },
  {
    value: 'sap',
    label: 'SAP',
    icon: <Server className="w-5 h-5" />,
    description: 'Connect to SAP ERP',
  },
  {
    value: 'workday',
    label: 'Workday',
    icon: <Globe className="w-5 h-5" />,
    description: 'Connect to Workday HCM/Finance',
  },
  {
    value: 'oracle_fusion',
    label: 'Oracle Fusion',
    icon: <Server className="w-5 h-5" />,
    description: 'Connect to Oracle Fusion Cloud',
  },
  {
    value: 'coupa',
    label: 'Coupa',
    icon: <Globe className="w-5 h-5" />,
    description: 'Connect to Coupa procurement',
  },
  {
    value: 'ariba',
    label: 'SAP Ariba',
    icon: <Globe className="w-5 h-5" />,
    description: 'Connect to SAP Ariba procurement',
  },
  {
    value: 'odoo',
    label: 'Odoo',
    icon: <Database className="w-5 h-5" />,
    description: 'Connect to an Odoo instance',
  },
  {
    value: 'zendesk',
    label: 'Zendesk',
    icon: <Globe className="w-5 h-5" />,
    description: 'Import tickets from Zendesk',
  },
];

const commonCrons = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekly (Monday)', value: '0 0 * * 1' },
];

// ERP / SaaS types that supply fixed column mappings automatically or need
// OAuth-style credentials rather than generic DB fields.
const AUTO_MAPPED_TYPES: ConnectorType[] = [
  'jira',
  'github',
  'odoo',
  'zendesk',
  'salesforce',
  'servicenow',
  'workday',
  'oracle_fusion',
  'coupa',
  'ariba',
];

// Types where the user supplies a SQL/table query and manual column mapping
// applies (unless schema fetch populates the dropdowns).
const MANUAL_MAPPED_TYPES: ConnectorType[] = [
  'postgresql',
  'mysql',
  'sqlserver',
  'oracle',
  'snowflake',
  'bigquery',
  'csv_watch',
  'api_endpoint',
  'sap',
];

// ─── ColumnField ──────────────────────────────────────────────────────────────

interface ColumnFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  columns: string[];
}

function ColumnField({ label, value, onChange, placeholder, columns }: ColumnFieldProps) {
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

// ─── SAP config ───────────────────────────────────────────────────────────────

interface SapConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

function SapConfig({ config, onChange, showPassword, onTogglePassword }: SapConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">SAP Settings</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Host</label>
          <input
            type="text"
            value={config.host || ''}
            onChange={(e) => onChange('host', e.target.value)}
            placeholder="sap-server.company.com"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">System Number</label>
          <input
            type="text"
            value={config.system_number || ''}
            onChange={(e) => onChange('system_number', e.target.value)}
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
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Table / RFC Function</label>
        <input
          type="text"
          value={config.table || ''}
          onChange={(e) => onChange('table', e.target.value)}
          placeholder="CDHDR or Z_GET_EVENTS"
          className="input w-full font-mono"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          Specify a table name (CDHDR, CDPOS) or a custom RFC function module
        </p>
      </div>
    </div>
  );
}

// ─── Salesforce config ────────────────────────────────────────────────────────

interface SalesforceConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

function SalesforceConfig({ config, onChange, showPassword, onTogglePassword }: SalesforceConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Salesforce Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Instance URL</label>
        <input
          type="url"
          value={config.instance_url || ''}
          onChange={(e) => onChange('instance_url', e.target.value)}
          placeholder="https://company.my.salesforce.com"
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
            placeholder="user@company.com"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Password + Security Token</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={config.password || ''}
              onChange={(e) => onChange('password', e.target.value)}
              placeholder="passwordTOKEN"
              className="input w-full pr-10"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Object / SOQL</label>
          <input
            type="text"
            value={config.sobject || ''}
            onChange={(e) => onChange('sobject', e.target.value)}
            placeholder="Case"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max Records</label>
          <input
            type="number"
            value={config.max_records ?? 10000}
            onChange={(e) => onChange('max_records', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </div>
    </div>
  );
}

// ─── ServiceNow config ────────────────────────────────────────────────────────

interface ServiceNowConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

function ServiceNowConfig({ config, onChange, showPassword, onTogglePassword }: ServiceNowConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">ServiceNow Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Instance URL</label>
        <input
          type="url"
          value={config.instance_url || ''}
          onChange={(e) => onChange('instance_url', e.target.value)}
          placeholder="https://company.service-now.com"
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
            placeholder="admin"
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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Table</label>
          <input
            type="text"
            value={config.table || ''}
            onChange={(e) => onChange('table', e.target.value)}
            placeholder="incident"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max Records</label>
          <input
            type="number"
            value={config.max_records ?? 5000}
            onChange={(e) => onChange('max_records', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Snowflake config ─────────────────────────────────────────────────────────

interface SnowflakeConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

function SnowflakeConfig({ config, onChange, showPassword, onTogglePassword }: SnowflakeConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Snowflake Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Account</label>
        <input
          type="text"
          value={config.account || ''}
          onChange={(e) => onChange('account', e.target.value)}
          placeholder="company.us-east-1"
          className="input w-full font-mono"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          The account identifier from your Snowflake URL
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Username</label>
          <input
            type="text"
            value={config.username || ''}
            onChange={(e) => onChange('username', e.target.value)}
            placeholder="SVCUSER"
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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Warehouse</label>
          <input
            type="text"
            value={config.warehouse || ''}
            onChange={(e) => onChange('warehouse', e.target.value)}
            placeholder="COMPUTE_WH"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Database</label>
          <input
            type="text"
            value={config.database || ''}
            onChange={(e) => onChange('database', e.target.value)}
            placeholder="EVENTS_DB"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Schema</label>
          <input
            type="text"
            value={config.schema || ''}
            onChange={(e) => onChange('schema', e.target.value)}
            placeholder="PUBLIC"
            className="input w-full font-mono"
          />
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">SQL Query or Table</label>
        <textarea
          value={config.query || ''}
          onChange={(e) => onChange('query', e.target.value)}
          placeholder="SELECT * FROM event_log WHERE created_at > '{{last_sync}}'"
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

// ─── BigQuery config ──────────────────────────────────────────────────────────

interface BigQueryConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
}

function BigQueryConfig({ config, onChange }: BigQueryConfigProps) {
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

// ─── Generic SaaS / ERP config ────────────────────────────────────────────────

interface GenericErpConfigProps {
  type: ConnectorType;
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

function GenericErpConfig({
  type,
  config,
  onChange,
  showPassword,
  onTogglePassword,
}: GenericErpConfigProps) {
  const label = types.find((t) => t.value === type)?.label ?? type;
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">{label} Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Base URL</label>
        <input
          type="url"
          value={config.base_url || ''}
          onChange={(e) => onChange('base_url', e.target.value)}
          placeholder="https://api.example.com"
          className="input w-full"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Client ID</label>
          <input
            type="text"
            value={config.client_id || ''}
            onChange={(e) => onChange('client_id', e.target.value)}
            placeholder="client_id"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Client Secret</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={config.client_secret || ''}
              onChange={(e) => onChange('client_secret', e.target.value)}
              placeholder="client_secret"
              className="input w-full pr-10 font-mono"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Entity / Table</label>
          <input
            type="text"
            value={config.entity || ''}
            onChange={(e) => onChange('entity', e.target.value)}
            placeholder="WorkerHistory"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max Records</label>
          <input
            type="number"
            value={config.max_records ?? 10000}
            onChange={(e) => onChange('max_records', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const ConnectorForm: React.FC<ConnectorFormProps> = ({
  connector,
  onSave,
  onCancel,
  onTest,
}) => {
  const [name, setName] = useState(connector?.name || '');
  const [type, setType] = useState<ConnectorType>(
    (connector?.type as ConnectorType) || 'postgresql'
  );

  // Database config
  const [host, setHost] = useState(connector?.config?.host || 'localhost');
  const [port, setPort] = useState(connector?.config?.port || '5432');
  const [database, setDatabase] = useState(connector?.config?.database || '');
  const [username, setUsername] = useState(connector?.config?.username || '');
  const [password, setPassword] = useState(connector?.config?.password || '');
  const [query, setQuery] = useState(connector?.config?.query || '');
  const [showPassword, setShowPassword] = useState(false);

  // CSV Watch config
  const [filePath, setFilePath] = useState(connector?.config?.file_path || '');
  const [delimiter, setDelimiter] = useState(connector?.config?.delimiter || ',');
  const [encoding, setEncoding] = useState(connector?.config?.encoding || 'utf-8');

  // API Endpoint config
  const [apiUrl, setApiUrl] = useState(connector?.config?.url || '');
  const [apiMethod, setApiMethod] = useState(connector?.config?.method || 'GET');
  const [apiHeaders, setApiHeaders] = useState(connector?.config?.headers || '');
  const [apiBody, setApiBody] = useState(connector?.config?.body || '');
  const [apiAuth, setApiAuth] = useState(connector?.config?.auth_type || 'none');
  const [apiToken, setApiToken] = useState(connector?.config?.token || '');
  const [apiDataPath, setApiDataPath] = useState(connector?.config?.data_path || '');
  const [apiPaginationType, setApiPaginationType] = useState(connector?.config?.pagination_type || 'none');
  const [apiPageSize, setApiPageSize] = useState(connector?.config?.page_size ?? 100);

  // Jira config
  const [jiraInstanceUrl, setJiraInstanceUrl] = useState(connector?.config?.instance_url || '');
  const [jiraEmail, setJiraEmail] = useState(connector?.config?.email || '');
  const [jiraApiToken, setJiraApiToken] = useState(connector?.config?.api_token || '');
  const [jiraProjectKey, setJiraProjectKey] = useState(connector?.config?.project_key || '');
  const [jiraMaxResults, setJiraMaxResults] = useState(connector?.config?.max_results ?? 1000);

  // GitHub config
  const [githubToken, setGithubToken] = useState(connector?.config?.token || '');
  const [githubOwner, setGithubOwner] = useState(connector?.config?.owner || '');
  const [githubRepo, setGithubRepo] = useState(connector?.config?.repo || '');
  const [githubEventType, setGithubEventType] = useState(connector?.config?.event_type || 'pull_requests');
  const [githubMaxItems, setGithubMaxItems] = useState(connector?.config?.max_items ?? 500);

  // Odoo config
  const [odooHost, setOdooHost] = useState(connector?.config?.host || 'localhost');
  const [odooPort, setOdooPort] = useState(connector?.config?.port ?? 5432);
  const [odooDatabase, setOdooDatabase] = useState(connector?.config?.database || '');
  const [odooUser, setOdooUser] = useState(connector?.config?.user || 'odoo');
  const [odooPassword, setOdooPassword] = useState(connector?.config?.password || '');
  const [odooModel, setOdooModel] = useState(connector?.config?.model || 'sale.order');

  // Zendesk config
  const [zendeskSubdomain, setZendeskSubdomain] = useState(connector?.config?.subdomain || '');
  const [zendeskEmail, setZendeskEmail] = useState(connector?.config?.email || '');
  const [zendeskApiToken, setZendeskApiToken] = useState(connector?.config?.api_token || '');
  const [zendeskMaxTickets, setZendeskMaxTickets] = useState(connector?.config?.max_tickets ?? 1000);

  // ERP / SaaS connector configs (SAP, Salesforce, ServiceNow, Snowflake,
  // BigQuery, and the generic ones). Stored as free-form objects to avoid
  // proliferating individual state variables — each sub-component patches
  // into a typed key via the shared `erpConfig` updater.
  const [erpConfig, setErpConfig] = useState<Record<string, any>>(
    connector?.config ?? {}
  );

  const handleErpConfigChange = (key: string, value: any) => {
    setErpConfig((prev) => ({ ...prev, [key]: value }));
  };

  // Column mapping
  const [caseIdCol, setCaseIdCol] = useState(connector?.config?.case_id_column || '');
  const [activityCol, setActivityCol] = useState(connector?.config?.activity_column || '');
  const [timestampCol, setTimestampCol] = useState(connector?.config?.timestamp_column || '');

  // Discovered columns from schema endpoint (populated after a successful test)
  const [schemaColumns, setSchemaColumns] = useState<string[]>([]);
  const [schemaFetching, setSchemaFetching] = useState(false);

  // Schedule
  const [schedule, setSchedule] = useState(connector?.schedule || '0 * * * *');
  const [customCron, setCustomCron] = useState(false);

  // Test state
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const getDefaultPort = (t: ConnectorType) => {
    switch (t) {
      case 'postgresql': return '5432';
      case 'mysql': return '3306';
      case 'sqlserver': return '1433';
      case 'oracle': return '1521';
      default: return '';
    }
  };

  const handleTypeChange = (newType: ConnectorType) => {
    setType(newType);
    setPort(getDefaultPort(newType));
    setTestStatus('idle');
    setSchemaColumns([]);
  };

  const buildConfig = () => {
    const config: Record<string, any> = {
      case_id_column: caseIdCol,
      activity_column: activityCol,
      timestamp_column: timestampCol,
    };

    if (['postgresql', 'mysql', 'sqlserver', 'oracle'].includes(type)) {
      Object.assign(config, { host, port: Number(port), database, username, password, query });
    } else if (type === 'csv_watch') {
      Object.assign(config, { file_path: filePath, delimiter, encoding });
    } else if (type === 'api_endpoint') {
      Object.assign(config, {
        url: apiUrl,
        method: apiMethod,
        headers: apiHeaders,
        ...(apiMethod === 'POST' ? { body: apiBody } : {}),
        auth_type: apiAuth,
        token: apiToken,
        data_path: apiDataPath,
        pagination_type: apiPaginationType,
        page_size: Number(apiPageSize),
      });
    } else if (type === 'jira') {
      Object.assign(config, {
        instance_url: jiraInstanceUrl,
        email: jiraEmail,
        api_token: jiraApiToken,
        project_key: jiraProjectKey,
        max_results: Number(jiraMaxResults),
      });
    } else if (type === 'github') {
      Object.assign(config, {
        token: githubToken,
        owner: githubOwner,
        repo: githubRepo,
        event_type: githubEventType,
        max_items: Number(githubMaxItems),
      });
    } else if (type === 'odoo') {
      Object.assign(config, {
        host: odooHost,
        port: Number(odooPort),
        database: odooDatabase,
        user: odooUser,
        password: odooPassword,
        model: odooModel,
      });
    } else if (type === 'zendesk') {
      Object.assign(config, {
        subdomain: zendeskSubdomain,
        email: zendeskEmail,
        api_token: zendeskApiToken,
        max_tickets: Number(zendeskMaxTickets),
      });
    } else {
      // ERP / SaaS types managed by erpConfig
      Object.assign(config, erpConfig);
    }

    return config;
  };

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    setSchemaColumns([]);
    try {
      await onTest({ name, type, config: buildConfig(), schedule });
      setTestStatus('success');
      setTestMessage('Connection successful');

      // After a successful test, fetch the schema if we have a saved connector
      // ID so we can populate the column-mapping dropdowns.
      if (connector?.id) {
        setSchemaFetching(true);
        try {
          const resp = await connectorsApi.getSchema(connector.id);
          if (resp.columns.length > 0) {
            setSchemaColumns(resp.columns);
          }
        } catch {
          // Schema fetch is best-effort; fall back to free-text silently.
        } finally {
          setSchemaFetching(false);
        }
      }
    } catch (err: any) {
      setTestStatus('error');
      setTestMessage(err?.message || 'Connection failed');
    }
  };

  const handleSave = () => {
    onSave({
      name,
      type,
      config: buildConfig(),
      schedule,
    });
  };

  const isDatabase = ['postgresql', 'mysql', 'sqlserver', 'oracle'].includes(type);
  const isManualMapped = MANUAL_MAPPED_TYPES.includes(type);
  const isAutoMapped = AUTO_MAPPED_TYPES.includes(type);

  return (
    <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-line bg-surface-1/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
            <Database className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-fg">
              {connector ? 'Edit Connector' : 'New Connector'}
            </h2>
            <p className="text-[12px] text-fg-muted">
              Configure a data source for continuous process mining
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Name */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            Connector Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Production Database"
            className="input w-full"
          />
        </div>

        {/* Type selector */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-3">
            Source Type
          </label>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-10">
            {types.map((ct) => (
              <button
                key={ct.value}
                onClick={() => handleTypeChange(ct.value)}
                className={clsx(
                  'flex flex-col items-center gap-2 p-3 rounded-xl border transition-all text-center',
                  type === ct.value
                    ? 'bg-accent/10 border-line-strong text-accent'
                    : 'bg-surface-2 border-line text-fg-muted hover:border-line-strong hover:text-fg-secondary'
                )}
              >
                <div
                  className={clsx(
                    'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                    type === ct.value ? 'bg-accent/15' : 'bg-tint'
                  )}
                >
                  {ct.icon}
                </div>
                <span className="text-[11px] font-medium leading-tight">{ct.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Database config */}
        {isDatabase && (
          <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
            <h3 className="text-sm font-semibold text-fg-secondary">
              Connection Settings
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Host
                </label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="localhost"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Port
                </label>
                <input
                  type="text"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder={getDefaultPort(type)}
                  className="input w-full"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Database
              </label>
              <input
                type="text"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="my_database"
                className="input w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="user"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="password"
                    className="input w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted transition-colors"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                SQL Query or Table Name
              </label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="SELECT * FROM event_log WHERE created_at > '{{last_sync}}'"
                rows={3}
                className="input w-full font-mono resize-none"
              />
              <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
                <Info className="w-3 h-3" />
                Use {'{{last_sync}}'} as a placeholder for incremental fetching
              </p>
            </div>
          </div>
        )}

        {/* Snowflake config */}
        {type === 'snowflake' && (
          <SnowflakeConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(!showPassword)}
          />
        )}

        {/* BigQuery config */}
        {type === 'bigquery' && (
          <BigQueryConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
          />
        )}

        {/* SAP config */}
        {type === 'sap' && (
          <SapConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(!showPassword)}
          />
        )}

        {/* Salesforce config */}
        {type === 'salesforce' && (
          <SalesforceConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(!showPassword)}
          />
        )}

        {/* ServiceNow config */}
        {type === 'servicenow' && (
          <ServiceNowConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(!showPassword)}
          />
        )}

        {/* Generic ERP/SaaS config for remaining enterprise types */}
        {(['workday', 'oracle_fusion', 'coupa', 'ariba'] as ConnectorType[]).includes(type) && (
          <GenericErpConfig
            type={type}
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(!showPassword)}
          />
        )}

        {/* CSV Watch config */}
        {type === 'csv_watch' && (
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
        )}

        {/* API Endpoint config */}
        {type === 'api_endpoint' && (
          <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
            <h3 className="text-sm font-semibold text-fg-secondary">
              API Settings
            </h3>
            <div className="flex gap-3">
              <div className="w-28">
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Method
                </label>
                <div className="relative">
                  <select
                    value={apiMethod}
                    onChange={(e) => setApiMethod(e.target.value)}
                    className="select w-full"
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
                </div>
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  URL <span className="text-danger">*</span>
                </label>
                <input
                  type="url"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="https://api.example.com/events"
                  className="input w-full"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Headers (JSON)
              </label>
              <textarea
                value={apiHeaders}
                onChange={(e) => setApiHeaders(e.target.value)}
                placeholder='{"Content-Type": "application/json"}'
                rows={2}
                className="input w-full font-mono resize-none"
              />
            </div>
            {apiMethod === 'POST' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Body (JSON)
                </label>
                <textarea
                  value={apiBody}
                  onChange={(e) => setApiBody(e.target.value)}
                  placeholder='{"filter": {}}'
                  rows={2}
                  className="input w-full font-mono resize-none"
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Data Path
                </label>
                <input
                  type="text"
                  value={apiDataPath}
                  onChange={(e) => setApiDataPath(e.target.value)}
                  placeholder="data.items"
                  className="input w-full font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Pagination Type
                </label>
                <div className="relative">
                  <select
                    value={apiPaginationType}
                    onChange={(e) => setApiPaginationType(e.target.value)}
                    className="select w-full"
                  >
                    <option value="none">None</option>
                    <option value="offset">Offset</option>
                    <option value="page">Page</option>
                    <option value="cursor">Cursor</option>
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Page Size
                </label>
                <input
                  type="number"
                  value={apiPageSize}
                  onChange={(e) => setApiPageSize(Number(e.target.value))}
                  min={1}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Authentication
                </label>
                <div className="relative">
                  <select
                    value={apiAuth}
                    onChange={(e) => setApiAuth(e.target.value)}
                    className="select w-full"
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="api_key">API Key</option>
                    <option value="basic">Basic Auth</option>
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
                </div>
              </div>
            </div>
            {apiAuth !== 'none' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Token / Credentials
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="Enter token..."
                    className="input w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Jira config */}
        {type === 'jira' && (
          <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
            <h3 className="text-sm font-semibold text-fg-secondary">
              Jira Settings
            </h3>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Instance URL
              </label>
              <input
                type="url"
                value={jiraInstanceUrl}
                onChange={(e) => setJiraInstanceUrl(e.target.value)}
                placeholder="https://company.atlassian.net"
                className="input w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={jiraEmail}
                  onChange={(e) => setJiraEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  API Token
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={jiraApiToken}
                    onChange={(e) => setJiraApiToken(e.target.value)}
                    placeholder="Atlassian API token"
                    className="input w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Project Key
                </label>
                <input
                  type="text"
                  value={jiraProjectKey}
                  onChange={(e) => setJiraProjectKey(e.target.value)}
                  placeholder="PROJ"
                  className="input w-full font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Max Results
                </label>
                <input
                  type="number"
                  value={jiraMaxResults}
                  onChange={(e) => setJiraMaxResults(Number(e.target.value))}
                  min={1}
                  className="input w-full"
                />
              </div>
            </div>
          </div>
        )}

        {/* GitHub config */}
        {type === 'github' && (
          <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
            <h3 className="text-sm font-semibold text-fg-secondary">
              GitHub Settings
            </h3>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Personal Access Token
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  className="input w-full pr-10 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Owner
                </label>
                <input
                  type="text"
                  value={githubOwner}
                  onChange={(e) => setGithubOwner(e.target.value)}
                  placeholder="orgname"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Repository
                </label>
                <input
                  type="text"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  placeholder="reponame"
                  className="input w-full"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Event Type
                </label>
                <div className="relative">
                  <select
                    value={githubEventType}
                    onChange={(e) => setGithubEventType(e.target.value)}
                    className="select w-full"
                  >
                    <option value="pull_requests">Pull Requests</option>
                    <option value="issues">Issues</option>
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Max Items
                </label>
                <input
                  type="number"
                  value={githubMaxItems}
                  onChange={(e) => setGithubMaxItems(Number(e.target.value))}
                  min={1}
                  className="input w-full"
                />
              </div>
            </div>
          </div>
        )}

        {/* Odoo config */}
        {type === 'odoo' && (
          <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
            <h3 className="text-sm font-semibold text-fg-secondary">
              Odoo Settings
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Host
                </label>
                <input
                  type="text"
                  value={odooHost}
                  onChange={(e) => setOdooHost(e.target.value)}
                  placeholder="localhost"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Port
                </label>
                <input
                  type="number"
                  value={odooPort}
                  onChange={(e) => setOdooPort(Number(e.target.value))}
                  className="input w-full"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Database
              </label>
              <input
                type="text"
                value={odooDatabase}
                onChange={(e) => setOdooDatabase(e.target.value)}
                placeholder="odoo_db"
                className="input w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  User
                </label>
                <input
                  type="text"
                  value={odooUser}
                  onChange={(e) => setOdooUser(e.target.value)}
                  placeholder="odoo"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={odooPassword}
                    onChange={(e) => setOdooPassword(e.target.value)}
                    placeholder="password"
                    className="input w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Model
              </label>
              <div className="relative">
                <select
                  value={odooModel}
                  onChange={(e) => setOdooModel(e.target.value)}
                  className="select w-full"
                >
                  <option value="sale.order">Sale Orders</option>
                  <option value="purchase.order">Purchase Orders</option>
                  <option value="account.move">Invoices</option>
                  <option value="helpdesk.ticket">Helpdesk Tickets</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
              </div>
            </div>
          </div>
        )}

        {/* Zendesk config */}
        {type === 'zendesk' && (
          <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
            <h3 className="text-sm font-semibold text-fg-secondary">
              Zendesk Settings
            </h3>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Subdomain
              </label>
              <div className="flex items-center gap-0">
                <input
                  type="text"
                  value={zendeskSubdomain}
                  onChange={(e) => setZendeskSubdomain(e.target.value)}
                  placeholder="company"
                  className="input w-full rounded-r-none"
                />
                <span className="px-3 py-2 bg-tint border border-l-0 border-line rounded-r-lg text-[11px] text-fg-faint whitespace-nowrap">
                  .zendesk.com
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={zendeskEmail}
                  onChange={(e) => setZendeskEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-1">
                  API Token
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={zendeskApiToken}
                    onChange={(e) => setZendeskApiToken(e.target.value)}
                    placeholder="Zendesk API token"
                    className="input w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Max Tickets
              </label>
              <input
                type="number"
                value={zendeskMaxTickets}
                onChange={(e) => setZendeskMaxTickets(Number(e.target.value))}
                min={1}
                className="input w-full"
              />
            </div>
          </div>
        )}

        {/* Column mapping */}
        {isManualMapped && (
          <div className="space-y-3 p-4 bg-surface-1 rounded-xl border border-line">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-fg-secondary">Column Mapping</h3>
                <p className="text-[12px] text-fg-faint mt-0.5">
                  {schemaColumns.length > 0
                    ? 'Columns discovered from connection — select from the dropdowns below'
                    : 'Specify the column names in your source data'}
                </p>
              </div>
              {schemaFetching && (
                <div className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Fetching columns…
                </div>
              )}
              {schemaColumns.length > 0 && !schemaFetching && (
                <div className="flex items-center gap-1.5 text-xs font-medium text-success bg-success/10 px-2 py-1 rounded-lg">
                  <Columns className="w-3.5 h-3.5" />
                  {schemaColumns.length} columns
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4">
              <ColumnField
                label="Case ID Column"
                value={caseIdCol}
                onChange={setCaseIdCol}
                placeholder="case_id"
                columns={schemaColumns}
              />
              <ColumnField
                label="Activity Column"
                value={activityCol}
                onChange={setActivityCol}
                placeholder="activity"
                columns={schemaColumns}
              />
              <ColumnField
                label="Timestamp Column"
                value={timestampCol}
                onChange={setTimestampCol}
                placeholder="timestamp"
                columns={schemaColumns}
              />
            </div>
          </div>
        )}

        {isAutoMapped && (
          <div className="rounded-lg border border-line bg-success/5 px-4 py-3">
            <p className="text-[12px] text-success font-medium">Column mapping is automatic for this connector type — no configuration needed.</p>
          </div>
        )}

        {/* Schedule */}
        <div className="space-y-3 p-4 bg-surface-1 rounded-xl border border-line">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg-secondary flex items-center gap-2">
              <Clock className="w-4 h-4 text-fg-faint" />
              Sync Schedule
            </h3>
            <span className="text-xs font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-md">
              {parseCronToHuman(schedule)}
            </span>
          </div>

          {!customCron ? (
            <div className="grid grid-cols-3 gap-2">
              {commonCrons.map((cron) => (
                <button
                  key={cron.value}
                  onClick={() => setSchedule(cron.value)}
                  className={clsx(
                    'px-3 py-2 rounded-lg text-xs font-medium border transition-all',
                    schedule === cron.value
                      ? 'bg-accent/10 text-accent border-line-strong'
                      : 'bg-surface-2 text-fg-muted border-line hover:border-line-strong'
                  )}
                >
                  {cron.label}
                </button>
              ))}
            </div>
          ) : (
            <div>
              <label className="block text-[11px] font-medium text-fg-faint mb-1">
                Cron Expression
              </label>
              <input
                type="text"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="*/5 * * * *"
                className="input w-full font-mono"
              />
            </div>
          )}

          <button
            onClick={() => setCustomCron(!customCron)}
            className="text-xs text-accent hover:text-accent-hover font-medium transition-colors"
          >
            {customCron ? 'Use preset schedules' : 'Use custom cron expression'}
          </button>
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleTest}
            disabled={testStatus === 'testing'}
            className={clsx(
              'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all',
              testStatus === 'testing'
                ? 'bg-surface-1 text-fg-faint border-line cursor-wait'
                : 'btn-secondary'
            )}
          >
            {testStatus === 'testing' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4" />
            )}
            Test Connection
          </button>

          {testStatus === 'success' && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-success bg-success/10 px-3 py-1.5 rounded-lg">
              <CheckCircle className="w-4 h-4" />
              {testMessage}
            </div>
          )}
          {testStatus === 'error' && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-danger bg-danger/10 px-3 py-1.5 rounded-lg">
              <XCircle className="w-4 h-4" />
              {testMessage}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-line bg-surface-1 flex items-center justify-end gap-3">
        <button
          onClick={onCancel}
          className="btn-ghost px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          className={clsx(
            'flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm font-semibold transition-all',
            name.trim()
              ? 'btn-primary'
              : 'bg-tint text-fg-faint cursor-not-allowed'
          )}
        >
          <Save className="w-4 h-4" />
          {connector ? 'Update Connector' : 'Create Connector'}
        </button>
      </div>
    </div>
  );
};

export default ConnectorForm;
