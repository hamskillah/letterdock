import React from 'react';
import { createRoot } from 'react-dom/client';
import { DensityProvider } from './context/DensityContext.js';
import { ThemeProvider } from './context/ThemeContext.js';
import { App } from './App.js';
import './style.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <DensityProvider>
          <App />
        </DensityProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}
