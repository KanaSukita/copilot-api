import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import {
  clearRoutes,
  parseVirtualModel,
  routeModel,
  type RoutingTarget,
} from "../src/lib/auto-routing"
import { hasFreeLongContext } from "../src/lib/context-limits"
import { state } from "../src/lib/state"

const makeModel = (
  id: string,
  overrides: Partial<Model["capabilities"]["supports"]> = {},
): Model =>
  ({
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: id,
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: {},
      supports: { reasoning_effort: ["low", "high"], ...overrides },
    },
  }) as Model

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = {
  object: "list",
  data: [
    makeModel("draft-model"),
    makeModel("judge-model", { vision: true }),
    makeModel("auto-model"),
  ],
}

const expiresAt = () => Math.floor(Date.now() / 1000) + 3600
let fusionFails = false

const fetchMock = mock((url: string) => {
  if (url.endsWith("/model/fusion")) {
    if (fusionFails)
      return Promise.resolve(new Response("boom", { status: 500 }))
    return Promise.resolve(
      Response.json({
        fusion_mode: "hydrafusion",
        fusion_pattern: "cascade",
        plan_version: "2",
        steps: [
          { role: "draft", model_id: "draft-model", reasoning_effort: "high" },
          { role: "escalation", model_id: "judge-model" },
        ],
        session: { token: "fusion-token", expires_at: expiresAt() },
      }),
    )
  }
  return Promise.resolve(
    Response.json({
      selected_model: makeModel("auto-model"),
      session_token: "auto-token",
      expires_at: expiresAt(),
    }),
  )
})

const originalFetch = globalThis.fetch
beforeEach(() => {
  clearRoutes()
  fusionFails = false
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

const high: RoutingTarget = { kind: "fusion", mode: "hydrafusion" }
const route = (prompt: string, hasImage = false) =>
  routeModel({ sessionKey: "session", target: high, prompt, hasImage })
const fusionCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url.endsWith("/model/fusion")).length

test("parses Fusion effort levels and Copilot's aliases", () => {
  expect(parseVirtualModel("fusion")).toEqual({ kind: "auto", tier: "balance" })
  expect(parseVirtualModel("hydrafusion")).toEqual(high)
  expect(parseVirtualModel("Fusion-Max[1m]")).toEqual({
    kind: "fusion",
    mode: "hydrafusion-max",
  })
  expect(parseVirtualModel("claude-opus-5.5")).toBeUndefined()
})

test("runs a turn on the plan's draft model and reuses the plan per prompt", async () => {
  const first = await route("fix the bug")
  expect(first.model.id).toBe("draft-model")
  expect(first.reasoningEffort).toBe("high")
  expect(first.sessionToken).toBe("fusion-token")

  await route("fix the bug")
  expect(fusionCalls()).toBe(1)

  await route("now add tests")
  expect(fusionCalls()).toBe(2)
})

test("skips plan steps that can't see images", async () => {
  const result = await route("what is in this screenshot?", true)
  expect(result.model.id).toBe("judge-model")
  expect(result.reasoningEffort).toBeUndefined()
})

test("falls back to Auto when planning fails", async () => {
  fusionFails = true
  const result = await route("fix the bug")
  expect(result.model.id).toBe("auto-model")
  expect(result.sessionToken).toBe("auto-token")
})

const withLongContextPrice = (longInput: number): Model => ({
  ...makeModel("m"),
  capabilities: {
    ...makeModel("m").capabilities,
    limits: { max_prompt_tokens: 936_000 },
  },
  billing: {
    token_prices: {
      default: { input_price: 200, output_price: 1000 },
      long_context: { input_price: longInput, output_price: 1000 },
    },
  },
})

test("1M context is free only when long-context prices match", () => {
  expect(hasFreeLongContext(withLongContextPrice(200))).toBe(true)
  expect(hasFreeLongContext(withLongContextPrice(400))).toBe(false)
})
