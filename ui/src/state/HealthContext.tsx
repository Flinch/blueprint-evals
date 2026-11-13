import { createContext, useContext } from 'react'
import type { HealthResponse } from '../../../src/ui/api-types'

export interface HealthCtx {
  health: HealthResponse
  /** Re-reads /api/health (after a run ends, say). */
  refresh(): void
}

export const HealthContext = createContext<HealthCtx | null>(null)

export function useHealth(): HealthCtx {
  const ctx = useContext(HealthContext)
  if (!ctx) throw new Error('useHealth must be used inside the app shell')
  return ctx
}
