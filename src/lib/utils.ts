import consola from "consola"

import { getModels, type Model } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { modelIdCandidates } from "./model-name"
import { state } from "./state"

const MODELS_REFRESH_INTERVAL_MS = 5 * 60 * 1000
let lastModelsRefresh = 0

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
  lastModelsRefresh = Date.now()
}

function lookupModel(modelId: string): Model | undefined {
  const models = state.models?.data
  if (!models) return undefined

  for (const candidate of modelIdCandidates(modelId)) {
    const model = models.find((entry) => entry.id === candidate)
    if (model) return model
  }
  return undefined
}

/**
 * Looks up a model in the cache, also accepting the spellings clients use for
 * Copilot ids (see modelIdCandidates). Copilot adds and retires models while
 * the server is running, so an unknown id triggers a (throttled) cache refresh.
 */
export async function findModel(modelId: string): Promise<Model | undefined> {
  const cached = lookupModel(modelId)
  if (cached || Date.now() - lastModelsRefresh < MODELS_REFRESH_INTERVAL_MS) {
    return cached
  }

  // Claim the refresh slot up front so concurrent misses don't all refetch
  lastModelsRefresh = Date.now()
  try {
    await cacheModels()
  } catch (error) {
    consola.warn("Failed to refresh models:", error)
  }
  return lookupModel(modelId)
}

/** The model Copilot itself falls back to when nothing else is chosen */
export function findDefaultChatModel(): Model | undefined {
  const models = state.models?.data
  return (
    models?.find((model) => model.is_chat_default)
    ?? models?.find((model) => model.capabilities.type === "chat")
  )
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
