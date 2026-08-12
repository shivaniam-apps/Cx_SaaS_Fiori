import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import AdopsShell from '../layouts/AdopsShell.jsx';
import MemberGate from '../components/MemberGate.jsx';
import AppErrorBoundary from '../components/AppErrorBoundary.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';
import PlaceholderPage from '../pages/PlaceholderPage.jsx';
import TargetSystemsPage from '../pages/TargetSystemsPage.jsx';
import ExtractionsPage from '../pages/ExtractionsPage.jsx';
import UsageInsightPage from '../pages/UsageInsightPage.jsx';
import ProposalsPage from '../pages/ProposalsPage.jsx';

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
      <Route path="/landscape/:view?" element={<PlaceholderPage title="User & Role Landscape" phase="Phase 2" />} />
      <Route path="/proposals/:proposalId?" element={<ProposalsPage />} />
      <Route path="/waves/:waveId?" element={<PlaceholderPage title="Adoption Waves" phase="Phase 3" />} />
      <Route path="/activation/:planId?" element={<PlaceholderPage title="Activation Plans" phase="Phase 3" />} />
      <Route path="/activation-runs/:runId?" element={<PlaceholderPage title="Activation Runs" phase="Phase 3" />} />
      <Route path="/transports/:trId?" element={<PlaceholderPage title="Transports" phase="Phase 3" />} />
      <Route path="/settings/:view?" element={<PlaceholderPage title="Settings" phase="Phase 1" />} />
      <Route path="/audit-log" element={<PlaceholderPage title="Audit Log" phase="Phase 2" />} />
      <Route path="/access-requests" element={<PlaceholderPage title="Access Requests" phase="Phase 1" />} />
      <Route path="/product-insights/:view?" element={<PlaceholderPage title="Product Insights" phase="Phase 2" />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

function ShellWithBoundary({ userInfo }) {
  const location = useLocation();
  return (
    <AdopsShell userInfo={userInfo}>
      {/* Keyed on pathname: a crash on one page never strands the app. */}
      <AppErrorBoundary key={location.pathname}>
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
