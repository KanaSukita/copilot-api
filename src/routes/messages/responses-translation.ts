import type { Model } from "~/services/copilot/get-models"

import {
  type ResponseInputContentPart,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponseOutputItem,
  type ResponsesPayload,
  type ResponsesResponse,
  type ResponsesTool,
  type ResponsesUsage,
} from "~/services/copilot/create-responses"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"

// Reasoning items round-trip through the client as thinking blocks. The
// encrypted reasoning state rides in the signature so it can be replayed on
// the next turn (requests are stateless, store: false).
const REASONING_SIGNATURE_PREFIX = "copilot-responses:"

export function encodeReasoningSignature(encryptedContent: string): string {
  return REASONING_SIGNATURE_PREFIX + encryptedContent
}

function decodeReasoningSignature(
  signature: string | undefined,
): string | undefined {
  return signature?.startsWith(REASONING_SIGNATURE_PREFIX) ?
      signature.slice(REASONING_SIGNATURE_PREFIX.length)
    : undefined
}

export function shouldReturnThinking(
  payload: AnthropicMessagesPayload,
  model: Model,
): boolean {
  const thinkingType = payload.thinking?.type
  return (
    (thinkingType === "enabled" || thinkingType === "adaptive")
    && model.capabilities.supports.reasoning_effort !== undefined
  )
}

// Payload translation

export function translateToResponses(
  payload: AnthropicMessagesPayload,
  model: Model,
): ResponsesPayload {
  const returnThinking = shouldReturnThinking(payload, model)
  const maxOutputTokens = model.capabilities.limits.max_output_tokens

  return {
    model: payload.model,
    instructions: translateSystemPrompt(payload.system),
    input: payload.messages.flatMap((message) => translateMessage(message)),
    max_output_tokens:
      maxOutputTokens ?
        Math.min(payload.max_tokens, maxOutputTokens)
      : payload.max_tokens,
    stream: payload.stream,
    store: false,
    ...(returnThinking && { include: ["reasoning.encrypted_content"] }),
    reasoning: translateReasoning(payload, model, returnThinking),
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    prompt_cache_key: getSessionId(payload.metadata?.user_id),
  }
}

function translateSystemPrompt(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) {
    return undefined
  }
  return typeof system === "string" ? system : joinText(system)
}

function joinText(blocks: Array<AnthropicTextBlock>): string {
  return blocks.map((block) => block.text).join("\n\n")
}

function translateReasoning(
  payload: AnthropicMessagesPayload,
  model: Model,
  returnThinking: boolean,
): ResponsesPayload["reasoning"] {
  const supportedEfforts = model.capabilities.supports.reasoning_effort
  if (!supportedEfforts) {
    return undefined
  }

  // Claude Code disables thinking for quick utility calls (titles, summaries)
  const effort =
    payload.thinking?.type === "disabled" ?
      "none"
    : payload.output_config?.effort

  return {
    ...(effort && supportedEfforts.includes(effort) && { effort }),
    ...(returnThinking && { summary: "auto" }),
  }
}

// Claude Code sends metadata.user_id as JSON carrying the session id, which
// makes a good prompt cache key for the whole conversation.
function getSessionId(userId: string | undefined): string | undefined {
  if (!userId) {
    return undefined
  }
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown } | null
    return typeof parsed?.session_id === "string" ?
        parsed.session_id
      : undefined
  } catch {
    return undefined
  }
}

function translateMessage(message: AnthropicMessage): Array<ResponseInputItem> {
  switch (message.role) {
    case "user": {
      return translateUserMessage(message)
    }
    case "assistant": {
      return translateAssistantMessage(message)
    }
    case "system": {
      const content =
        typeof message.content === "string" ?
          message.content
        : joinText(message.content)
      return [{ role: "developer", content }]
    }
    default: {
      return []
    }
  }
}

function translateUserMessage(
  message: AnthropicUserMessage,
): Array<ResponseInputItem> {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }]
  }

  // Tool results must directly follow the function calls they answer
  const items: Array<ResponseInputItem> = message.content
    .filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    .map((block) => ({
      type: "function_call_output",
      call_id: block.tool_use_id,
      output: translateToolResultContent(block.content),
    }))

  const parts = translateContentParts(message.content)
  if (parts.length > 0) {
    items.push({ role: "user", content: parts })
  }

  return items
}

function translateToolResultContent(
  content: AnthropicToolResultBlock["content"],
): string | Array<ResponseInputContentPart> {
  if (typeof content === "string") {
    return content
  }
  const parts = translateContentParts(content)
  return parts.length > 0 ? parts : ""
}

function translateContentParts(
  blocks: Array<AnthropicUserContentBlock | AnthropicImageBlock>,
): Array<ResponseInputContentPart> {
  return blocks.flatMap((block): Array<ResponseInputContentPart> => {
    switch (block.type) {
      case "text": {
        return [{ type: "input_text", text: block.text }]
      }
      case "image": {
        return [
          {
            type: "input_image",
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        ]
      }
      default: {
        return []
      }
    }
  })
}

function translateAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<ResponseInputItem> {
  if (typeof message.content === "string") {
    return [assistantText(message.content)]
  }

  // Keep the original order: reasoning must precede the items it produced
  return message.content.flatMap((block): Array<ResponseInputItem> => {
    switch (block.type) {
      case "text": {
        return block.text ? [assistantText(block.text)] : []
      }
      case "tool_use": {
        return [
          {
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        ]
      }
      case "thinking": {
        // Thinking produced by other models can't be replayed as reasoning
        const encryptedContent = decodeReasoningSignature(block.signature)
        if (!encryptedContent) {
          return []
        }
        return [
          {
            type: "reasoning",
            summary:
              block.thinking ?
                [{ type: "summary_text", text: block.thinking }]
              : [],
            encrypted_content: encryptedContent,
          },
        ]
      }
      default: {
        return []
      }
    }
  })
}

function assistantText(text: string): ResponseInputMessage {
  return { role: "assistant", content: [{ type: "output_text", text }] }
}

function translateTools(
  tools: Array<AnthropicTool> | undefined,
): Array<ResponsesTool> | undefined {
  if (!tools?.length) {
    return undefined
  }
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }))
}

function translateToolChoice(
  toolChoice: AnthropicMessagesPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  switch (toolChoice?.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return toolChoice.name ?
          { type: "function", name: toolChoice.name }
        : undefined
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateResponsesToAnthropic(
  response: ResponsesResponse,
  returnThinking: boolean,
): AnthropicResponse {
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: response.output.flatMap((item) =>
      translateOutputItem(item, returnThinking),
    ),
    stop_reason: getResponsesStopReason(response),
    stop_sequence: null,
    usage: translateResponsesUsage(response.usage),
  }
}

function translateOutputItem(
  item: ResponseOutputItem,
  returnThinking: boolean,
): Array<AnthropicAssistantContentBlock> {
  switch (item.type) {
    case "reasoning": {
      if (!returnThinking || !item.encrypted_content) {
        return []
      }
      return [
        {
          type: "thinking",
          thinking: item.summary.map((part) => part.text).join("\n\n"),
          signature: encodeReasoningSignature(item.encrypted_content),
        },
      ]
    }
    case "message": {
      return item.content.map((part) => ({
        type: "text",
        text: part.type === "output_text" ? part.text : part.refusal,
      }))
    }
    case "function_call": {
      return [
        {
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments || "{}") as Record<string, unknown>,
        },
      ]
    }
    default: {
      return []
    }
  }
}

export function getResponsesStopReason(
  response: ResponsesResponse,
): AnthropicResponse["stop_reason"] {
  if (response.output.some((item) => item.type === "function_call")) {
    return "tool_use"
  }
  if (
    response.status === "incomplete"
    && response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "max_tokens"
  }
  return "end_turn"
}

export function translateResponsesUsage(
  usage: ResponsesUsage | undefined,
): AnthropicResponse["usage"] {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: (usage?.input_tokens ?? 0) - cachedTokens,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: cachedTokens,
  }
}
