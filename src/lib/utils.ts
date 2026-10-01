import consola from "consola"

import { getModels, type Model } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

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

/**
 * Looks up a model in the cache. Copilot adds and retires models while the
 * server is running, so an unknown id triggers a (throttled) cache refresh.
 */
export async function findModel(modelId: string): Promise<Model | undefined> {
  const cached = state.models?.data.find((model) => model.id === modelId)
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
  return state.models?.data.find((model) => model.id === modelId)
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
