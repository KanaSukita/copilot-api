import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { noteLongContextUsage } from "~/lib/context-limits"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  applyPlannedEffort,
  resolveModel,
  selectReasoningEffort,
} from "./model-resolution"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  handleResponsesCompletion,
  usesResponsesApi,
} from "./responses-handler"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const resolved = await resolveModel(anthropicPayload)
  if (resolved.id !== anthropicPayload.model) {
    consola.debug(`Model ${anthropicPayload.model} resolved to ${resolved.id}`)
    c.header("x-copilot-api-routed-model", resolved.id)
    anthropicPayload.model = resolved.id
  }
  applyPlannedEffort(anthropicPayload, resolved.reasoningEffort)
  // usesResponsesApi narrows resolved.model, so keep unnarrowed copies
  const { model, sessionToken } = resolved

  if (usesResponsesApi(resolved.model)) {
    return handleResponsesCompletion(c, anthropicPayload, {
      model: resolved.model,
      sessionToken,
    })
  }

  const openAIPayload = translateToOpenAI(anthropicPayload)
  const reasoningEffort = selectReasoningEffort(anthropicPayload, model)
  if (reasoningEffort) openAIPayload.reasoning_effort = reasoningEffort
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload, { sessionToken })

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    noteLongContextUsage(model, response.usage?.prompt_tokens)
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      noteLongContextUsage(model, chunk.usage?.prompt_tokens)
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
