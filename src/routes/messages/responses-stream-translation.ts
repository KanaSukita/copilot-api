import {
  type ResponseOutputItem,
  type ResponsesResponse,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicContentBlockStartEvent,
  type AnthropicStreamEventData,
} from "./anthropic-types"
import {
  encodeReasoningSignature,
  getResponsesStopReason,
  translateResponsesUsage,
} from "./responses-translation"

// Copilot rewrites item ids on every event, so blocks are tracked by output_index
interface BlockTarget {
  outputIndex: number
  type: "thinking" | "text" | "tool_use"
}

interface OpenBlock extends BlockTarget {
  index: number
  hasDelta: boolean
}

export interface ResponsesStreamState {
  returnThinking: boolean
  nextBlockIndex: number
  openBlock?: OpenBlock
}

interface TranslationContext {
  state: ResponsesStreamState
  events: Array<AnthropicStreamEventData>
}

export function createResponsesStreamState(
  returnThinking: boolean,
): ResponsesStreamState {
  return { returnThinking, nextBlockIndex: 0 }
}

export function translateResponsesEventToAnthropic(
  event: ResponseStreamEvent,
  state: ResponsesStreamState,
): Array<AnthropicStreamEventData> {
  const ctx: TranslationContext = { state, events: [] }

  switch (event.type) {
    case "response.created": {
      ctx.events.push(messageStart(event.response))
      break
    }
    case "response.output_item.added": {
      handleItemAdded(ctx, event.output_index, event.item)
      break
    }
    case "response.reasoning_summary_part.added": {
      // Separate consecutive summary parts like paragraphs
      if (event.summary_index > 0) {
        pushDelta(
          ctx,
          { outputIndex: event.output_index, type: "thinking" },
          "\n\n",
        )
      }
      break
    }
    case "response.reasoning_summary_text.delta": {
      pushDelta(
        ctx,
        { outputIndex: event.output_index, type: "thinking" },
        event.delta,
      )
      break
    }
    case "response.output_text.delta":
    case "response.refusal.delta": {
      pushTextDelta(ctx, event.output_index, event.delta)
      break
    }
    case "response.function_call_arguments.delta": {
      pushDelta(
        ctx,
        { outputIndex: event.output_index, type: "tool_use" },
        event.delta,
      )
      break
    }
    case "response.output_item.done": {
      handleItemDone(ctx, event.output_index, event.item)
      break
    }
    case "response.completed":
    case "response.incomplete": {
      finishMessage(ctx, event.response)
      break
    }
    case "response.failed": {
      ctx.events.push(
        errorEvent(event.response.error?.message ?? "Response failed"),
      )
      break
    }
    case "error": {
      ctx.events.push(errorEvent(event.message))
      break
    }
    default: {
      break
    }
  }

  return ctx.events
}

function messageStart(response: ResponsesResponse): AnthropicStreamEventData {
  return {
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

function finishMessage(
  ctx: TranslationContext,
  response: ResponsesResponse,
): void {
  closeBlock(ctx)
  ctx.events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: getResponsesStopReason(response),
        stop_sequence: null,
      },
      usage: translateResponsesUsage(response.usage),
    },
    { type: "message_stop" },
  )
}

function handleItemAdded(
  ctx: TranslationContext,
  outputIndex: number,
  item: ResponseOutputItem,
): void {
  if (item.type === "reasoning" && ctx.state.returnThinking) {
    openBlock(ctx, outputIndex, {
      type: "thinking",
      thinking: "",
      signature: "",
    })
  } else if (item.type === "function_call") {
    openBlock(ctx, outputIndex, {
      type: "tool_use",
      id: item.call_id,
      name: item.name,
      input: {},
    })
  }
  // Message text blocks are opened lazily on their first delta
}

function handleItemDone(
  ctx: TranslationContext,
  outputIndex: number,
  item: ResponseOutputItem,
): void {
  const block = ctx.state.openBlock
  if (block?.outputIndex !== outputIndex) {
    return
  }

  if (item.type === "reasoning" && item.encrypted_content) {
    ctx.events.push({
      type: "content_block_delta",
      index: block.index,
      delta: {
        type: "signature_delta",
        signature: encodeReasoningSignature(item.encrypted_content),
      },
    })
  } else if (item.type === "function_call" && !block.hasDelta) {
    // Arguments may arrive only on the done event
    pushDelta(ctx, block, item.arguments)
  }

  closeBlock(ctx)
}

function isOpen(ctx: TranslationContext, target: BlockTarget): boolean {
  const block = ctx.state.openBlock
  return block?.outputIndex === target.outputIndex && block.type === target.type
}

function openBlock(
  ctx: TranslationContext,
  outputIndex: number,
  contentBlock: AnthropicContentBlockStartEvent["content_block"],
): void {
  closeBlock(ctx)
  const index = ctx.state.nextBlockIndex++
  ctx.state.openBlock = {
    outputIndex,
    index,
    type: contentBlock.type,
    hasDelta: false,
  }
  ctx.events.push({
    type: "content_block_start",
    index,
    content_block: contentBlock,
  })
}

function closeBlock(ctx: TranslationContext): void {
  if (!ctx.state.openBlock) {
    return
  }
  ctx.events.push({
    type: "content_block_stop",
    index: ctx.state.openBlock.index,
  })
  ctx.state.openBlock = undefined
}

function pushTextDelta(
  ctx: TranslationContext,
  outputIndex: number,
  text: string,
): void {
  const target: BlockTarget = { outputIndex, type: "text" }
  if (!isOpen(ctx, target)) {
    openBlock(ctx, outputIndex, { type: "text", text: "" })
  }
  pushDelta(ctx, target, text)
}

function pushDelta(
  ctx: TranslationContext,
  target: BlockTarget,
  text: string,
): void {
  const block = ctx.state.openBlock
  if (!text || !block || !isOpen(ctx, target)) {
    return
  }
  block.hasDelta = true

  switch (target.type) {
    case "thinking": {
      ctx.events.push({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "thinking_delta", thinking: text },
      })
      break
    }
    case "text": {
      ctx.events.push({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "text_delta", text },
      })
      break
    }
    case "tool_use": {
      ctx.events.push({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: text },
      })
      break
    }
    // No default
  }
}

function errorEvent(message: string): AnthropicStreamEventData {
  return { type: "error", error: { type: "api_error", message } }
}
