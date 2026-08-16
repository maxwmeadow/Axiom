// Sheet names are identity, not decoration. The rail, the dispatch history, and
// every agent reading a work order refer to a sheet by name - two sheets called
// "First Increment" make all three ambiguous. archd enforces uniqueness; these
// helpers let the UI agree with it before the round trip, so the user is offered
// a free name instead of a rejection.

export interface NamedSheet {
  id: string
  name: string
}

/** The comparison archd uses: case-insensitive, surrounding space ignored. */
export function normalizeSheetName(name: string): string {
  return name.trim().toLowerCase()
}

/** The sheet already carrying this name, if any. */
export function findSheetByName<T extends NamedSheet>(
  sheets: readonly T[],
  name: string,
): T | undefined {
  const target = normalizeSheetName(name)
  return sheets.find(sheet => normalizeSheetName(sheet.name) === target)
}

/**
 * `base` if it is free, otherwise "base 2", "base 3", … - the first name that
 * nothing else holds. Suggesting a name beats refusing one the user hasn't
 * typed yet.
 */
export function untakenSheetName(sheets: readonly NamedSheet[], base: string): string {
  const taken = new Set(sheets.map(sheet => normalizeSheetName(sheet.name)))
  const trimmed = base.trim()
  if (!taken.has(normalizeSheetName(trimmed))) return trimmed
  for (let suffix = 2; ; suffix++) {
    const candidate = `${trimmed} ${suffix}`
    if (!taken.has(normalizeSheetName(candidate))) return candidate
  }
}
