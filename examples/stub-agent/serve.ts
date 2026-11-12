// Run: npm run stub-agent            (correct behavior)
//      npm run stub-agent -- --defect=no-confirm
import { createStubAgent } from './agent.js'

const defectArg = process.argv.find(a => a.startsWith('--defect='))?.slice('--defect='.length)
if (defectArg && defectArg !== 'no-confirm') {
  console.error(`unknown defect "${defectArg}". Known: no-confirm`)
  process.exit(2)
}
const port = Number(process.env.PORT ?? 4010)
const agent = createStubAgent({ defect: defectArg as 'no-confirm' | undefined })
const url = await agent.listen(port)
console.log(`stub agent listening on ${url}${defectArg ? ` (planted defect: ${defectArg})` : ''}`)
