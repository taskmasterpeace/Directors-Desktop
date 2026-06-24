import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { installBackendAuthInterceptor } from './lib/backend-auth'

// Attach the backend auth token to every backend request before anything renders.
installBackendAuthInterceptor()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
