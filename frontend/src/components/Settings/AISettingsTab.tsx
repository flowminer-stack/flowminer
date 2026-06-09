import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Key,
  Eye,
  EyeOff,
  Save,
  Sparkles,
  CheckCircle2,
  XCircle,
  Info,
} from 'lucide-react';
import clsx from 'clsx';
import { systemSettings } from '@/api/client';
import type { LLMConfigResponse } from '@/api/client';
import { useAuthStore, useUIStore } from '@/store';
import { confirmDialog } from '@/components/common/ConfirmDialog';

export default function AISettingsTab() {
  const user = useAuthStore((s) => s.user);
  const addNotification = useUIStore((s) => s.addNotification);

  const canEditLLM = user?.role === 'admin';

  const [llmConfig, setLLMConfig] = useState<LLMConfigResponse | null>(null);
  const [llmLoading, setLLMLoading] = useState(false);
  const [llmProvider, setLLMProvider] = useState<string>('null');
  const [llmModel, setLLMModel] = useState<string>('');
  const [llmApiKey, setLLMApiKey] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fetch the current LLM config when the AI tab opens — admins only.
  useEffect(() => {
    if (!canEditLLM) return;
    let cancelled = false;
    setLLMLoading(true);
    systemSettings
      .getLLMConfig()
      .then((cfg) => {
        if (cancelled) return;
        setLLMConfig(cfg);
        setLLMProvider(cfg.provider);
        setLLMModel(cfg.model);
        // Never prefill the api key field — the backend doesn't
        // return it and we want the user to explicitly re-enter it
        // if they want to rotate it.
        setLLMApiKey('');
      })
      .catch(() => {
        if (!cancelled) setLLMConfig(null);
      })
      .finally(() => {
        if (!cancelled) setLLMLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canEditLLM]);

  const handleSaveLLMConfig = async () => {
    if (!canEditLLM) return;
    setSaving(true);
    try {
      // Only send fields that actually changed. Sending an empty
      // string for api_key CLEARS the stored key; we only want to
      // do that when the user explicitly asked to.
      const body: {
        provider?: string;
        model?: string;
        api_key?: string;
      } = {};
      if (llmConfig && llmProvider !== llmConfig.provider) {
        body.provider = llmProvider;
      }
      if (llmConfig && llmModel !== llmConfig.model) {
        body.model = llmModel;
      }
      if (llmApiKey.trim()) {
        body.api_key = llmApiKey.trim();
      }
      if (Object.keys(body).length === 0) {
        addNotification({
          type: 'info',
          title: 'No changes',
          message: 'Nothing to save.',
        });
        return;
      }
      const next = await systemSettings.updateLLMConfig(body);
      setLLMConfig(next);
      setLLMProvider(next.provider);
      setLLMModel(next.model);
      setLLMApiKey('');
      addNotification({
        type: 'success',
        title: 'AI settings saved',
        message: next.is_configured
          ? `Using ${next.provider} (${next.model})`
          : 'Settings saved, but no API key is configured yet.',
      });
    } catch (error) {
      let message = 'Failed to save AI settings.';
      if (axios.isAxiosError(error) && error.response?.data?.detail) {
        message = error.response.data.detail;
      }
      addNotification({ type: 'error', title: 'Save failed', message });
    } finally {
      setSaving(false);
    }
  };

  const handleClearApiKey = async () => {
    if (!canEditLLM) return;
    const ok = await confirmDialog({ title: 'Clear stored API key?', message: 'The backend will fall back to environment variables if set.', confirmLabel: 'Clear key' });
    if (!ok) return;
    setSaving(true);
    try {
      const next = await systemSettings.updateLLMConfig({ api_key: '' });
      setLLMConfig(next);
      setLLMApiKey('');
      addNotification({
        type: 'success',
        title: 'API key cleared',
        message: 'Server will now use the environment variable if set.',
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Clear failed',
        message: 'Could not clear the stored API key.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[14px] font-semibold text-fg">
              AI provider
            </h2>
            <p className="mt-1 text-[12px] text-fg-muted">
              Configure the large-language-model provider that powers Ask AI,
              narration, and the other AI features. Keys are encrypted at rest
              and never returned by the API.
            </p>
          </div>
          {llmConfig && (
            <div
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                llmConfig.is_configured
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-warning/30 bg-warning/10 text-warning',
              )}
            >
              {llmConfig.is_configured ? (
                <>
                  <CheckCircle2 size={12} /> Configured
                </>
              ) : (
                <>
                  <XCircle size={12} /> Not configured
                </>
              )}
            </div>
          )}
        </div>

        {llmLoading && !llmConfig && (
          <div className="mt-6 flex items-center gap-2 text-[12px] text-fg-muted">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
            Loading current config…
          </div>
        )}

        {llmConfig && (
          <div className="mt-6 space-y-5">
            {/* Provider select */}
            <div>
              <label className="block text-[12px] font-medium text-fg-muted">
                Provider
              </label>
              <div className="relative mt-1.5">
                <Sparkles
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
                />
                <select
                  value={llmProvider}
                  onChange={(e) => setLLMProvider(e.target.value)}
                  className="input pl-9"
                >
                  <option value="null">Null (disabled — template responses)</option>
                  <option value="openrouter">OpenRouter (many models, one key)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="ollama">Ollama (local, no key needed)</option>
                </select>
              </div>
              <p className="mt-1 text-[11px] text-fg-faint">
                Source:{' '}
                <span className="font-mono">{llmConfig.provider_source}</span>
                {' — '}
                {llmConfig.provider_source === 'db'
                  ? 'set from this UI'
                  : llmConfig.provider_source === 'env'
                    ? 'inherited from FLOWMINER_LLM_PROVIDER env var'
                    : 'unset'}
              </p>
            </div>

            {/* Model */}
            <div>
              <label className="block text-[12px] font-medium text-fg-muted">
                Model
              </label>
              <input
                type="text"
                value={llmModel}
                onChange={(e) => setLLMModel(e.target.value)}
                placeholder={
                  llmProvider === 'openrouter'
                    ? 'e.g. anthropic/claude-haiku-4-5'
                    : llmProvider === 'anthropic'
                      ? 'e.g. claude-sonnet-4-6'
                      : llmProvider === 'openai'
                        ? 'e.g. gpt-4o-mini'
                        : 'e.g. llama3.1'
                }
                className="input mt-1.5"
              />
              <p className="mt-1 text-[11px] text-fg-faint">
                Source: <span className="font-mono">{llmConfig.model_source}</span>
              </p>
            </div>

            {/* API key */}
            {llmProvider !== 'null' && llmProvider !== 'ollama' && (
              <div>
                <label className="block text-[12px] font-medium text-fg-muted">
                  API key
                </label>
                <div className="relative mt-1.5">
                  <Key
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
                  />
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={llmApiKey}
                    onChange={(e) => setLLMApiKey(e.target.value)}
                    placeholder={
                      llmConfig.has_api_key
                        ? `Leave blank to keep current key (${llmConfig.api_key_preview ?? '…'})`
                        : 'Paste your API key'
                    }
                    className="input pl-9 pr-10 font-mono"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                    aria-label={showApiKey ? 'Hide key' : 'Show key'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="mt-1 flex items-center gap-1 text-[11px] text-fg-faint">
                  <Info size={10} />
                  Keys are encrypted at rest with the server-side encryption key. Source:{' '}
                  <span className="font-mono">{llmConfig.api_key_source}</span>
                </p>
                {llmConfig.has_api_key && llmConfig.api_key_source === 'db' && (
                  <button
                    type="button"
                    onClick={handleClearApiKey}
                    className="mt-2 text-[11px] text-danger hover:underline"
                  >
                    Clear stored key
                  </button>
                )}
              </div>
            )}

            {llmProvider === 'ollama' && (
              <div className="rounded-lg border border-line bg-surface-1 px-3 py-2 text-[11px] text-fg-muted">
                Ollama runs locally and does not need an API key. Make sure
                ``OLLAMA_HOST`` points at a reachable Ollama instance from
                the backend container.
              </div>
            )}

            {llmProvider === 'null' && (
              <div className="rounded-lg border border-line bg-surface-1 px-3 py-2 text-[11px] text-fg-muted">
                Null provider returns templated responses so the UI works
                without real LLM credentials. Great for demos and CI.
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveLLMConfig}
                disabled={saving}
                className="btn-primary"
              >
                {saving ? (
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Saving...
                  </div>
                ) : (
                  <>
                    <Save size={16} />
                    Save AI settings
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
