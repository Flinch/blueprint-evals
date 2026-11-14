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

const bot = createHealthBot({ defect: defectArg as Defect | undefined })
const url = await bot.listen(port)
console.log(`health bot listening on ${url}`)
console.log(`active defect: ${defectArg ?? 'none (correct behavior)'}`)
console.log(`.env file: ${dotenv.found ? 'found' : 'not found (run from the blueprint-evals folder)'}`)
console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'NOT SET, every chat will answer 502'}`)
