import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/** Fusion effort levels; Standard has no plan, it is Auto's balance tier */
export type FusionMode = "hydrafusion" | "hydrafusion-max"

export interface FusionPlanRequest {
  prompt: string
  fusion_mode: FusionMode
  plan_version: "2"
  has_image: boolean
}

export interface FusionStep {
  /** "generation" for solo plans; "draft", "escalation", "repair" for cascades */
  role: string
  model_id: string
  reasoning_effort?: string
}

export interface FusionPlanResponse {
  fusion_mode: FusionMode
  /** "solo", "cascade" or "critique" */
  fusion_pattern: string
  plan_version: string
  policy_version?: string
  matched_rule?: string
  steps: Array<FusionStep>
  session: {
    token: string
    // Unix seconds
    expires_at: number
  }
}

const FUSION_TIMEOUT_MS = 10_000

export const getFusionPlan = async (
  request: FusionPlanRequest,
): Promise<FusionPlanResponse> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/model/fusion`, {
    method: "POST",
    headers: copilotModelsHeaders(state),
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(FUSION_TIMEOUT_MS),
  })

  if (!response.ok) throw new HTTPError("Failed to get fusion plan", response)

  return (await response.json()) as FusionPlanResponse
}
