export interface SceneMeasurementStability {
  signature: string | null
  stableFrames: number
}

/**
 * Advances the initial-camera readiness state from one measured animation
 * frame. Readiness is geometric: missing measurements reset the state and a
 * changed scene must settle again. It deliberately contains no elapsed-time
 * threshold, so unrelated main-thread work can delay a fit but cannot choose
 * which version of the scene gets fitted.
 */
export function advanceSceneMeasurement(
  previous: SceneMeasurementStability,
  signature: string | null,
): SceneMeasurementStability {
  if (signature === null) return { signature: null, stableFrames: 0 }
  if (signature !== previous.signature) return { signature, stableFrames: 1 }
  return { signature, stableFrames: previous.stableFrames + 1 }
}

export function sceneMeasurementIsSettled(
  measurement: SceneMeasurementStability,
  requiredStableFrames = 2,
): boolean {
  return measurement.signature !== null && measurement.stableFrames >= requiredStableFrames
}
