import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export interface AnthropicErrorBody {
  type: "error"
  error: { type: string; message: string }
}

// Copilot reports "prompt token count of 40025 exceeds the limit of 12288",
// OpenAI-style backends "maximum context length is N tokens ... resulted in M"
const COPILOT_OVERFLOW =
  /prompt token count of (\d+) exceeds the limit of (\d+)/i
const OPENAI_OVERFLOW =
  /maximum context length is (\d+) tokens.*?resulted in (\d+) tokens/is
const OVERFLOW_CODES = new Set([
  "model_max_prompt_tokens_exceeded",
  "context_length_exceeded",
])

function parseUpstreamError(text: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; code?: unknown }
    } | null
    if (typeof parsed?.error?.message === "string") {
      return {
        message: parsed.error.message,
        code:
          typeof parsed.error.code === "string" ? parsed.error.code : undefined,
      }
    }
  } catch {
    // Plain-text error, e.g. from the gateway
  }
  return { message: text }
}

function parseOverflowCounts(
  message: string,
): { tokens: string; limit: string } | undefined {
  const copilot = COPILOT_OVERFLOW.exec(message)
  if (copilot) return { tokens: copilot[1], limit: copilot[2] }

  const openai = OPENAI_OVERFLOW.exec(message)
  if (openai) return { tokens: openai[2], limit: openai[1] }

  return undefined
}

const anthropicError = (type: string, message: string): AnthropicErrorBody => ({
  type: "error",
  error: { type, message },
})

/**
 * Claude Code compacts the conversation and retries when it sees Anthropic's
 * "prompt is too long: N tokens > M maximum" (400) or request_too_large (413)
 * errors, so translate Copilot's equivalents into that shape.
 */
export function toAnthropicContextError(
  status: number,
  errorText: string,
): AnthropicErrorBody | undefined {
  if (status === 413) {
    return anthropicError(
      "request_too_large",
      "Request exceeds the maximum allowed number of bytes.",
    )
  }
  if (status !== 400) return undefined

  const { message, code } = parseUpstreamError(errorText)
  const counts = parseOverflowCounts(message)
  if (counts) {
    return anthropicError(
      "invalid_request_error",
      `prompt is too long: ${counts.tokens} tokens > ${counts.limit} maximum`,
    )
  }
  if (message.toLowerCase().startsWith("prompt is too long")) {
    return anthropicError("invalid_request_error", message)
  }
  if (code && OVERFLOW_CODES.has(code)) {
    return anthropicError(
      "invalid_request_error",
      `prompt is too long: ${message}`,
    )
  }
  return undefined
}

export async function forwardError(
  c: Context,
  error: unknown,
  style: "default" | "anthropic" = "default",
) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)

    const status = error.response.status as ContentfulStatusCode
    const contextError =
      style === "anthropic" ?
        toAnthropicContextError(status, errorText)
      : undefined
    if (contextError) {
      return c.json(contextError, status)
    }

    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      status,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
