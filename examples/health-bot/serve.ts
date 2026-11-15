// Run: npm run health-bot                               (correct behavior)
//      npm run health-bot -- --defect=no-confirm         (a known-bad build)
//      PORT=4021 npm run health-bot -- --defect=no-confirm
//
// Binds to 127.0.0.1 only. The Anthropic credential comes from `.env` in the
// folder this is run from (see `.env.example`), or from the environment, or from
// an `ant auth login` profile, through the SDK. Without one the server still
// starts, and the first /chat answers 502 with a message saying credentials are missing.
import { loadDotEnv } from '../../src/env.js'
import { createHealthBot } from './bot.js'
import { DEFECTS, type Defect } from './prompt.js'
import { createTracerFromEnv } from './tracing.js'

const dotenv = loadDotEnv()

const defectArg = process.argv.find(a => a.startsWith('--defect='))?.slice('--defect='.length)
if (defectArg !== undefined && !(DEFECTS as readonly string[]).includes(defectArg)) {
  console.error(`unknown defect "${defectArg}". Known: ${DEFECTS.join(', ')}`)
  process.exit(2)
}

const port = Number(process.env.PORT ?? 4020)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be an integer from 0 to 65535, got "${process.env.PORT}"`)
  process.exit(2)
}

// Opt-in. Without both Langfuse keys this is a no-op that loads nothing.
const tracing = await createTracerFromEnv()

const bot = createHealthBot({ defect: defectArg as Defect | undefined, tracer: tracing.tracer })
const url = await bot.listen(port)
console.log(`health bot listening on ${url}`)
console.log(`active defect: ${defectArg ?? 'none (correct behavior)'}`)
console.log(`.env file: ${dotenv.found ? 'found' : 'not found (run from the blueprint-evals folder)'}`)
console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'NOT SET, every chat will answer 502'}`)
console.log(
  tracing.enabled
    ? `Langfuse tracing: on (${tracing.host})`
    : tracing.failed
      ? 'Langfuse tracing: off (could not start, see the line above)'
      : 'Langfuse tracing: off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env to turn it on)',
)

// Send the last traces before exiting. Only installed when tracing is on, so an untraced bot
// keeps the default Ctrl-C behavior. A second signal takes the default action and kills it.
if (tracing.enabled) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void tracing.tracer.shutdown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
    })
  }
}
