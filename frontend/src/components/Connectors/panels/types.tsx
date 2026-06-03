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

export const types: {
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
