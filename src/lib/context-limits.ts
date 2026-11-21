import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

export interface ContextLimits {
  /** Prompts above this size are billed at the long-context tier */
  defaultPromptTokens?: number
  /** Prompts above this size are rejected */
  maxPromptTokens?: number
  contextWindowTokens?: number
  maxOutputTokens?: number
  longContext: boolean
}

export function getContextLimits(model: Model): ContextLimits {
  const limits = model.capabilities.limits ?? {}
  const prices = model.billing?.token_prices
  const maxPromptTokens =
    limits.max_prompt_tokens ?? prices?.long_context?.max_prompt_tokens

  return {
    defaultPromptTokens: prices?.default?.max_prompt_tokens ?? maxPromptTokens,
    maxPromptTokens,
    contextWindowTokens: limits.max_context_window_tokens,
    maxOutputTokens: limits.max_output_tokens,
    longContext: Boolean(prices?.long_context),
  }
}

/**
 * Copilot picks the long-context tier from the prompt size alone, so the only
 * way to notice it is to compare the reported usage with the default limit.
 */
export function describeLongContextUsage(
  model: Model | undefined,
  promptTokens: number | undefined,
): string | undefined {
  if (!model || !promptTokens) return undefined

  const { defaultPromptTokens, longContext } = getContextLimits(model)
  if (
    !longContext
    || defaultPromptTokens === undefined
    || promptTokens <= defaultPromptTokens
  ) {
    return undefined
  }

  const prices = model.billing?.token_prices
  const defaultInput = prices?.default?.input_price
  const longInput = prices?.long_context?.input_price
  const ratio =
    defaultInput && longInput ?
      `, input ${Number((longInput / defaultInput).toFixed(2))}x`
    : ""

  return `Long-context tier for ${model.id}: ${formatTokens(promptTokens)} prompt tokens > ${formatTokens(defaultPromptTokens)} default limit${ratio}`
}

export function noteLongContextUsage(
  model: Model | undefined,
  promptTokens: number | undefined,
): void {
  const message = describeLongContextUsage(model, promptTokens)
  if (message) consola.info(message)
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US")
}

/** E.g. " (prompt up to 1,000,000; long-context above 200,000)" */
export function describeContextLimits(model: Model): string {
  const { defaultPromptTokens, longContext, maxPromptTokens } =
    getContextLimits(model)
  if (maxPromptTokens === undefined) return ""

  const tier =
    (
      longContext
      && defaultPromptTokens !== undefined
      && defaultPromptTokens < maxPromptTokens
    ) ?
      `; long-context above ${formatTokens(defaultPromptTokens)}`
    : ""
  return ` (prompt up to ${formatTokens(maxPromptTokens)}${tier})`
}

// Claude Code assumes a 200k context window unless the model name ends in
// "[1m]" (the proxy strips the suffix again)
const ONE_MILLION_SUFFIX = "[1m]"
const MIN_ONE_MILLION_PROMPT_TOKENS = 800_000

/**
 * True when a model accepts close to 1M prompt tokens and prompts past the
 * default tier cost no more per token, so a 1M window in Claude Code only
 * saves compactions.
 */
export function hasFreeLongContext(model: Model): boolean {
  const { maxPromptTokens } = getContextLimits(model)
  if (!maxPromptTokens || maxPromptTokens < MIN_ONE_MILLION_PROMPT_TOKENS) {
    return false
  }

  const prices = model.billing?.token_prices
  const long = prices?.long_context
  if (!long) return true
  return (
    long.input_price === prices.default?.input_price
    && long.output_price === prices.default?.output_price
  )
}

/** The model name to give Claude Code, asking for 1M context when it's free */
export function claudeCodeModelName(id: string, model: Model | undefined) {
  return model && hasFreeLongContext(model) ? `${id}${ONE_MILLION_SUFFIX}` : id
}
