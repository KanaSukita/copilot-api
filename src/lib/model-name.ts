// Claude Code may ask for "claude-opus-5-5", "claude-sonnet-4-5-20250929" or
// "claude-opus-5.5[1m]", while Copilot only knows ids like "claude-opus-5.5".
const CONTEXT_SUFFIX = /\[[^\]]*\]$/
const DATE_SUFFIX = /-\d{8}$/
const DASHED_VERSION = /-(\d+)-(\d+)(?=-|$)/

/** Drops the context-size marker Claude Code appends, e.g. "[1m]" */
export const stripContextSuffix = (name: string): string =>
  name.trim().replace(CONTEXT_SUFFIX, "")

/**
 * Lists the Copilot model ids a requested model name may refer to, most
 * specific first. The requested name itself always comes first.
 */
export function modelIdCandidates(name: string): Array<string> {
  const base = stripContextSuffix(name)
  const undated = base.replace(DATE_SUFFIX, "")

  return [
    ...new Set([
      name,
      base,
      undated,
      base.replace(DASHED_VERSION, "-$1.$2"),
      undated.replace(DASHED_VERSION, "-$1.$2"),
    ]),
  ]
}
