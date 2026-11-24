import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@ui/styles/tokens.css';
import '@ui/styles/base.css';
import '@ui/styles/components.css';
import '@ui/styles/shell.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@ui/components/toast';
import { App } from './App';

// The License Manager follows the Windows light or dark setting.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => (document.documentElement.dataset['theme'] = dark.matches ? 'dark' : 'light');
applyTheme();
dark.addEventListener('change', applyTheme);

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
