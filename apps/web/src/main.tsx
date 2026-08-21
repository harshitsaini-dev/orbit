import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { AuthProvider } from './lib/auth.js';
import { ThemeProvider } from './lib/theme.js';
import { UploadsProvider } from './lib/uploads.js';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          {/* Inside the router and the theme, so the fallback screen is styled
              like the rest of Orbit and its links actually navigate. */}
          {/* Above the router: an upload has to survive navigating away from
              the folder that started it. */}
          <UploadsProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </UploadsProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
