import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Target as TargetIcon, BarChart3 as BarChartIcon } from 'lucide-react';
import { useAuthStore } from '@/store';
import Layout from '@/components/Layout/Layout';
import LoadingSpinner from '@/components/common/LoadingSpinner';

// ─── Pages (lazy-loaded — each becomes its own chunk) ────────────────────────
// Login / onboarding stay eager (small, used on first paint).
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';

const ProjectsPage = lazy(() => import('@/pages/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('@/pages/ProjectDetailPage'));
const ProjectPickerPage = lazy(() => import('@/pages/ProjectPickerPage'));
const OverviewPage = lazy(() => import('@/pages/OverviewPage'));
const InboxPage = lazy(() => import('@/pages/InboxPage'));
const UploadPage = lazy(() => import('@/pages/UploadPage'));
const ProcessViewPage = lazy(() => import('@/pages/ProcessViewPage'));
const VariantsPage = lazy(() => import('@/pages/VariantsPage'));
const BottlenecksPage = lazy(() => import('@/pages/BottlenecksPage'));
const DriftPage = lazy(() => import('@/pages/DriftPage'));
const ConformancePage = lazy(() => import('@/pages/ConformancePage'));
const RootCausePage = lazy(() => import('@/pages/RootCausePage'));
const DashboardsPage = lazy(() => import('@/pages/DashboardsPage'));
const DashboardViewPage = lazy(() => import('@/pages/DashboardViewPage'));
const SharedDashboardPage = lazy(() => import('@/pages/SharedDashboardPage'));
const AlertsPage = lazy(() => import('@/pages/AlertsPage'));
const ConnectorsPage = lazy(() => import('@/pages/ConnectorsPage'));
const TemplatesPage = lazy(() => import('@/pages/TemplatesPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const DottedChartPage = lazy(() => import('@/pages/DottedChartPage'));
const SocialNetworkPage = lazy(() => import('@/pages/SocialNetworkPage'));
const ReworkPage = lazy(() => import('@/pages/ReworkPage'));
const ComparisonPage = lazy(() => import('@/pages/ComparisonPage'));
const OCPMPage = lazy(() => import('@/pages/OCPMPage'));
const SimulationPage = lazy(() => import('@/pages/SimulationPage'));
const UserManagementPage = lazy(() => import('@/pages/UserManagementPage'));
const InitiativesPage = lazy(() => import('@/pages/InitiativesPage'));
const SustainabilityPage = lazy(() => import('@/pages/SustainabilityPage'));
const BenchmarkPage = lazy(() => import('@/pages/BenchmarkPage'));
const EventLogBuilderPage = lazy(() => import('@/pages/EventLogBuilderPage'));
const ProcessAnimationPage = lazy(() => import('@/pages/ProcessAnimationPage'));
const AuditLogPage = lazy(() => import('@/pages/AuditLogPage'));
const TaskMiningPage = lazy(() => import('@/pages/TaskMiningPage'));
const MissionControlPage = lazy(() => import('@/pages/MissionControlPage'));
const ProcessGovernancePage = lazy(() => import('@/pages/ProcessGovernancePage'));
const EACapabilityMapPage = lazy(() => import('@/pages/EACapabilityMapPage'));
const AutomationRoiPage = lazy(() => import('@/pages/AutomationRoiPage'));
const ProcessHealthPage = lazy(() => import('@/pages/ProcessHealthPage'));
const CausalMapPage = lazy(() => import('@/pages/CausalMapPage'));
const ProcessPulsePage = lazy(() => import('@/pages/ProcessPulsePage'));
const ProcessCityPage = lazy(() => import('@/pages/ProcessCityPage'));
const CasesAtRiskPage = lazy(() => import('@/pages/CasesAtRiskPage'));
const ActionRulesPage = lazy(() => import('@/pages/ActionRulesPage'));
const LineagePage = lazy(() => import('@/pages/LineagePage'));
const KpisPage = lazy(() => import('@/pages/KpisPage'));
const JourneyMapPage = lazy(() => import('@/pages/JourneyMapPage'));
const ScheduledReportsPage = lazy(() => import('@/pages/ScheduledReportsPage'));
const UsageAdminPage = lazy(() => import('@/pages/UsageAdminPage'));

// ─── Protected Route ─────────────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const token = useAuthStore((s) => s.token);
  const demoMode = useAuthStore((s) => s.demoMode);

  // In demo mode the bootstrap effect in App acquires a token
  // asynchronously. Hold here instead of bouncing to /login, which
  // would briefly show a login page the user can't actually use.
  if (demoMode && !token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0">
        <LoadingSpinner size="lg" text="Loading demo…" />
      </div>
    );
  }

  if (!isAuthenticated && !token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// ─── Public Route (redirect to /projects if already logged in) ───────────────

function PublicRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const demoMode = useAuthStore((s) => s.demoMode);

  // Demo instance: even the login page redirects into the app —
  // there's no registration flow and nobody should see the login
  // form on demo.flowminer.io.
  if (demoMode || isAuthenticated) {
    return <Navigate to="/projects" replace />;
  }

  return <>{children}</>;
}

// ─── Admin Route (defense-in-depth) ──────────────────────────────────────────

function AdminRoute({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  // Wait for the user to load before deciding, so a non-admin never briefly
  // sees an admin page during hydration. ProtectedRoute already gates auth and
  // the backend enforces admin on these endpoints — this is belt-and-braces.
  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0">
        <LoadingSpinner size="lg" />
      </div>
    );
  }
  if (user.role !== 'admin') {
    return <Navigate to="/projects" replace />;
  }
  return <>{children}</>;
}

const LazyFallback = (
  <div className="flex min-h-[60vh] items-center justify-center">
    <LoadingSpinner size="md" />
  </div>
);

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const validateToken = useAuthStore((s) => s.validateToken);
  const bootstrapDemo = useAuthStore((s) => s.bootstrapDemo);
  const token = useAuthStore((s) => s.token);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const bootstrapChecked = useAuthStore((s) => s.bootstrapChecked);
  const demoMode = useAuthStore((s) => s.demoMode);
  const navigate = useNavigate();

  // On first mount: run demo detection + token validation. If the
  // backend is in DEMO_MODE, bootstrapDemo acquires an anonymous JWT
  // so the visitor lands straight in the app. Otherwise validateToken
  // revives an existing session if one is cached.
  useEffect(() => {
    (async () => {
      await bootstrapDemo();
      if (useAuthStore.getState().token && !useAuthStore.getState().user) {
        await validateToken();
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hold the route tree until bootstrapDemo has resolved. Without
  // this, a fresh visitor to demo.flowminer.io would see a flash of
  // /login because isAuthenticated/demoMode are still false on the
  // first synchronous render, causing the root / redirect to bounce
  // them to the login page before the demo JWT arrives.
  if (!bootstrapChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0">
        <LoadingSpinner size="lg" text="Loading FlowMiner..." />
      </div>
    );
  }

  // Show a brief loading state while validating token
  if (token && !isAuthenticated && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0">
        <LoadingSpinner size="lg" text="Loading FlowMiner..." />
      </div>
    );
  }

  return (
    <Suspense fallback={LazyFallback}>
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={
            <PublicRoute>
              <LoginPage />
            </PublicRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicRoute>
              <RegisterPage />
            </PublicRoute>
          }
        />

        {/* Shared dashboard (public access) */}
        <Route path="/dashboards/shared/:shareToken" element={<SharedDashboardPage />} />

        {/* Protected routes with layout */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/upload/:projectId" element={<UploadPage />} />
          <Route path="/process/:eventLogId" element={<ProcessViewPage />} />
          <Route path="/variants/:eventLogId" element={<VariantsPage />} />
          <Route path="/bottlenecks/:eventLogId" element={<BottlenecksPage />} />
          <Route path="/drift/:eventLogId" element={<DriftPage />} />
          <Route path="/conformance/:eventLogId" element={<ConformancePage />} />
          <Route path="/root-cause/:eventLogId" element={<RootCausePage />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/dashboards/:dashboardId" element={<DashboardViewPage />} />
          <Route path="/dotted-chart/:eventLogId" element={<DottedChartPage />} />
          <Route path="/social-network/:eventLogId" element={<SocialNetworkPage />} />
          <Route path="/rework/:eventLogId" element={<ReworkPage />} />
          <Route path="/comparison/:eventLogId" element={<ComparisonPage />} />
          <Route path="/simulate/:eventLogId" element={<SimulationPage />} />
          <Route
            path="/initiatives"
            element={
              <ProjectPickerPage
                title="Initiatives"
                description="Track savings initiatives across your projects. Pick a project to view or create initiatives."
                icon={TargetIcon}
                nextPathTemplate="/initiatives/:projectId"
              />
            }
          />
          <Route path="/initiatives/:projectId" element={<InitiativesPage />} />
          <Route path="/sustainability/:eventLogId" element={<SustainabilityPage />} />
          <Route path="/automation-roi/:eventLogId" element={<AutomationRoiPage />} />
          <Route path="/health/:eventLogId" element={<ProcessHealthPage />} />
          <Route path="/cases-at-risk/:eventLogId" element={<CasesAtRiskPage />} />
          <Route path="/causal-map/:eventLogId" element={<CausalMapPage />} />
          <Route path="/pulse/:eventLogId" element={<ProcessPulsePage />} />
          <Route path="/process-city/:eventLogId" element={<ProcessCityPage />} />
          <Route
            path="/benchmark"
            element={
              <ProjectPickerPage
                title="Benchmark"
                description="Compare process KPIs across event logs. Pick a project to run a benchmark."
                icon={BarChartIcon}
                nextPathTemplate="/benchmark/:projectId"
              />
            }
          />
          <Route path="/benchmark/:projectId" element={<BenchmarkPage />} />
          <Route path="/builder/:projectId" element={<EventLogBuilderPage />} />
          <Route path="/animation/:eventLogId" element={<ProcessAnimationPage />} />
          <Route path="/task-mining/:projectId" element={<TaskMiningPage />} />
          <Route path="/mission-control/:eventLogId" element={<MissionControlPage />} />
          <Route path="/governance" element={<ProcessGovernancePage />} />
          <Route path="/capability-map" element={<EACapabilityMapPage />} />
          <Route path="/ocpm" element={<OCPMPage />} />
          <Route path="/ocpm/:eventLogId" element={<OCPMPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/action-rules" element={<ActionRulesPage />} />
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin/users" element={<AdminRoute><UserManagementPage /></AdminRoute>} />
          <Route path="/admin/audit" element={<AdminRoute><AuditLogPage /></AdminRoute>} />
          <Route path="/admin/usage" element={<AdminRoute><UsageAdminPage /></AdminRoute>} />
          <Route path="/lineage/:eventLogId" element={<LineagePage />} />
          <Route path="/kpis" element={<KpisPage />} />
          <Route path="/kpis/:projectId" element={<KpisPage />} />
          <Route path="/journeys/:projectId" element={<JourneyMapPage />} />
          <Route path="/scheduled-reports/:projectId" element={<ScheduledReportsPage />} />
        </Route>

        {/* Redirect root — demoMode visitors always land in /projects. */}
        <Route
          path="/"
          element={
            isAuthenticated || demoMode ? (
              <Navigate to="/projects" replace />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

        {/* 404 */}
        <Route
          path="*"
          element={
            <div className="flex min-h-screen flex-col items-center justify-center bg-surface-0">
              <h1 className="text-5xl font-bold text-fg-ghost">404</h1>
              <p className="mt-2 text-[14px] text-fg-muted">Page not found</p>
              <button onClick={() => navigate('/projects')} className="btn-primary mt-5">
                Go to Projects
              </button>
            </div>
          }
        />
      </Routes>
    </Suspense>
  );
}
