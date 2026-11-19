import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionProvider } from '../auth/SessionContext.tsx'
import { AdminApp } from './AdminApp.tsx'
import '../index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <AdminApp />
    </SessionProvider>
  </StrictMode>,
)
