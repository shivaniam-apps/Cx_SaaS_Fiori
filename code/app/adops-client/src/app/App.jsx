import { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import AdopsShell from '../layouts/AdopsShell.jsx';
import MemberGate from '../components/MemberGate.jsx';
import AppErrorBoundary from '../components/AppErrorBoundary.jsx';
import { trackPageView, measureRouteRender } from '../services/telemetryService.js';
import DashboardPage from '../pages/DashboardPage.jsx';
import TargetSystemsPage from '../pages/TargetSystemsPage.jsx';
import ExtractionsPage from '../pages/ExtractionsPage.jsx';
import UsageInsightPage from '../pages/UsageInsightPage.jsx';
import LandscapePage from '../pages/LandscapePage.jsx';
import ProposalsPage from '../pages/ProposalsPage.jsx';
import AdoptionWavesPage from '../pages/AdoptionWavesPage.jsx';
import TransportsPage from '../pages/TransportsPage.jsx';
import ActivationPlansPage from '../pages/ActivationPlansPage.jsx';
import ActivationRunsPage from '../pages/ActivationRunsPage.jsx';
import AccessRequestsPage from '../pages/AccessRequestsPage.jsx';
import SettingsPage from '../pages/SettingsPage.jsx';
import AuditLogPage from '../pages/AuditLogPage.jsx';
import ProductInsightsPage from '../pages/ProductInsightsPage.jsx';

// Route table follows the optional-param convention (/usage/:view?) so tab
// switches and detail columns never remount their page.
function AppRoutes({ userInfo }) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<DashboardPage userInfo={userInfo} />} />
      <Route path="/systems/:systemId?" element={<TargetSystemsPage />} />
      <Route path="/extractions/:extractionId?" element={<ExtractionsPage />} />
      <Route path="/usage/:view?" element={<UsageInsightPage />} />
      <Route path="/landscape/:view?" element={<LandscapePage />} />
      <Route path="/proposals/:proposalId?" element={<ProposalsPage />} />
      <Route path="/waves/:waveId?" element={<AdoptionWavesPage />} />
      <Route path="/activation/:planId?" element={<ActivationPlansPage />} />
      <Route path="/activation-runs/:runId?" element={<ActivationRunsPage />} />
      <Route path="/transports/:trId?" element={<TransportsPage />} />
      <Route path="/settings/:view?" element={<SettingsPage />} />
      <Route path="/audit-log" element={<AuditLogPage />} />
      <Route path="/access-requests" element={<AccessRequestsPage />} />
      <Route path="/product-insights/:view?" element={<ProductInsightsPage />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

function ShellWithBoundary({ userInfo }) {
  const location = useLocation();
  // Usage telemetry per route change (raw pathname, so detail routes count
  // too); slow renders are recorded by the capture policy in measureRouteRender.
  useEffect(() => {
    const route = `#${location.pathname}`;
    trackPageView(route);
    measureRouteRender(route);
  }, [location.pathname]);

  return (
    <AdopsShell userInfo={userInfo}>
      {/* Keyed on the PAGE (first path segment), not the full pathname: a
          crash on one page never strands the app, while /page/:view tab
          switches and detail routes keep the page mounted with its state
          (fiori-ux.md, Page-Level Tabs). "Try again" resets the boundary
          within a page. */}
      <AppErrorBoundary key={location.pathname.split('/')[1] || 'root'}>
        <AppRoutes userInfo={userInfo} />
      </AppErrorBoundary>
    </AdopsShell>
  );
}

export default function App() {
  return (
    <HashRouter>
      <MemberGate>{(userInfo) => <ShellWithBoundary userInfo={userInfo} />}</MemberGate>
    </HashRouter>
  );
}
