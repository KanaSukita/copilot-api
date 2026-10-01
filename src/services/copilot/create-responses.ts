import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

// Copilot serves some models (e.g. the GPT-5.5+ family) only through the
// OpenAI Responses API instead of /chat/completions.
export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.input.some(
    (item) =>
      "content" in item
      && Array.isArray(item.content)
      && item.content.some((part) => part.type === "input_image"),
  )

  // Anything after the first user turn is an agent continuation
  const isAgentCall = payload.input.some(
    (item) =>
      item.type === "function_call"
      || item.type === "function_call_output"
      || ("role" in item && item.role === "assistant"),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

// Payload types

export interface ResponsesPayload {
  model: string
  input: Array<ResponseInputItem>
  instructions?: string
  max_output_tokens?: number
  stream?: boolean
  store: false
  include?: Array<"reasoning.encrypted_content">
  reasoning?: {
    effort?: string
    summary?: "auto" | "concise" | "detailed"
  }
  tools?: Array<ResponsesTool>
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
  prompt_cache_key?: string
}

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict: false
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseReasoningItem
  | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "developer"
  content: string | Array<ResponseInputContentPart>
}

export type ResponseInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" }
  | { type: "output_text"; text: string }

export interface ResponseReasoningItem {
  type: "reasoning"
  id?: string
  summary: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string | null
}

export interface ResponseFunctionCallItem {
  type: "function_call"
  id?: string
  call_id: string
  name: string
  arguments: string
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponseInputContentPart>
}

// Response types

export interface ResponsesResponse {
  id: string
  object: "response"
  model: string
  status: "completed" | "incomplete" | "failed" | "in_progress"
  incomplete_details?: { reason?: string } | null
  error?: { code?: string; message: string } | null
  output: Array<ResponseOutputItem>
  usage?: ResponsesUsage
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

export type ResponseOutputItem =
  | ResponseReasoningItem
  | ResponseFunctionCallItem
  | ResponseOutputMessage

export interface ResponseOutputMessage {
  type: "message"
  id: string
  role: "assistant"
  content: Array<
    { type: "output_text"; text: string } | { type: "refusal"; refusal: string }
  >
}

// Streaming event types (only the ones the translator consumes)

export type ResponseStreamEvent =
  | { type: "response.created"; response: ResponsesResponse }
  | { type: "response.in_progress"; response: ResponsesResponse }
  | { type: "response.completed"; response: ResponsesResponse }
  | { type: "response.incomplete"; response: ResponsesResponse }
  | { type: "response.failed"; response: ResponsesResponse }
  | {
      type: "response.output_item.added" | "response.output_item.done"
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.reasoning_summary_part.added"
      output_index: number
      summary_index: number
    }
  | {
      type:
        | "response.reasoning_summary_text.delta"
        | "response.output_text.delta"
        | "response.refusal.delta"
        | "response.function_call_arguments.delta"
      output_index: number
      delta: string
    }
  | { type: "error"; code?: string; message: string }
