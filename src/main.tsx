import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initRum } from './observability'
import './styles/globals.css'

initRum()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
