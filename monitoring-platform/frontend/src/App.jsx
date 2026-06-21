import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { Settings, BarChart3, Activity, Database, BrainCircuit, Wrench } from 'lucide-react'
import SetupPage from './pages/SetupPage'
import DashboardPage from './pages/DashboardPage'
import CollectPage from './pages/CollectPage'
import AnalysePage from './pages/AnalysePage'
import RemediationPage from './pages/RemediationPage'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        {/* Navbar */}
        <header className="sticky top-0 z-30 bg-slate-950/90 backdrop-blur border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <Activity size={18} className="text-white" />
              </div>
              <div>
                <span className="font-bold text-white text-lg">Monitoring</span>
                <span className="font-bold text-indigo-400 text-lg"> Platform</span>
              </div>
            </div>

            <nav className="flex gap-1">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`
                }
              >
                <Settings size={15} />
                Configuration
              </NavLink>
              <NavLink
                to="/dashboard"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`
                }
              >
                <BarChart3 size={15} />
                Dashboard
              </NavLink>
              <NavLink
                to="/collect"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`
                }
              >
                <Database size={15} />
                Collecte
              </NavLink>
              <NavLink
                to="/analyse"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-violet-600/20 text-violet-400 border border-violet-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`
                }
              >
                <BrainCircuit size={15} />
                Analyse
              </NavLink>
              <NavLink
                to="/remediation"
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-amber-600/20 text-amber-400 border border-amber-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`
                }
              >
                <Wrench size={15} />
                Remédiation
              </NavLink>
            </nav>

            <a
              href="http://localhost:3001"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-slate-500 hover:text-indigo-400 transition-colors px-3 py-1.5
                         border border-slate-700 rounded-lg hover:border-indigo-500/50"
            >
              Grafana ↗
            </a>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1">
          <Routes>
            <Route path="/"          element={<SetupPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/collect"   element={<CollectPage />} />
            <Route path="/analyse"       element={<AnalysePage />} />
            <Route path="/remediation"   element={<RemediationPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
