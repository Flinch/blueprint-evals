import { useCallback, useEffect, useState } from 'react'

// Hash routing, no dependency. A location is a path and a query, both in the
// hash: #/runs?suite=abc&status=fail

export interface Location {
  path: string
  query: URLSearchParams
}

export function parseHash(hash: string): Location {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const qi = raw.indexOf('?')
  const pathPart = qi < 0 ? raw : raw.slice(0, qi)
  const queryPart = qi < 0 ? '' : raw.slice(qi + 1)
  const path = pathPart === '' ? '/' : pathPart.startsWith('/') ? pathPart : `/${pathPart}`
  return { path, query: new URLSearchParams(queryPart) }
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') q.set(k, v)
  const s = q.toString()
  return `#${path}${s ? `?${s}` : ''}`
}

export function runHref(runId: string): string {
  return `#/runs/${encodeURIComponent(runId)}`
}

/**
 * The Scenarios page's Rubrics tab with one criterion highlighted:
 * `#/scenarios?tab=rubrics&rubric=<id>&criterion=<id>`. Without a rubric id the
 * page opens the first rubric that has the criterion.
 */
export function criterionHref(criterion: string, rubric?: string | null): string {
  return href('/scenarios', { tab: 'rubrics', rubric: rubric ?? undefined, criterion })
}

/** The Findings page with its filters in the address, so a reload or a shared link keeps them. */
export function findingsHref(filters: { since?: string; rubric?: string; criterion?: string } = {}): string {
  return href('/findings', filters)
}

export interface Router extends Location {
  navigate(to: string, opts?: { replace?: boolean }): void
}

export function useLocation(): Router {
  const [loc, setLoc] = useState<Location>(() => parseHash(window.location.hash))
  useEffect(() => {
    const on = () => setLoc(parseHash(window.location.hash))
    window.addEventListener('hashchange', on)
    on()
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const navigate = useCallback((to: string, opts: { replace?: boolean } = {}) => {
    const hash = to.startsWith('#') ? to : `#${to}`
    if (opts.replace) {
      const url = new URL(window.location.href)
      url.hash = hash
      window.history.replaceState(null, '', url)
      setLoc(parseHash(hash))
    } else {
      window.location.hash = hash
    }
  }, [])
  return { ...loc, navigate }
}

/** Takes ?token= out of the address bar if it is ever there. The server already redirects, so this is a safety net. */
export function stripTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('token')) return
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url)
  } catch {
    // ignore
  }
}
