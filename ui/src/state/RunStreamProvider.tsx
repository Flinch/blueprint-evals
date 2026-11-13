import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import type { ActiveJob, RunStreamEvent, StreamHello } from '../../../src/ui/api-types'
import { initialStreamState, streamReducer, type RunStreamState } from './runStream'

// One EventSource for the whole page. The browser reconnects by itself and
// sends Last-Event-ID, so the server replays only what was missed. If the
// browser gives up (a non-200 answer closes the stream for good) the provider
// opens a new one after a short wait.

const EVENT_TYPES = ['suite:start', 'run:start', 'turn', 'grader:done', 'run:end', 'suite:end', 'error'] as const
const RETRY_MS = 3000

interface Ctx {
  state: RunStreamState
  /** Tells the provider about a job from /api/health or /api/run/status, until the stream's own hello arrives. */
  seedJob(job: ActiveJob | null): void
}

const StreamContext = createContext<Ctx | null>(null)

export function RunStreamProvider({ children, url = '/api/run/events' }: { children: ReactNode; url?: string }) {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const connect = () => {
      if (stopped) return
      const es = new EventSource(url)
      source = es
      es.onopen = () => dispatch({ type: 'connection', state: 'open' })
      es.onerror = () => {
        dispatch({ type: 'connection', state: 'reconnecting' })
        if (es.readyState === 2 /* CLOSED */ && !stopped) {
          es.close()
          timer = setTimeout(connect, RETRY_MS)
        }
      }
      es.addEventListener('hello', ev => {
        try {
          dispatch({ type: 'connection', state: 'open' })
          dispatch({ type: 'hello', hello: JSON.parse((ev as MessageEvent<string>).data) as StreamHello })
        } catch {
          // A frame that does not parse is dropped.
        }
      })
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, ev => {
          // "error" is also the name of the connection-failure event. Only a frame with data is ours.
          const data = (ev as MessageEvent<unknown>).data
          if (typeof data !== 'string') return
          try {
            dispatch({ type: 'event', event: JSON.parse(data) as RunStreamEvent })
          } catch {
            // dropped
          }
        })
      }
    }
    connect()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      source?.close()
    }
  }, [url])

  // A stable function, so an effect that calls it does not run again on every state change.
  const seedJob = useCallback((job: ActiveJob | null) => dispatch({ type: 'seed-job', job }), [])
  const value = useMemo<Ctx>(() => ({ state, seedJob }), [state, seedJob])
  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
}

export function useRunStream(): Ctx {
  const ctx = useContext(StreamContext)
  if (!ctx) throw new Error('useRunStream must be used inside RunStreamProvider')
  return ctx
}
