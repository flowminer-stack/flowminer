import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/store';

export default function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      await login({ email, password });
      navigate('/projects');
    } catch {
      setError('Invalid email or password. Please try again.');
    }
  };

  return (
    <div className="flex min-h-screen bg-surface-0">
      {/* Left panel */}
      <div className="hidden w-1/2 flex-col justify-between border-r border-line/60 p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
            <Activity className="text-white" size={16} strokeWidth={2.5} />
          </div>
          <span className="text-[15px] font-bold tracking-tight text-fg">
            FlowMiner
          </span>
        </div>

        <div className="max-w-sm">
          <h1 className="text-[2rem] font-bold leading-tight tracking-tight text-fg">
            Discover, analyze, and optimize your business processes.
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-fg-muted">
            Upload event logs, mine process models, identify bottlenecks, and
            gain actionable insights with our open-source process mining
            platform.
          </p>
        </div>

        <p className="text-[12px] text-fg-ghost">
          Open-source process mining platform.{' '}
          <span className="text-fg-faint">MIT licensed — embed, fork, self-host freely. No lock-in.</span>
        </p>
      </div>

      {/* Right panel */}
      <div className="flex w-full items-center justify-center px-6 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
              <Activity className="text-surface-0" size={16} />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-fg">
              FlowMiner
            </span>
          </div>

          <h2 className="text-xl font-bold tracking-tight text-fg">Welcome back</h2>
          <p className="mt-1 text-[13px] text-fg-muted">
            Sign in to your account to continue
          </p>

          {error && (
            <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-danger/20 bg-danger/5 px-3.5 py-3">
              <AlertCircle size={14} className="shrink-0 text-danger" />
              <p className="text-[13px] text-danger">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-[12px] font-medium text-fg-muted"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@company.com"
                className="input mt-1.5"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-[12px] font-medium text-fg-muted"
              >
                Password
              </label>
              <div className="relative mt-1.5">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="input pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="btn-primary w-full py-2.5"
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-surface-0/30 border-t-surface-0" />
                  Signing in...
                </div>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          <p className="mt-7 text-center text-[12px] text-fg-muted">
            Don&apos;t have an account?{' '}
            <Link
              to="/register"
              className="font-medium text-accent hover:text-accent-hover"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
