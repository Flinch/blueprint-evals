import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | null
  error: unknown
  loading: boolean
  reload(): void
  setData(next: T | ((prev: T | null) => T | null)): void
}

/**
 * Runs `load` on mount and whenever `deps` change. A newer call wins: an older
 * answer that arrives late is dropped, so a stale filter cannot overwrite a
 * fresh one. `reload` runs it again and keeps the current data on screen.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const ticket = useRef(0)
  const loader = useRef(load)
  loader.current = load

  const run = useCallback(() => {
    const mine = ++ticket.current
    setLoading(true)
    loader
      .current()
      .then(d => {
        if (mine !== ticket.current) return
        setData(d)
        setError(null)
        setLoading(false)
      })
      .catch(e => {
        if (mine !== ticket.current) return
        setError(e)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    run()
    return () => {
      ticket.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, reload: run, setData }
}
