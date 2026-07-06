import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/styles/tokens.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Root element with id "root" was not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
