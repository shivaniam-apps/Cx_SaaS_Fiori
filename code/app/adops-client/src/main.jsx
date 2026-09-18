import React from 'react';
import ReactDOM from 'react-dom/client';

import { ThemeProvider } from '@ui5/webcomponents-react/ThemeProvider';
import './assets/ui5Assets.js';

import App from './app/App.jsx';
import { registerTelemetry } from './services/telemetryService.js';
import { hashRouteFor } from './features/app/deepLink.js';
import './styles/tokens.css';
import './styles/global.css';

// A deep link in path form (/audit-log, /transports?status=OPEN) becomes
// its hash route before the HashRouter mounts, so bookmarks and shared
// links open the page they name instead of the Dashboard (I41).
const hashRoute = hashRouteFor(window.location, import.meta.env.BASE_URL);
if (hashRoute) window.history.replaceState(null, '', hashRoute);

// Once per page load: settings fetch, API timing listener, app-load timing,
// page-hide flush. Guarded inside against StrictMode / HMR double calls.
registerTelemetry();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
