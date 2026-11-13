import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { HealthResponse } from '../../src/ui/api-types'
import { ApiFailure, api } from './api/client'
import { Banner, Loading } from './components/ui'
import { href, stripTokenFromUrl, useLocation } from './lib/router'
import { applyTheme, initialTheme, saveTheme, type Theme } from './lib/theme'
import { CalibrationPage } from './pages/CalibrationPage'
import { ClassifyPage } from './pages/ClassifyPage'
import { LaunchPage } from './pages/LaunchPage'
import { OverviewPage } from './pages/OverviewPage'
import { RunDetailPage } from './pages/RunDetailPage'
import { RunsPage } from './pages/RunsPage'
import { ScenariosPage } from './pages/ScenariosPage'
import { HealthContext } from './state/HealthContext'
import { RunStreamProvider, useRunStream } from './state/RunStreamProvider'

// ---------------------------------------------------------------- error screen

export function ErrorScreen({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const failure = error instanceof ApiFailure ? error : null
  let title = 'Something went wrong'
  let body: ReactNode = error instanceof Error ? error.message : String(error)
  if (failure?.code === 'unauthorized') {
    title = 'Open the link from your terminal'
    body = (
      <>
        <p>This page needs the access token that <code>evals ui</code> printed when it started. Open the full URL it printed. It ends in <code>?token=...</code>.</p>
        <p>The token is random and new every time the server starts, so an old tab or bookmark stops working after a restart.</p>
      </>
    )
  } else if (failure?.code === 'network') {
    title = 'Cannot reach the evals server'
    body = (
      <>
        <p>The server may have stopped, or this page was opened from the wrong address.</p>
        <p>Start it again with <code>npx evals ui</code> and open the new link it prints.</p>
      </>
    )
  } else if (failure?.code === 'forbidden_host' || failure?.code === 'forbidden_origin') {
    title = 'The server refused this address'
    body = (
      <>
        <p>{failure.message}</p>
        <p>Open the link exactly as the terminal printed it. It uses 127.0.0.1 or localhost with the server's port.</p>
      </>
    )
  } else if (failure) {
    body = <p>{failure.message} <span className="muted small">({failure.code})</span></p>
  }
  return (
    <div className="error-screen">
      <div className="card" role="alert">
        <h1>{title}</h1>
        {typeof body === 'string' ? <p>{body}</p> : body}
        <div style={{ marginTop: '1.25rem' }}>
          <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>
        </div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------- shell

const NAV: { path: string; label: string; match: (p: string) => boolean }[] = [
  { path: '/', label: 'Overview', match: p => p === '/' },
  { path: '/runs', label: 'Runs', match: p => p === '/runs' || p.startsWith('/runs/') },
  { path: '/launch', label: 'Run scenarios', match: p => p === '/launch' },
  { path: '/classify', label: 'Classify', match: p => p.startsWith('/classify') },
  { path: '/calibration', label: 'Calibration', match: p => p === '/calibration' },
  { path: '/scenarios', label: 'Scenarios', match: p => p === '/scenarios' },
]

function LogoMark() {
  return (
    <svg className="sidebar-logo-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <rect x="10" y="10" width="80" height="80" stroke="currentColor" strokeWidth="6" />
      <path d="M27 67V27H67" stroke="currentColor" strokeWidth="6" />
    </svg>
  )
}

function Shell({ health, theme, onTheme }: { health: HealthResponse; theme: Theme; onTheme(t: Theme): void }) {
  const loc = useLocation()
  const { state } = useRunStream()
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => setNavOpen(false), [loc.path])

  const current = NAV.find(n => n.match(loc.path))
  const pageName = current?.label ?? 'Not found'
  useEffect(() => {
    document.title = `${pageName} | Blueprint Evals`
  }, [pageName])

  const job = state.activeJob
  const page = (() => {
    const p = loc.path
    if (p === '/') return <OverviewPage />
    if (p === '/runs') return <RunsPage />
    if (p.startsWith('/runs/')) {
      let id = p.slice('/runs/'.length)
      try {
        id = decodeURIComponent(id)
      } catch {
        // keep the raw text
      }
      return <RunDetailPage key={id} runId={id} />
    }
    if (p === '/launch') return <LaunchPage />
    if (p === '/classify') return <ClassifyPage tab="queue" onTab={t => loc.navigate(t === 'labels' ? '/classify/labels' : '/classify')} />
    if (p === '/classify/labels') return <ClassifyPage tab="labels" onTab={t => loc.navigate(t === 'labels' ? '/classify/labels' : '/classify')} />
    if (p === '/calibration') return <CalibrationPage />
    if (p === '/scenarios') return <ScenariosPage />
    return (
      <div className="card">
        <div className="empty-state">
          <h3>Page not found</h3>
          <p>There is no page at this address.</p>
          <a className="btn btn-primary" href={href('/')}>Back to the overview</a>
        </div>
      </div>
    )
  })()

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to content</a>
      <button type="button" className="sidebar-toggle" aria-label="Open the menu" aria-expanded={navOpen} onClick={() => setNavOpen(o => !o)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.8" /></svg>
      </button>
      <div className={`sidebar-scrim${navOpen ? ' open' : ''}`} onClick={() => setNavOpen(false)} aria-hidden="true" />
      <nav className={`sidebar${navOpen ? ' open' : ''}`} aria-label="Main">
        <div className="sidebar-logo">
          <LogoMark />
          <span>Blue<span className="sidebar-logo-accent">print</span></span>
        </div>
        <div className="sidebar-sub">Evals</div>
        <div className="sidebar-section">
          <div className="sidebar-label">Workspace</div>
          {NAV.map(n => {
            const active = n.match(loc.path)
            return (
              <a key={n.path} className={`sidebar-link${active ? ' active' : ''}`} href={href(n.path)} aria-current={active ? 'page' : undefined}>
                {n.label}
                {n.path === '/launch' && job ? <span className="count badge badge-running">{job.kind === 'run' ? 'Running' : 'Calibrating'}</span> : null}
              </a>
            )
          })}
        </div>
        <div className="sidebar-bottom">
          <button type="button" className="btn btn-ghost btn-sm theme-btn" onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
          <div className="footer-note" title={health.workdir}>v{health.version} &middot; {health.workdir}</div>
        </div>
      </nav>

      <div className="main">
        {health.demo ? (
          <div className="banner banner-demo" role="note">
            <div><strong>Demo data.</strong> Everything here is synthetic and made up for this demo. No model is called and nothing costs money.</div>
          </div>
        ) : null}
        <header className="topbar">
          <span className="topbar-title">{pageName}</span>
          <div className="topbar-actions">
            {job ? (
              <a className="badge badge-running" href={href('/launch')}>{job.kind === 'run' ? 'Run in progress' : 'Calibration running'}</a>
            ) : null}
            {state.connection === 'reconnecting' ? <span className="badge badge-warning" role="status">Reconnecting</span> : null}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="page-content" style={{ outline: 'none' }}>
          {state.connection === 'reconnecting' ? (
            <div style={{ marginBottom: '1rem' }}>
              <Banner kind="warning" role="status">Lost contact with the server. Trying again. If the server stopped, start it again and open the new link.</Banner>
            </div>
          ) : null}
          {page}
        </main>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------ app

type Boot = { status: 'loading' } | { status: 'ready'; health: HealthResponse } | { status: 'error'; error: unknown }

export function App() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' })
  const [theme, setTheme] = useState<Theme>(() => initialTheme())

  useEffect(() => {
    stripTokenFromUrl()
  }, [])
  useEffect(() => applyTheme(theme), [theme])

  const load = useCallback((quiet: boolean) => {
    if (!quiet) setBoot({ status: 'loading' })
    api
      .health()
      .then(health => setBoot({ status: 'ready', health }))
      .catch(error => {
        if (!quiet) setBoot({ status: 'error', error })
      })
  }, [])
  useEffect(() => load(false), [load])

  const health = boot.status === 'ready' ? boot.health : null
  const ctx = useMemo(() => (health ? { health, refresh: () => load(true) } : null), [health, load])

  if (boot.status === 'loading') {
    return (
      <div className="error-screen">
        <Loading label="Connecting to the evals server" />
      </div>
    )
  }
  if (boot.status === 'error' || !ctx || !health) {
    return <ErrorScreen error={boot.status === 'error' ? boot.error : new Error('No answer from the server')} onRetry={() => load(false)} />
  }

  return (
    <HealthContext.Provider value={ctx}>
      <RunStreamProvider>
        <Shell
          health={health}
          theme={theme}
          onTheme={t => {
            setTheme(t)
            saveTheme(t)
          }}
        />
      </RunStreamProvider>
    </HealthContext.Provider>
  )
}
