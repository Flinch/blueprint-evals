import type { UserSimulator } from '../core/interfaces.js'
import { ZERO_USAGE } from '../core/trace.js'

/**
 * A simulated user that says a fixed list of things, then ends the
 * conversation. For regression cases and for the framework's own tests, where
 * the user's side must be exactly reproducible and cost nothing.
 */
export function createScriptedSimulator(messages: string[]): UserSimulator {
  let next = 0
  return {
    async next() {
      const message = next < messages.length ? messages[next++]! : null
      return { message, usage: ZERO_USAGE }
    },
  }
}
