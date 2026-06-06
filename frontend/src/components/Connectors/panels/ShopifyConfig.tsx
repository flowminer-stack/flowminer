import { Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface ShopifyConfigProps {
  shopDomain: string;
  setShopDomain: (v: string) => void;
  shopifyAccessToken: string;
  setShopifyAccessToken: (v: string) => void;
  shopifyWebhookSecret: string;
  setShopifyWebhookSecret: (v: string) => void;
  shopifyLookbackDays: number;
  setShopifyLookbackDays: (v: number) => void;
  shopifyMaxOrders: number;
  setShopifyMaxOrders: (v: number) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function ShopifyConfig({
  shopDomain,
  setShopDomain,
  shopifyAccessToken,
  setShopifyAccessToken,
  shopifyWebhookSecret,
  setShopifyWebhookSecret,
  shopifyLookbackDays,
  setShopifyLookbackDays,
  shopifyMaxOrders,
  setShopifyMaxOrders,
  showPassword,
  onTogglePassword,
}: ShopifyConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Shopify Settings</h3>

      {/* Shop domain */}
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Shop Domain
        </label>
        <div className="flex items-center gap-0">
          <input
            type="text"
            value={shopDomain}
            onChange={(e) => setShopDomain(e.target.value)}
            placeholder="yourstore"
            className="input w-full rounded-r-none"
          />
          <span className="px-3 py-2 bg-tint border border-l-0 border-line rounded-r-lg text-[11px] text-fg-faint whitespace-nowrap">
            .myshopify.com
          </span>
        </div>
        <p className="mt-1 text-[10px] text-fg-faint">
          Enter the subdomain only, e.g. <span className="font-mono">acme</span>.
        </p>
      </div>

      {/* Access token */}
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Admin API Access Token
        </label>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={shopifyAccessToken}
            onChange={(e) => setShopifyAccessToken(e.target.value)}
            placeholder="shpat_…"
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
        <p className="mt-1 text-[10px] text-fg-faint">
          Requires <span className="font-mono">read_orders</span> scope. Found in
          Shopify Admin → Apps → Develop apps.
        </p>
      </div>

      <Disclosure label="Webhook settings" hint="for real-time ingestion">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Webhook Signing Secret
          </label>
          <input
            type="password"
            value={shopifyWebhookSecret}
            onChange={(e) => setShopifyWebhookSecret(e.target.value)}
            placeholder="Shopify webhook secret"
            className="input w-full font-mono"
          />
          <p className="mt-1 text-[10px] text-fg-faint">
            Optional. Found in Shopify Admin → Notifications → Webhooks. Leave blank
            if you are not registering a webhook.
          </p>
        </div>
      </Disclosure>

      <Disclosure label="Advanced settings" hint="backfill window & order limit">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">
              Lookback Days
            </label>
            <input
              type="number"
              value={shopifyLookbackDays}
              onChange={(e) => setShopifyLookbackDays(Number(e.target.value))}
              min={1}
              max={365}
              className="input w-full"
            />
            <p className="mt-1 text-[10px] text-fg-faint">
              Days of history to pull on first sync (default 90).
            </p>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">
              Max Orders
            </label>
            <input
              type="number"
              value={shopifyMaxOrders}
              onChange={(e) => setShopifyMaxOrders(Number(e.target.value))}
              min={1}
              className="input w-full"
            />
            <p className="mt-1 text-[10px] text-fg-faint">
              Hard cap per sync run (default 5 000).
            </p>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
