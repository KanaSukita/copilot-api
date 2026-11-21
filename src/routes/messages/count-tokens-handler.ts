import type { Context } from "hono"

import consola from "consola"

import { parseVirtualModel, peekRoute } from "~/lib/auto-routing"
import { getTokenCount } from "~/lib/tokenizer"
import { findDefaultChatModel, findModel } from "~/lib/utils"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import { extractRoutingPrompt, getRoutingSessionKey } from "./model-resolution"
import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload)

    // Virtual models only have a real model once a request has been routed;
    // counting must not spend a routing call, so fall back to a default tokenizer
    const target = parseVirtualModel(anthropicPayload.model)
    const selectedModel =
      target ?
        (peekRoute({
          sessionKey: getRoutingSessionKey(anthropicPayload),
          target,
          prompt: extractRoutingPrompt(anthropicPayload),
        }) ?? findDefaultChatModel())
      : await findModel(anthropicPayload.model)

    if (!selectedModel) {
      consola.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (selectedModel.id.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        } else if (selectedModel.id.startsWith("grok")) {
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (selectedModel.id.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (selectedModel.id.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    consola.info("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    return c.json({
      input_tokens: 1,
    })
  }
}
