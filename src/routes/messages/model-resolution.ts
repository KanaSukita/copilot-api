import { createHash } from "node:crypto"

import type { Model } from "~/services/copilot/get-models"

import { parseVirtualModel, routeModel } from "~/lib/auto-routing"
import { findModel } from "~/lib/utils"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
} from "./anthropic-types"

import { getSessionId } from "./responses-translation"

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
// The router only needs the gist of the task, and /auto has a short timeout
const MAX_PROMPT_CHARS = 8000

function textOf(content: AnthropicMessage["content"]): string {
  const text =
    typeof content === "string" ? content : (
      content
        .filter((block): block is AnthropicTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    )
  return text.replaceAll(SYSTEM_REMINDER, "").trim()
}

/**
 * The text the user last asked for, without tool results and the
 * system-reminder blocks Claude Code injects into user turns.
 */
export function extractRoutingPrompt(payload: AnthropicMessagesPayload) {
  for (const message of payload.messages.toReversed()) {
    if (message.role !== "user") continue
    const text = textOf(message.content)
    if (text) return text.slice(0, MAX_PROMPT_CHARS)
  }
  return "Continue the conversation."
}

export function hasImages(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "user"
      && typeof message.content !== "string"
      && message.content.some(
        (block) =>
          block.type === "image"
          || (block.type === "tool_result"
            && typeof block.content !== "string"
            && block.content.some((part) => part.type === "image")),
      ),
  )
}

/**
 * Identifies a conversation: Claude Code's session id, or for other clients a
 * hash of what stays constant across turns (system prompt, first user turn).
 */
export function getRoutingSessionKey(payload: AnthropicMessagesPayload) {
  const sessionId = getSessionId(payload.metadata?.user_id)
  if (sessionId) return sessionId

  const firstUser = payload.messages.find((message) => message.role === "user")
  return createHash("sha256")
    .update(JSON.stringify(payload.system ?? ""))
    .update(JSON.stringify(firstUser?.content ?? ""))
    .digest("hex")
}

export interface ResolvedModel {
  /** The id to send upstream */
  id: string
  /** Undefined when Copilot doesn't list the requested model */
  model: Model | undefined
  sessionToken?: string
  /** The reasoning effort a Fusion plan picked for this turn */
  reasoningEffort?: string
}

/**
 * Maps the model name a client asked for to a Copilot model: tolerates the
 * spellings clients use for Copilot ids, and picks the model through Auto
 * or Fusion routing for virtual models such as "auto" or "fusion-high".
 */
export async function resolveModel(
  payload: AnthropicMessagesPayload,
): Promise<ResolvedModel> {
  const target = parseVirtualModel(payload.model)
  if (!target) {
    const model = await findModel(payload.model)
    return { id: model?.id ?? payload.model, model }
  }

  const route = await routeModel({
    sessionKey: getRoutingSessionKey(payload),
    target,
    prompt: extractRoutingPrompt(payload),
    hasImage: hasImages(payload),
  })
  const model = (await findModel(route.model.id)) ?? route.model
  return {
    id: model.id,
    model,
    sessionToken: route.sessionToken,
    reasoningEffort: route.reasoningEffort,
  }
}

/**
 * A Fusion plan's reasoning effort wins over the client's, except for utility
 * calls with thinking disabled, which stay cheap.
 */
export function applyPlannedEffort(
  payload: AnthropicMessagesPayload,
  effort: string | undefined,
): void {
  if (!effort || payload.thinking?.type === "disabled") return
  payload.output_config = { ...payload.output_config, effort }
}

/**
 * The reasoning effort for /chat/completions. Unsupported values are dropped,
 * as Copilot rejects them.
 */
export function selectReasoningEffort(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
): string | undefined {
  if (payload.thinking?.type === "disabled") return undefined
  const effort = payload.output_config?.effort
  const supported = model?.capabilities.supports.reasoning_effort
  return effort && supported?.includes(effort) ? effort : undefined
}
