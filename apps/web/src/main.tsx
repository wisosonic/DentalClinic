import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { makeStore } from './app/store';
import './i18n';
import { LanguageProviders } from './i18n/Providers';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={makeStore()}>
      <LanguageProviders>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </LanguageProviders>
    </Provider>
  </StrictMode>,
);
