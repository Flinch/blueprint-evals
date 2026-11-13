import type { PreviewData, RunResult, Turn } from '../../../src/ui/api-types'

// Shapes api-types.ts uses but does not export by name, derived from it so they cannot drift.
export type ModelPlan = NonNullable<PreviewData['models']['judge']>
export type ModelRef = NonNullable<RunResult['trace']['metadata']['models']['judge']>
export type ToolCall = NonNullable<Turn['toolCalls']>[number]
