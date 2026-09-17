import React from 'react';
import ReactDOM from 'react-dom/client';

import { ThemeProvider } from '@ui5/webcomponents-react/ThemeProvider';
import './assets/ui5Assets.js';

import App from './app/App.jsx';
import { registerTelemetry } from './services/telemetryService.js';
import './styles/tokens.css';
import './styles/global.css';

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
