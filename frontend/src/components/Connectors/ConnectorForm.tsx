import React, { useState } from 'react';
import clsx from 'clsx';
import {
  Database,
  Loader2,
  CheckCircle,
  XCircle,
  Save,
  Zap,
  Clock,
  Columns,
} from 'lucide-react';
import { parseCronToHuman } from '../../utils/format';
import { connectors as connectorsApi } from '@/api/client';
import {
  Connector,
  ConnectorType,
  commonCrons,
  AUTO_MAPPED_TYPES,
  MANUAL_MAPPED_TYPES,
  ColumnField,
  ConnectorTypeSelector,
  DatabaseConfig,
  CsvWatchConfig,
  ApiEndpointConfig,
  JiraConfig,
  GithubConfig,
  OdooConfig,
  ZendeskConfig,
  SapConfig,
  SalesforceConfig,
  ServiceNowConfig,
  SnowflakeConfig,
  BigQueryConfig,
  GenericErpConfig,
} from './panels';

interface ConnectorFormProps {
  connector?: Connector;
  onSave: (data: any) => void;
  onCancel: () => void;
  onTest: (data: any) => void;
}

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

  const togglePassword = () => setShowPassword(!showPassword);

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
        <ConnectorTypeSelector value={type} onChange={handleTypeChange} />

        {/* Database config */}
        {isDatabase && (
          <DatabaseConfig
            host={host}
            setHost={setHost}
            port={port}
            setPort={setPort}
            database={database}
            setDatabase={setDatabase}
            username={username}
            setUsername={setUsername}
            password={password}
            setPassword={setPassword}
            query={query}
            setQuery={setQuery}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
            getDefaultPort={getDefaultPort}
            type={type}
          />
        )}

        {/* Snowflake config */}
        {type === 'snowflake' && (
          <SnowflakeConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
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
            onTogglePassword={togglePassword}
          />
        )}

        {/* Salesforce config */}
        {type === 'salesforce' && (
          <SalesforceConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* ServiceNow config */}
        {type === 'servicenow' && (
          <ServiceNowConfig
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* Generic ERP/SaaS config for remaining enterprise types */}
        {(['workday', 'oracle_fusion', 'coupa', 'ariba'] as ConnectorType[]).includes(type) && (
          <GenericErpConfig
            type={type}
            config={erpConfig}
            onChange={handleErpConfigChange}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* CSV Watch config */}
        {type === 'csv_watch' && (
          <CsvWatchConfig
            filePath={filePath}
            setFilePath={setFilePath}
            delimiter={delimiter}
            setDelimiter={setDelimiter}
            encoding={encoding}
            setEncoding={setEncoding}
          />
        )}

        {/* API Endpoint config */}
        {type === 'api_endpoint' && (
          <ApiEndpointConfig
            apiUrl={apiUrl}
            setApiUrl={setApiUrl}
            apiMethod={apiMethod}
            setApiMethod={setApiMethod}
            apiHeaders={apiHeaders}
            setApiHeaders={setApiHeaders}
            apiBody={apiBody}
            setApiBody={setApiBody}
            apiAuth={apiAuth}
            setApiAuth={setApiAuth}
            apiToken={apiToken}
            setApiToken={setApiToken}
            apiDataPath={apiDataPath}
            setApiDataPath={setApiDataPath}
            apiPaginationType={apiPaginationType}
            setApiPaginationType={setApiPaginationType}
            apiPageSize={apiPageSize}
            setApiPageSize={setApiPageSize}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* Jira config */}
        {type === 'jira' && (
          <JiraConfig
            jiraInstanceUrl={jiraInstanceUrl}
            setJiraInstanceUrl={setJiraInstanceUrl}
            jiraEmail={jiraEmail}
            setJiraEmail={setJiraEmail}
            jiraApiToken={jiraApiToken}
            setJiraApiToken={setJiraApiToken}
            jiraProjectKey={jiraProjectKey}
            setJiraProjectKey={setJiraProjectKey}
            jiraMaxResults={jiraMaxResults}
            setJiraMaxResults={setJiraMaxResults}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* GitHub config */}
        {type === 'github' && (
          <GithubConfig
            githubToken={githubToken}
            setGithubToken={setGithubToken}
            githubOwner={githubOwner}
            setGithubOwner={setGithubOwner}
            githubRepo={githubRepo}
            setGithubRepo={setGithubRepo}
            githubEventType={githubEventType}
            setGithubEventType={setGithubEventType}
            githubMaxItems={githubMaxItems}
            setGithubMaxItems={setGithubMaxItems}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* Odoo config */}
        {type === 'odoo' && (
          <OdooConfig
            odooHost={odooHost}
            setOdooHost={setOdooHost}
            odooPort={odooPort}
            setOdooPort={setOdooPort}
            odooDatabase={odooDatabase}
            setOdooDatabase={setOdooDatabase}
            odooUser={odooUser}
            setOdooUser={setOdooUser}
            odooPassword={odooPassword}
            setOdooPassword={setOdooPassword}
            odooModel={odooModel}
            setOdooModel={setOdooModel}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
        )}

        {/* Zendesk config */}
        {type === 'zendesk' && (
          <ZendeskConfig
            zendeskSubdomain={zendeskSubdomain}
            setZendeskSubdomain={setZendeskSubdomain}
            zendeskEmail={zendeskEmail}
            setZendeskEmail={setZendeskEmail}
            zendeskApiToken={zendeskApiToken}
            setZendeskApiToken={setZendeskApiToken}
            zendeskMaxTickets={zendeskMaxTickets}
            setZendeskMaxTickets={setZendeskMaxTickets}
            showPassword={showPassword}
            onTogglePassword={togglePassword}
          />
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
