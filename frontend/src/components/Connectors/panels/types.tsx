import React from 'react';
import {
  Database,
  Globe,
  Github,
  FileText,
  Server,
} from 'lucide-react';

export interface Connector {
  id: string;
  name: string;
  type: string;
  config: Record<string, any>;
  schedule?: string;
  is_active: boolean;
  last_sync?: string;
  created_at: string;
}

export type ConnectorType =
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

// Category keys are shared with the backend registry (GET /connectors/registry)
// so the grouped picker works the same whether the list comes from the registry
// or this static fallback.
export type CategoryKey = 'db' | 'warehouse' | 'file' | 'api' | 'devops' | 'erp';

// Display metadata for each category, in the order groups should appear.
export const CONNECTOR_GROUPS: { key: CategoryKey; label: string }[] = [
  { key: 'db', label: 'Databases' },
  { key: 'warehouse', label: 'Data warehouses' },
  { key: 'file', label: 'Files & folders' },
  { key: 'api', label: 'Custom API' },
  { key: 'devops', label: 'Dev & issue tracking' },
  { key: 'erp', label: 'Business systems' },
];

export const types: {
  value: ConnectorType;
  label: string;
  icon: React.ReactNode;
  description: string;
  category: CategoryKey;
}[] = [
  {
    value: 'postgresql',
    label: 'PostgreSQL',
    icon: <Database className="w-5 h-5" />,
    description: 'Open-source relational database',
    category: 'db',
  },
  {
    value: 'mysql',
    label: 'MySQL',
    icon: <Database className="w-5 h-5" />,
    description: 'Popular relational database',
    category: 'db',
  },
  {
    value: 'sqlserver',
    label: 'SQL Server',
    icon: <Server className="w-5 h-5" />,
    description: 'Microsoft SQL Server',
    category: 'db',
  },
  {
    value: 'oracle',
    label: 'Oracle DB',
    icon: <Database className="w-5 h-5" />,
    description: 'Oracle relational database',
    category: 'db',
  },
  {
    value: 'snowflake',
    label: 'Snowflake',
    icon: <Database className="w-5 h-5" />,
    description: 'Cloud data warehouse',
    category: 'warehouse',
  },
  {
    value: 'bigquery',
    label: 'BigQuery',
    icon: <Database className="w-5 h-5" />,
    description: 'Google Cloud warehouse',
    category: 'warehouse',
  },
  {
    value: 'csv_watch',
    label: 'CSV Watch',
    icon: <FileText className="w-5 h-5" />,
    description: 'Auto-import CSVs from a folder',
    category: 'file',
  },
  {
    value: 'api_endpoint',
    label: 'REST API',
    icon: <Globe className="w-5 h-5" />,
    description: 'Pull events from any REST endpoint',
    category: 'api',
  },
  {
    value: 'jira',
    label: 'Jira',
    icon: <Globe className="w-5 h-5" />,
    description: 'Issues & sprints from Jira',
    category: 'devops',
  },
  {
    value: 'github',
    label: 'GitHub',
    icon: <Github className="w-5 h-5" />,
    description: 'Pull requests & issues',
    category: 'devops',
  },
  {
    value: 'salesforce',
    label: 'Salesforce',
    icon: <Globe className="w-5 h-5" />,
    description: 'CRM cases & opportunities',
    category: 'erp',
  },
  {
    value: 'servicenow',
    label: 'ServiceNow',
    icon: <Globe className="w-5 h-5" />,
    description: 'Tickets & ITSM records',
    category: 'erp',
  },
  {
    value: 'sap',
    label: 'SAP',
    icon: <Server className="w-5 h-5" />,
    description: 'SAP ERP tables & RFCs',
    category: 'erp',
  },
  {
    value: 'workday',
    label: 'Workday',
    icon: <Globe className="w-5 h-5" />,
    description: 'HCM & finance records',
    category: 'erp',
  },
  {
    value: 'oracle_fusion',
    label: 'Oracle Fusion',
    icon: <Server className="w-5 h-5" />,
    description: 'Oracle Fusion Cloud apps',
    category: 'erp',
  },
  {
    value: 'coupa',
    label: 'Coupa',
    icon: <Globe className="w-5 h-5" />,
    description: 'Procurement & spend',
    category: 'erp',
  },
  {
    value: 'ariba',
    label: 'SAP Ariba',
    icon: <Globe className="w-5 h-5" />,
    description: 'Procurement & sourcing',
    category: 'erp',
  },
  {
    value: 'odoo',
    label: 'Odoo',
    icon: <Database className="w-5 h-5" />,
    description: 'Orders, invoices & tickets',
    category: 'erp',
  },
  {
    value: 'zendesk',
    label: 'Zendesk',
    icon: <Globe className="w-5 h-5" />,
    description: 'Support tickets',
    category: 'erp',
  },
];

export const commonCrons = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekly (Monday)', value: '0 0 * * 1' },
];

// ERP / SaaS types that supply fixed column mappings automatically or need
// OAuth-style credentials rather than generic DB fields.
export const AUTO_MAPPED_TYPES: ConnectorType[] = [
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
export const MANUAL_MAPPED_TYPES: ConnectorType[] = [
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
