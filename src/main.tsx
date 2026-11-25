import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if ('serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        registration.update().catch(() => {});
      }
    },
    onRegisterError(err) {
      console.warn('Service worker registration notice:', err);
    },
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
