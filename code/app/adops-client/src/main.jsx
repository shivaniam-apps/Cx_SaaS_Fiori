import React from 'react';
import ReactDOM from 'react-dom/client';

import { ThemeProvider } from '@ui5/webcomponents-react/ThemeProvider';
import './assets/ui5Assets.js';

import App from './app/App.jsx';
import './styles/tokens.css';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
