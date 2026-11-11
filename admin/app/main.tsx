import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { DialogsProvider } from '@/components/dialogs';
import { RouteErrorBoundary } from '@/components/error-pages';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import './styles.css';

const basename = window.location.pathname.startsWith('/app') ? '/app' : '/admin';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <TooltipProvider>
        <DialogsProvider>
          {/* Last line of defence for errors outside the routed screens (layout, boot). */}
          <RouteErrorBoundary>
            <App />
          </RouteErrorBoundary>
        </DialogsProvider>
        <Toaster richColors position="top-right" />
      </TooltipProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
