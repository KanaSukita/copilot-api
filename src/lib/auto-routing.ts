import consola from "consola"
import { createHash } from "node:crypto"

import type { Model } from "~/services/copilot/get-models"

import { getAutoRoute, type AutoTier } from "~/services/copilot/get-auto-route"
import {
  getFusionPlan,
  type FusionMode,
  type FusionStep,
} from "~/services/copilot/get-fusion-plan"

import { stripContextSuffix } from "./model-name"
import { findDefaultChatModel, findModel } from "./utils"

export type RoutingTarget =
  | { kind: "auto"; tier: AutoTier }
  | { kind: "fusion"; mode: FusionMode }

export interface VirtualModel {
  id: string
  name: string
  target: RoutingTarget
}

const auto = (tier: AutoTier): RoutingTarget => ({ kind: "auto", tier })
const fusion = (mode: FusionMode): RoutingTarget => ({ kind: "fusion", mode })

// Selectable model names that make the proxy pick the Copilot model itself:
// through Auto routing (POST /auto) or a Fusion plan (POST /model/fusion)
export const VIRTUAL_MODELS: Array<VirtualModel> = [
  { id: "auto", name: "Copilot Auto", target: auto("balance") },
  {
    id: "auto-efficiency",
    name: "Copilot Auto (efficiency)",
    target: auto("efficiency"),
  },
  {
    id: "auto-balance",
    name: "Copilot Auto (balance)",
    target: auto("balance"),
  },
  {
    id: "auto-intelligence",
    name: "Copilot Auto (intelligence)",
    target: auto("intelligence"),
  },
  { id: "auto-fast", name: "Copilot Auto (fast)", target: auto("fast") },
  // Fusion's Standard effort is Auto's balance tier
  { id: "fusion", name: "Copilot Fusion (standard)", target: auto("balance") },
  {
    id: "fusion-high",
    name: "Copilot Fusion (high)",
    target: fusion("hydrafusion"),
  },
  {
    id: "fusion-max",
    name: "Copilot Fusion (max)",
    target: fusion("hydrafusion-max"),
  },
]

// Copilot's own names for the Fusion effort levels
const ALIASES = new Map<string, string>([
  ["fusion-standard", "fusion"],
  ["hydrafusion", "fusion-high"],
  ["hydrafusion-max", "fusion-max"],
])

/** Returns how a model name should be routed, if it is a virtual model */
export function parseVirtualModel(name: string): RoutingTarget | undefined {
  const id = stripContextSuffix(name).toLowerCase()
  const canonical = ALIASES.get(id) ?? id
  return VIRTUAL_MODELS.find((model) => model.id === canonical)?.target
}

export interface RouteInput {
  /** Identifies the conversation, so every turn keeps the same model */
  sessionKey: string
  target: RoutingTarget
  prompt: string
  hasImage: boolean
}

export interface ModelRoute {
  model: Model
  /** Absent once the token expired, or when routing was unavailable */
  sessionToken?: string
  /** The reasoning effort a Fusion plan asks for */
  reasoningEffort?: string
  reason?: string
  /** False when routing failed and a fallback model was used */
  routed: boolean
}

interface RouteEntry {
  model: Model
  sessionToken: string
  expiresAtMs: number
  reasoningEffort?: string
  reason?: string
}

// Re-route shortly before the session token expires, like VS Code does
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 1000
const MAX_ROUTES = 500

const routes = new Map<string, RouteEntry>()
const pending = new Map<string, Promise<RouteEntry>>()
const unavailableUntil = new Map<RoutingTarget["kind"], number>()

const hashPrompt = (prompt: string) =>
  createHash("sha256").update(prompt).digest("hex").slice(0, 16)

// Auto picks one model per conversation. Fusion plans every user turn (Copilot
// clients call /model/fusion per prompt), so its key includes the prompt; the
// tool-use requests of one turn then share the plan, and switching back and
// forth between the main agent and subagents doesn't re-plan.
function routeKey(input: Omit<RouteInput, "hasImage">): string {
  const { target, sessionKey } = input
  return target.kind === "auto" ?
      `auto:${target.tier}:${sessionKey}`
    : `fusion:${target.mode}:${sessionKey}:${hashPrompt(input.prompt)}`
}

function describeTarget(target: RoutingTarget): string {
  return target.kind === "auto" ?
      `Auto (${target.tier})`
    : `Fusion (${target.mode})`
}

function remember(key: string, entry: RouteEntry): void {
  routes.delete(key)
  routes.set(key, entry)
  if (routes.size > MAX_ROUTES) {
    const oldest = routes.keys().next().value
    if (oldest !== undefined) routes.delete(oldest)
  }
}

const supportsImages = (model: Model) =>
  model.capabilities.supports.vision === true

function isFresh(entry: RouteEntry, hasImage: boolean): boolean {
  return (
    entry.expiresAtMs - Date.now() > REFRESH_MARGIN_MS
    && (!hasImage || supportsImages(entry.model))
  )
}

function toRoute(entry: RouteEntry): ModelRoute {
  return {
    model: entry.model,
    sessionToken:
      entry.expiresAtMs > Date.now() ? entry.sessionToken : undefined,
    reasoningEffort: entry.reasoningEffort,
    reason: entry.reason,
    routed: true,
  }
}

async function requestAutoEntry(
  input: RouteInput,
  tier: AutoTier,
): Promise<RouteEntry> {
  const response = await getAutoRoute({
    prompt: input.prompt,
    has_image: input.hasImage,
    tier,
  })
  return {
    model: response.selected_model,
    sessionToken: response.session_token,
    expiresAtMs: response.expires_at * 1000,
    reason: response.selection_reason,
  }
}

/**
 * The proxy runs the whole turn on one model: the plan's root (the solo
 * "generation" step, or the cascade's "draft"). The judge and repair steps of
 * a cascade need client-side orchestration and are not run.
 */
export function orderFusionSteps(steps: Array<FusionStep>): Array<FusionStep> {
  const root =
    steps.find((step) => step.role === "generation" || step.role === "draft")
    ?? steps.at(0)
  return root ? [root, ...steps.filter((step) => step !== root)] : []
}

async function requestFusionEntry(
  input: RouteInput,
  mode: FusionMode,
): Promise<RouteEntry> {
  const plan = await getFusionPlan({
    prompt: input.prompt,
    fusion_mode: mode,
    plan_version: "2",
    has_image: input.hasImage,
  })

  for (const step of orderFusionSteps(plan.steps)) {
    const model = await findModel(step.model_id)
    if (!model || (input.hasImage && !supportsImages(model))) continue

    const steps = plan.steps
      .map(
        (s) =>
          `${s.role}=${s.model_id}${s.reasoning_effort ? `@${s.reasoning_effort}` : ""}`,
      )
      .join(", ")
    return {
      model,
      sessionToken: plan.session.token,
      expiresAtMs: plan.session.expires_at * 1000,
      reasoningEffort: step.reasoning_effort,
      reason: `${plan.fusion_pattern} plan [${steps}]${plan.matched_rule ? ` by ${plan.matched_rule}` : ""}`,
    }
  }

  throw new Error(
    `Fusion plan has no usable model: ${plan.steps.map((step) => step.model_id).join(", ")}`,
  )
}

async function requestRoute(
  key: string,
  input: RouteInput,
): Promise<RouteEntry> {
  const { target } = input
  if (Date.now() < (unavailableUntil.get(target.kind) ?? 0)) {
    throw new Error(
      `${describeTarget(target)} failed recently, not retrying yet`,
    )
  }

  try {
    const entry =
      target.kind === "auto" ?
        await requestAutoEntry(input, target.tier)
      : await requestFusionEntry(input, target.mode)
    remember(key, entry)
    const effort = entry.reasoningEffort ? ` (${entry.reasoningEffort})` : ""
    consola.info(
      `${describeTarget(target)} selected ${entry.model.id}${effort}${entry.reason ? `: ${entry.reason}` : ""}`,
    )
    return entry
  } catch (error) {
    unavailableUntil.set(target.kind, Date.now() + FAILURE_BACKOFF_MS)
    throw error
  }
}

// Concurrent requests of one conversation (Claude Code fires several at once)
// must share a single route, otherwise they could land on different models
function fetchRoute(key: string, input: RouteInput): Promise<RouteEntry> {
  const inFlight = pending.get(key)
  if (inFlight) return inFlight

  const request = requestRoute(key, input).finally(() => {
    pending.delete(key)
  })
  pending.set(key, request)
  return request
}

/**
 * Picks the model for a virtual model request. The first request asks Copilot;
 * later ones reuse the answer so the model (and its prompt cache) stays the
 * same until the session token is about to expire. Fusion falls back to Auto,
 * and Auto to the default chat model.
 */
export async function routeModel(input: RouteInput): Promise<ModelRoute> {
  const key = routeKey(input)
  const cached = routes.get(key)
  if (cached && isFresh(cached, input.hasImage)) {
    remember(key, cached)
    return toRoute(cached)
  }

  try {
    return toRoute(await fetchRoute(key, input))
  } catch (error) {
    consola.warn(`${describeTarget(input.target)} routing failed:`, error)

    if (cached && (!input.hasImage || supportsImages(cached.model))) {
      return toRoute(cached)
    }

    if (input.target.kind === "fusion") {
      consola.warn("Falling back to Auto (balance)")
      return routeModel({ ...input, target: auto("balance") })
    }

    const fallback = findDefaultChatModel()
    if (!fallback) throw error

    consola.warn(`Falling back to ${fallback.id}`)
    return { model: fallback, routed: false }
  }
}

/** The model a request is currently routed to, without calling Copilot */
export function peekRoute(
  input: Omit<RouteInput, "hasImage">,
): Model | undefined {
  return routes.get(routeKey(input))?.model
}

export function clearRoutes(): void {
  routes.clear()
  pending.clear()
  unavailableUntil.clear()
}
