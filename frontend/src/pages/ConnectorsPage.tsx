import { useEffect, useState } from 'react';
import {
  Plus,
  Plug,
  Database,
  FileText,
  Globe,
  Github,
  RefreshCw,
  Trash2,
  Play,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';
import { connectors as connectorsApi } from '@/api/client';
import type { Connector } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import PageHeader from '@/components/common/PageHeader';
import ConnectorForm from '@/components/Connectors/ConnectorForm';
import { useUIStore } from '@/store';

const typeIcons: Record<string, React.ElementType> = {
  postgresql: Database,
  mysql: Database,
  sqlserver: Database,
  csv_watch: FileText,
  api_endpoint: Globe,
  jira: Globe,
  github: Github,
  odoo: Database,
  zendesk: Globe,
};

const typeLabels: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
  csv_watch: 'CSV Watch',
  api_endpoint: 'REST API',
  jira: 'Jira',
  github: 'GitHub',
  odoo: 'Odoo',
  zendesk: 'Zendesk',
};

const statusConfig = {
  active: {
    label: 'Active',
    color: 'badge-emerald',
    icon: CheckCircle2,
  },
  inactive: {
    label: 'Inactive',
    color: 'badge-slate',
    icon: AlertCircle,
  },
  error: {
    label: 'Error',
    color: 'badge-rose',
    icon: XCircle,
  },
};

export default function ConnectorsPage() {
  const addNotification = useUIStore((s) => s.addNotification);

  const [connectorList, setConnectorList] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    loadConnectors();
  }, []);

  const loadConnectors = async () => {
    setLoading(true);
    try {
      const list = await connectorsApi.list();
      setConnectorList(list);
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to load connectors',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (id: string) => {
    try {
      const result = await connectorsApi.sync(id);
      addNotification({
        type: result.success ? 'success' : 'error',
        title: result.success ? 'Sync started' : 'Sync failed',
        message: result.message,
      });
    } catch {
      addNotification({ type: 'error', title: 'Sync failed' });
    }
  };

  const handleTest = async (id: string) => {
    try {
      const result = await connectorsApi.test(id);
      addNotification({
        type: result.success ? 'success' : 'error',
        title: result.success ? 'Connection successful' : 'Connection failed',
        message: result.message,
      });
    } catch {
      addNotification({ type: 'error', title: 'Connection test failed' });
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete connector "${name}"?`)) return;
    try {
      await connectorsApi.delete(id);
      setConnectorList((prev) => prev.filter((c) => c.id !== id));
      addNotification({ type: 'success', title: 'Connector deleted' });
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to delete connector',
      });
    }
  };

  const handleCreateConnector = async (data: any) => {
    try {
      await connectorsApi.create({
        name: data.name,
        connector_type: data.type,
        config: data.config,
        schedule: data.schedule,
      });
      await loadConnectors();
      setShowCreateModal(false);
      addNotification({
        type: 'success',
        title: 'Connector created',
        message: `Connector "${data.name}" has been created successfully.`,
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to create connector',
      });
    }
  };

  const handleTestNewConnector = async (_data: any) => {
    addNotification({
      type: 'info',
      title: 'Testing connection...',
      message: 'Save the connector first, then use the test button to validate connectivity.',
    });
  };

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading connectors..." fullPage />;
  }

  return (
    <div>
      <PageHeader
        title="Connectors"
        icon={Plug}
        description="Connect external data sources to import event logs automatically"
        actions={
          <button
            className="btn-primary"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={18} />
            New Connector
          </button>
        }
      />

      {connectorList.length === 0 ? (
        <div className="mt-16 flex flex-col items-center">
          <div className="rounded-full bg-tint p-4">
            <Plug size={32} className="text-fg-faint" />
          </div>
          <h3 className="mt-4 text-[13px] font-semibold text-fg">
            No connectors configured
          </h3>
          <p className="mt-1 max-w-md text-center text-[12px] text-fg-muted">
            Connect to databases, file watchers, or API endpoints to
            automatically import event data.
          </p>
          <button
            className="btn-primary mt-6"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={18} />
            Add Connector
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {connectorList.map((connector) => {
            const TypeIcon =
              typeIcons[connector.connector_type] ?? Plug;
            const status = statusConfig[connector.status];
            const StatusIcon = status.icon;

            return (
              <div key={connector.id} className="card p-5 transition-all">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="rounded-lg bg-tint p-2.5">
                      <TypeIcon size={20} className="text-fg-muted" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-[13px] font-semibold text-fg">
                          {connector.name}
                        </h3>
                        <span className={clsx('badge', status.color)}>
                          <StatusIcon size={12} className="mr-1" />
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] text-fg-muted">
                        {typeLabels[connector.connector_type] ??
                          connector.connector_type}
                        {connector.schedule && (
                          <span className="ml-2 text-fg-faint">
                            | Schedule: {connector.schedule}
                          </span>
                        )}
                      </p>
                      {connector.error_message && (
                        <p className="mt-1 text-[12px] text-danger">
                          {connector.error_message}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-4 text-[11px] text-fg-faint">
                        {connector.last_sync && (
                          <div className="flex items-center gap-1">
                            <Clock size={12} />
                            <span>
                              Last sync:{' '}
                              {format(
                                new Date(connector.last_sync),
                                'MMM d, h:mm a',
                              )}
                            </span>
                          </div>
                        )}
                        <span>
                          Created{' '}
                          {format(
                            new Date(connector.created_at),
                            'MMM d, yyyy',
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleTest(connector.id)}
                      className="btn-ghost p-1.5"
                      title="Test connection"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => handleSync(connector.id)}
                      className="btn-ghost p-1.5"
                      title="Sync now"
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      onClick={() =>
                        handleDelete(connector.id, connector.name)
                      }
                      className="btn-ghost p-1.5 text-danger hover:bg-danger/10 hover:text-danger"
                      title="Delete connector"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Connector Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        size="xl"
      >
        <ConnectorForm
          onSave={handleCreateConnector}
          onCancel={() => setShowCreateModal(false)}
          onTest={handleTestNewConnector}
        />
      </Modal>
    </div>
  );
}
