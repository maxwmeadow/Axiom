export type OnboardingStage =
  | 'baseline'
  | 'sheet'
  | 'draw'
  | 'dispatch'
  | 'build'
  | 'complete'

export interface OnboardingSignals {
  baselineReady: boolean
  sheetReady: boolean
  planned: boolean
  dispatched: boolean
  realized: boolean
}

export function onboardingStage(signals: OnboardingSignals): OnboardingStage {
  if (!signals.baselineReady) return 'baseline'
  if (!signals.sheetReady) return 'sheet'
  if (!signals.planned) return 'draw'
  if (!signals.dispatched) return 'dispatch'
  if (!signals.realized) return 'build'
  return 'complete'
}
