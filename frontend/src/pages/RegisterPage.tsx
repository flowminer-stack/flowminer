import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { auth } from '@/api/client';
import { useAuthStore } from '@/store';

export default function RegisterPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      await auth.register({ email, password, full_name: fullName });
      await login({ email, password });
      navigate('/projects');
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Registration failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-surface-0">
      {/* Left panel */}
      <div className="hidden w-1/2 flex-col justify-between border-r border-line/60 p-12 lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
            <Activity className="text-surface-0" size={16} />
          </div>
          <span className="text-[15px] font-bold tracking-tight text-fg">
            FlowMiner
          </span>
        </div>

        <div className="max-w-sm">
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg">
            Start mining your processes today.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
            Create a free account and begin discovering insights hidden in your
            event data.
          </p>

          <div className="mt-8 space-y-3">
            {[
              'Upload CSV, XES, or Excel event logs',
              'Automatic process model discovery',
              'Bottleneck and root cause analysis',
              'Custom dashboards and alerts',
            ].map((feature) => (
              <div key={feature} className="flex items-center gap-2.5">
                <div className="h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span className="text-[13px] text-fg-muted">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[12px] text-fg-ghost">
          Open-source process mining for everyone.{' '}
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

          <h2 className="text-xl font-bold tracking-tight text-fg">
            Create your account
          </h2>
          <p className="mt-1 text-[13px] text-fg-muted">
            Get started with FlowMiner in seconds
          </p>

          {error && (
            <div className="mt-5 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5">
              <AlertCircle size={14} className="shrink-0 text-danger" />
              <p className="text-[12px] text-danger">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            <div>
              <label htmlFor="fullName" className="block text-[12px] font-medium text-fg-muted">
                Full name
              </label>
              <input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                autoComplete="name"
                placeholder="Jane Smith"
                className="input mt-1.5"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-[12px] font-medium text-fg-muted">
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
              <label htmlFor="password" className="block text-[12px] font-medium text-fg-muted">
                Password
              </label>
              <div className="relative mt-1.5">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
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

            <div>
              <label htmlFor="confirmPassword" className="block text-[12px] font-medium text-fg-muted">
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="Repeat your password"
                className="input mt-1.5"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !fullName || !email || !password || !confirmPassword}
              className="btn-primary w-full py-2.5"
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-surface-0/30 border-t-surface-0" />
                  Creating account...
                </div>
              ) : (
                'Create account'
              )}
            </button>
          </form>

          <p className="mt-7 text-center text-[12px] text-fg-muted">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-accent hover:text-accent-hover"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
