import consola from "consola"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotModelsHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotModelsHeaders(state),
  })
  if (response.ok) return (await response.json()) as ModelsResponse

  // Without the newer API version Copilot omits billing tiers and long-context
  // limits, but the model list itself is still usable
  consola.warn(
    `Models request failed (${response.status}), retrying without long-context metadata`,
  )
  const fallback = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })
  if (!fallback.ok) throw new HTTPError("Failed to get models", fallback)

  return (await fallback.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  reasoning_effort?: Array<string>
  vision?: boolean
}

interface ModelCapabilities {
  family: string
  // Absent on some non-chat models (embeddings, completions)
  limits?: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

// Prices are per `batch_size` tokens. Prompts larger than the default tier's
// max_prompt_tokens are billed at the long_context tier.
interface ModelTokenPrices {
  input_price?: number
  output_price?: number
  cache_read_price?: number
  cache_write_price?: number
  max_prompt_tokens?: number
}

interface ModelBilling {
  auto_discount?: number
  restricted_to?: Array<string>
  token_prices?: {
    batch_size?: number
    default?: ModelTokenPrices
    long_context?: ModelTokenPrices
    preferred_tier?: string
  }
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  supported_endpoints?: Array<string>
  billing?: ModelBilling
  is_chat_default?: boolean
  is_chat_fallback?: boolean
  policy?: {
    state: string
    terms: string
  }
}
