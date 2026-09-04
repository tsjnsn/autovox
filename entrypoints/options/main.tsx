import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/chrome-extension';
import {
  isManagedConfigured,
  managedPublishableKey,
} from '../../utils/managed';
import App from './App';
import './style.css';

const publishableKey = managedPublishableKey();
const app = <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isManagedConfigured() && publishableKey ? (
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl={browser.runtime.getURL('/options.html')}
        signInFallbackRedirectUrl={browser.runtime.getURL('/options.html')}
        signUpFallbackRedirectUrl={browser.runtime.getURL('/options.html')}
      >
        {app}
      </ClerkProvider>
    ) : (
      app
    )}
  </React.StrictMode>,
);
