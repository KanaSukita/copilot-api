import { Hono } from "hono"

import { VIRTUAL_MODELS } from "~/lib/auto-routing"
import { getContextLimits } from "~/lib/context-limits"
import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => {
      const limits = getContextLimits(model)
      return {
        id: model.id,
        object: "model",
        type: "model",
        created: 0, // No date available from source
        created_at: new Date(0).toISOString(), // No date available from source
        owned_by: model.vendor,
        display_name: model.name,
        // Same names as Anthropic's Models API
        max_input_tokens: limits.maxPromptTokens,
        max_tokens: limits.maxOutputTokens,
        copilot: {
          context_window: limits.contextWindowTokens,
          // Prompts above this size are billed at the long-context tier
          default_max_input_tokens: limits.defaultPromptTokens,
          long_context: limits.longContext,
        },
      }
    })

    // Routed models can be Responses-only, which /chat/completions can't
    // serve, so only Anthropic clients (they always send anthropic-version)
    // get to see them
    const autoModels =
      c.req.header("anthropic-version") ?
        VIRTUAL_MODELS.map((model) => ({
          id: model.id,
          object: "model",
          type: "model",
          created: 0,
          created_at: new Date(0).toISOString(),
          owned_by: "github-copilot",
          display_name: model.name,
        }))
      : []

    return c.json({
      object: "list",
      data: [...(models ?? []), ...autoModels],
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
