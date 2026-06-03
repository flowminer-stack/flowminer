import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { useUIStore } from '@/store';
import { X, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import clsx from 'clsx';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ShortcutsModal from '@/components/common/ShortcutsModal';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { ProductTour } from '@/components/Onboarding/ProductTour';
import FloatingAIChat from '@/components/AI/FloatingAIChat';

const notificationIcons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const notificationStyles = {
  success: 'border-success/20 bg-success/5 text-success',
  error: 'border-danger/20 bg-danger/5 text-danger',
  warning: 'border-warning/20 bg-warning/5 text-warning',
  info: 'border-accent/20 bg-accent/5 text-accent-hover',
};

const notificationIconStyles = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-accent',
};

export default function Layout() {
  const notifications = useUIStore((s) => s.notifications);
  const removeNotification = useUIStore((s) => s.removeNotification);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);

  useKeyboardShortcuts();

  return (
    <div className="min-h-screen bg-surface-0">
      <Sidebar />

      <div
        className={clsx(
          'transition-sidebar',
          sidebarOpen ? 'lg:ml-56' : 'lg:ml-[52px]',
        )}
      >
        <Header />
        <main className="p-6">
          <ErrorBoundary>
            {/* Suspense lives here — inside the layout — so first-time
                lazy page chunks only swap the <main> content for the
                spinner. The sidebar + header above stay mounted, which
                is what kept the whole page from flashing on a tab's
                first visit. */}
            <Suspense
              fallback={
                <div className="flex min-h-[60vh] items-center justify-center">
                  <LoadingSpinner size="md" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <ShortcutsModal />
      <ProductTour />
      <FloatingAIChat />

      {/* Toast notifications */}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2">
        {notifications.map((notification) => {
          const Icon = notificationIcons[notification.type];
          return (
            <div
              key={notification.id}
              className={clsx(
                'flex w-[300px] items-start gap-3 rounded-xl border p-3.5 animate-slide-up backdrop-blur-xl',
                notificationStyles[notification.type],
              )}
              style={{ boxShadow: 'var(--shadow-xl)' }}
            >
              <Icon
                size={15}
                className={clsx(
                  'mt-0.5 shrink-0',
                  notificationIconStyles[notification.type],
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold">{notification.title}</p>
                {notification.message && (
                  <p className="mt-0.5 text-[11px] opacity-70">
                    {notification.message}
                  </p>
                )}
              </div>
              <button
                onClick={() => removeNotification(notification.id)}
                className="shrink-0 rounded p-0.5 opacity-40 transition-opacity hover:opacity-80"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
