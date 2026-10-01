import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ResponseFunctionCallItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponsesResponse,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import { usesResponsesApi } from "~/routes/messages/responses-handler"
import {
  createResponsesStreamState,
  translateResponsesEventToAnthropic,
} from "~/routes/messages/responses-stream-translation"
import {
  translateResponsesToAnthropic,
  translateToResponses,
} from "~/routes/messages/responses-translation"

const model: Model = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  object: "model",
  vendor: "OpenAI",
  version: "gpt-6-luna",
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: ["/responses", "ws:/responses"],
  capabilities: {
    family: "gpt-6-luna",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    type: "chat",
    limits: { max_output_tokens: 128000 },
    supports: {
      tool_calls: true,
      reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
    },
  },
}

const basePayload: AnthropicMessagesPayload = {
  model: "gpt-6-luna",
  max_tokens: 32000,
  messages: [{ role: "user", content: "hi" }],
}

describe("usesResponsesApi", () => {
  test("only routes models that lack /chat/completions", () => {
    expect(usesResponsesApi(model)).toBe(true)
    expect(
      usesResponsesApi({
        ...model,
        supported_endpoints: ["/responses", "/chat/completions"],
      }),
    ).toBe(false)
    expect(usesResponsesApi({ ...model, supported_endpoints: undefined })).toBe(
      false,
    )
    expect(usesResponsesApi(undefined)).toBe(false)
  })
})

describe("Anthropic to Responses request translation", () => {
  test("translates system, tools and a tool-use conversation in order", () => {
    const result = translateToResponses(
      {
        ...basePayload,
        system: [
          { type: "text", text: "You are Claude Code." },
          { type: "text", text: "Be terse." },
        ],
        metadata: { user_id: JSON.stringify({ session_id: "session-123" }) },
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: "read package.json" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "Need to read it",
                signature: "copilot-responses:enc-1",
              },
              { type: "thinking", thinking: "from claude", signature: "sig" },
              { type: "text", text: "Reading." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Read",
                input: { path: "package.json" },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "anything else?" },
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "{}" }],
              },
            ],
          },
          { role: "system", content: "<system-reminder>x</system-reminder>" },
        ],
      },
      model,
    )

    expect(result.instructions).toBe("You are Claude Code.\n\nBe terse.")
    expect(result.store).toBe(false)
    expect(result.prompt_cache_key).toBe("session-123")
    expect(result.tool_choice).toBe("auto")
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
    expect(result.input).toEqual([
      { role: "user", content: "read package.json" },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need to read it" }],
        encrypted_content: "enc-1",
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Reading." }],
      },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "Read",
        arguments: '{"path":"package.json"}',
      },
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: [{ type: "input_text", text: "{}" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "anything else?" }],
      },
      { role: "developer", content: "<system-reminder>x</system-reminder>" },
    ])
  })

  test("maps thinking and effort settings to reasoning", () => {
    const adaptive = translateToResponses(
      {
        ...basePayload,
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      },
      model,
    )
    expect(adaptive.reasoning).toEqual({ effort: "xhigh", summary: "auto" })
    expect(adaptive.include).toEqual(["reasoning.encrypted_content"])

    const disabled = translateToResponses(
      { ...basePayload, thinking: { type: "disabled" } },
      model,
    )
    expect(disabled.reasoning).toEqual({ effort: "none" })
    expect(disabled.include).toBeUndefined()

    const unsupported = translateToResponses(
      { ...basePayload, output_config: { effort: "ultra" } },
      model,
    )
    expect(unsupported.reasoning).toEqual({})
  })

  test("clamps max_output_tokens to the model limit", () => {
    const result = translateToResponses(
      { ...basePayload, max_tokens: 200000 },
      model,
    )
    expect(result.max_output_tokens).toBe(128000)
  })
})

const reasoningItem: ResponseReasoningItem = {
  type: "reasoning",
  summary: [
    { type: "summary_text", text: "Part one" },
    { type: "summary_text", text: "Part two" },
  ],
  encrypted_content: "enc-2",
}

const messageItem: ResponseOutputMessage = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  content: [{ type: "output_text", text: "Checking." }],
}

const functionItem: ResponseFunctionCallItem = {
  type: "function_call",
  call_id: "call_1",
  name: "Read",
  arguments: '{"path":"a.ts"}',
}

const completedResponse: ResponsesResponse = {
  id: "resp_1",
  object: "response",
  model: "gpt-6-luna",
  status: "completed",
  output: [reasoningItem, messageItem, functionItem],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 60 },
  },
}

describe("Responses to Anthropic response translation", () => {
  test("translates reasoning, text and function calls", () => {
    const result = translateResponsesToAnthropic(completedResponse, true)

    expect(result.content).toEqual([
      {
        type: "thinking",
        thinking: "Part one\n\nPart two",
        signature: "copilot-responses:enc-2",
      },
      { type: "text", text: "Checking." },
      {
        type: "tool_use",
        id: "call_1",
        name: "Read",
        input: { path: "a.ts" },
      },
    ])
    expect(result.stop_reason).toBe("tool_use")
    expect(result.usage).toEqual({
      input_tokens: 40,
      output_tokens: 20,
      cache_read_input_tokens: 60,
    })
  })

  test("drops reasoning when thinking was not requested", () => {
    const result = translateResponsesToAnthropic(completedResponse, false)
    expect(result.content.map((block) => block.type)).toEqual([
      "text",
      "tool_use",
    ])
  })

  test("maps truncated responses to max_tokens", () => {
    const result = translateResponsesToAnthropic(
      {
        ...completedResponse,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [messageItem],
      },
      true,
    )
    expect(result.stop_reason).toBe("max_tokens")
  })
})

describe("Responses to Anthropic stream translation", () => {
  test("produces well-formed, sequential content blocks", () => {
    const streamEvents: Array<ResponseStreamEvent> = [
      {
        type: "response.created",
        response: { ...completedResponse, output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...reasoningItem, summary: [] },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "Part one",
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 1,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "Part two",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoningItem,
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...messageItem, content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        delta: "Checking.",
      },
      { type: "response.output_item.done", output_index: 1, item: messageItem },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { ...functionItem, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '"a.ts"}',
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: functionItem,
      },
      { type: "response.completed", response: completedResponse },
    ]

    const state = createResponsesStreamState(true)
    const events = streamEvents.flatMap((event) =>
      translateResponsesEventToAnthropic(event, state),
    )

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    const deltas = events.flatMap((event) =>
      event.type === "content_block_delta" ? [[event.index, event.delta]] : [],
    )
    expect(deltas).toEqual([
      [0, { type: "thinking_delta", thinking: "Part one" }],
      [0, { type: "thinking_delta", thinking: "\n\n" }],
      [0, { type: "thinking_delta", thinking: "Part two" }],
      [0, { type: "signature_delta", signature: "copilot-responses:enc-2" }],
      [1, { type: "text_delta", text: "Checking." }],
      [2, { type: "input_json_delta", partial_json: '{"path":' }],
      [2, { type: "input_json_delta", partial_json: '"a.ts"}' }],
    ])

    const messageDelta = events.find((event) => event.type === "message_delta")
    expect(messageDelta).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 40, output_tokens: 20 },
    })
  })

  test("skips reasoning blocks when thinking was not requested", () => {
    const state = createResponsesStreamState(false)
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: reasoningItem,
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "hidden",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoningItem,
      },
    ] satisfies Array<ResponseStreamEvent>

    expect(
      events.flatMap((event) =>
        translateResponsesEventToAnthropic(event, state),
      ),
    ).toEqual([])
  })
})
