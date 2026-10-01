import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesResponse,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  createResponsesStreamState,
  translateResponsesEventToAnthropic,
} from "./responses-stream-translation"
import {
  shouldReturnThinking,
  translateResponsesToAnthropic,
  translateToResponses,
} from "./responses-translation"

export function usesResponsesApi(model: Model | undefined): model is Model {
  const endpoints = model?.supported_endpoints
  return Boolean(
    endpoints?.includes("/responses")
      && !endpoints.includes("/chat/completions"),
  )
}

export async function handleResponsesCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  model: Model,
) {
  const responsesPayload = translateToResponses(anthropicPayload, model)
  consola.debug(
    "Translated Responses request payload:",
    JSON.stringify(responsesPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(responsesPayload)
  const returnThinking = shouldReturnThinking(anthropicPayload, model)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot Responses:",
      JSON.stringify(response).slice(-400),
    )
    return c.json(translateResponsesToAnthropic(response, returnThinking))
  }

  consola.debug("Streaming response from Copilot Responses")
  return streamSSE(c, async (stream) => {
    const streamState = createResponsesStreamState(returnThinking)

    for await (const rawEvent of response) {
      consola.debug("Copilot Responses raw stream event:", rawEvent.data)
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }

      const event = JSON.parse(rawEvent.data) as ResponseStreamEvent
      const events = translateResponsesEventToAnthropic(event, streamState)

      for (const anthropicEvent of events) {
        await stream.writeSSE({
          event: anthropicEvent.type,
          data: JSON.stringify(anthropicEvent),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesResponse => Object.hasOwn(response, "output")
