/**
 * Does this map say anything?
 *
 * Axiom used to ask only "are any files unclassified", which is a question about
 * coverage, not meaning. A workspace whose every file sat in an auto-generated
 * pile answered "no problem here" while the canvas read Bar, Lane, Phase and
 * Cochange — labels chosen by symbol frequency, which describe nothing a person
 * would recognise as part of their system.
 *
 * So authorship is the signal, not coverage. A system nobody has confirmed is
 * a guess, however many files it contains, and a map made entirely of guesses
 * is the state worth offering to fix.
 */

export type SystemSource = 'cluster' | 'directory' | 'user' | 'agent' | string

export interface AuthorshipInput {
  systems: ReadonlyArray<{ id: string; source?: SystemSource | null; parentId?: string | null }>
  files: ReadonlyArray<{ id: string; systemId?: string | null }>
}

export interface Authorship {
  /** Systems a human or agent deliberately named. */
  authored: number
  /** Systems produced by clustering or directory fallback. */
  inferred: number
  /** Files sitting outside every system. */
  homeless: number
  topLevel: number
  /** True when the map is entirely, or almost entirely, machine guesswork. */
  unnamed: boolean
}

/**
 * Below this share of authored systems the map is treated as unnamed. It is not
 * zero because one hand-named system among ninety guesses is still a map that
 * cannot be read — the offer should stand until naming is actually underway.
 */
const AUTHORED_SHARE_FOR_A_NAMED_MAP = 0.5

export function readAuthorship({ systems, files }: AuthorshipInput): Authorship {
  let authored = 0
  let inferred = 0
  let topLevel = 0

  for (const system of systems) {
    if (!system.parentId) topLevel += 1
    if (system.source === 'user' || system.source === 'agent') authored += 1
    else inferred += 1
  }

  const homeless = files.filter(file => !file.systemId).length
  const named = systems.length > 0 && authored / systems.length >= AUTHORED_SHARE_FOR_A_NAMED_MAP

  return {
    authored,
    inferred,
    homeless,
    topLevel,
    // An empty map is not an unnamed map — there is nothing indexed yet to
    // name, and offering to organise nothing reads as a broken app.
    unnamed: files.length > 0 && !named,
  }
}

/**
 * The invitation's words. Written from what the user is looking at rather than
 * from the mechanism: they see boxes with meaningless names, so that is the
 * sentence, and the number that makes it concrete is how many of those boxes
 * nobody chose.
 */
export function describeAuthorship(authorship: Authorship): { title: string; detail: string } | null {
  if (!authorship.unnamed && authorship.homeless === 0) return null

  if (authorship.unnamed) {
    return {
      title: 'Your map is named by guesswork',
      detail: authorship.inferred === 1
        ? 'One system was named automatically from the words in your code. An agent can read the project and name it the way you would.'
        : `${authorship.inferred} systems were named automatically from the words in your code. An agent can read the project and name them the way you would.`,
    }
  }

  return {
    title: `${authorship.homeless} ${authorship.homeless === 1 ? 'file has' : 'files have'} no architectural home`,
    detail: 'An agent can read them and place them in the systems they belong to.',
  }
}
