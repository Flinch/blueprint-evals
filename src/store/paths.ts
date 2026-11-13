import { join, resolve } from 'node:path'

// Where everything the tool saves lives. One directory per working directory:
//
//   <workdir>/.evals/runs/<suiteId>.json        one record per run of the suite
//   <workdir>/.evals/calibration/<id>.json      one record per calibration
//   <workdir>/.evals/labels.jsonl               human labels (the default file)

export const DATA_DIR = '.evals'

export interface StorePaths {
  root: string
  runs: string
  calibration: string
  labels: string
}

export function storePaths(workdir: string): StorePaths {
  const root = join(resolve(workdir), DATA_DIR)
  return { root, runs: join(root, 'runs'), calibration: join(root, 'calibration'), labels: join(root, 'labels.jsonl') }
}
