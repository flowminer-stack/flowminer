import { ChevronDown, Eye, EyeOff } from 'lucide-react';

interface OdooConfigProps {
  odooHost: string;
  setOdooHost: (v: string) => void;
  odooPort: number;
  setOdooPort: (v: number) => void;
  odooDatabase: string;
  setOdooDatabase: (v: string) => void;
  odooUser: string;
  setOdooUser: (v: string) => void;
  odooPassword: string;
  setOdooPassword: (v: string) => void;
  odooModel: string;
  setOdooModel: (v: string) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function OdooConfig({
  odooHost,
  setOdooHost,
  odooPort,
  setOdooPort,
  odooDatabase,
  setOdooDatabase,
  odooUser,
  setOdooUser,
  odooPassword,
  setOdooPassword,
  odooModel,
  setOdooModel,
  showPassword,
  onTogglePassword,
}: OdooConfigProps) {
  return (
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
              onClick={onTogglePassword}
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
  );
}
