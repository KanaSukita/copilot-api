import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type { Model } from "./get-models"

export type AutoTier = "efficiency" | "balance" | "intelligence" | "fast"

export interface AutoRouteRequest {
  prompt: string
  has_image: boolean
  tier: AutoTier
}

export interface AutoRouteResponse {
  // Unix seconds
  expires_at: number
  selected_model: Model
  selection_reason?: string
  session_token: string
}

const AUTO_TIMEOUT_MS = 5000

export const getAutoRoute = async (
  request: AutoRouteRequest,
): Promise<AutoRouteResponse> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/auto`, {
    method: "POST",
    headers: copilotModelsHeaders(state),
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(AUTO_TIMEOUT_MS),
  })

  if (!response.ok) throw new HTTPError("Failed to get auto route", response)

  return (await response.json()) as AutoRouteResponse
}
