import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, AlertCircle } from 'lucide-react';
import { auth as authApi } from '@/api/client';
import { useAuthStore } from '@/store';

// Set-password page for the emailed activation link
// (/activate?token=…). Used by the bootstrap-admin flow and any operator who
// creates a pending user. On success it signs the user straight in.
export default function ActivatePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);
  const validateToken = useAuthStore((s) => s.validateToken);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const { access_token } = await authApi.activate(token, password);
      setToken(access_token);
      await validateToken();
      navigate('/projects');
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'This activation link is invalid or has expired.';
      setError(typeof detail === 'string' ? detail : 'Activation failed.');
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
            <Activity className="text-surface-0" size={16} />
          </div>
          <span className="text-[15px] font-bold tracking-tight text-fg">FlowMiner</span>
        </div>

        <h2 className="text-xl font-bold tracking-tight text-fg">Set your password</h2>
        <p className="mt-1 text-[13px] text-fg-muted">
          Choose a strong password to activate your account.
        </p>

        {!token && (
          <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-danger/20 bg-danger/5 px-3.5 py-3">
            <AlertCircle size={14} className="shrink-0 text-danger" />
            <p className="text-[13px] text-danger">This link is missing its token. Use the link from your email.</p>
          </div>
        )}

        {error && (
          <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-danger/20 bg-danger/5 px-3.5 py-3">
            <AlertCircle size={14} className="shrink-0 text-danger" />
            <p className="text-[13px] text-danger">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-7 space-y-4">
          <div>
            <label htmlFor="password" className="block text-[12px] font-medium text-fg-muted">
              New password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="At least 10 characters"
              className="input mt-1.5"
            />
          </div>
          <div>
            <label htmlFor="confirm" className="block text-[12px] font-medium text-fg-muted">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="Re-enter password"
              className="input mt-1.5"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !token || !password || !confirm}
            className="btn-primary w-full py-2.5"
          >
            {loading ? 'Activating…' : 'Activate account'}
          </button>
        </form>

        <p className="mt-7 text-center text-[12px] text-fg-muted">
          Already activated?{' '}
          <Link to="/login" className="font-medium text-accent hover:text-accent-hover">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
