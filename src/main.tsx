import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { SessionProvider } from './auth/SessionContext.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </SessionProvider>
  </StrictMode>,
)
