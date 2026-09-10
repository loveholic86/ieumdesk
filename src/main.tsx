import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { AuthProvider, AuthGate } from './auth';
import { WorkspaceSettingsProvider } from './workspace-settings';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <WorkspaceSettingsProvider><App /></WorkspaceSettingsProvider>
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>,
);
