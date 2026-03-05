import { createLogger } from '@sim/logger'
import { SIM_AGENT_API_URL } from '@/lib/copilot/constants'
import { prepareExecutionContext } from '@/lib/copilot/orchestrator/tool-executor'
import type { OrchestratorOptions, OrchestratorResult } from '@/lib/copilot/orchestrator/types'
import { env } from '@/lib/core/config/env'
import { buildToolCallSummaries, createStreamingContext, runStreamLoop } from './stream-core'

const logger = createLogger('CopilotOrchestrator')

export const LOCAL_CLI_PROVIDERS = new Set(['claude', 'anthropic', 'gemini', 'google', 'codex', 'openai'])

/** Resolves the streaming endpoint URL.
 * If the request targets a local CLI provider, routes to the internal Next.js API.
 * Otherwise falls back to the configured SIM_AGENT_API_URL. */
function resolveStreamingUrl(requestPayload: Record<string, unknown>): string {
  const provider = typeof requestPayload.provider === 'string' ? requestPayload.provider : ''
  const isLocalProvider = LOCAL_CLI_PROVIDERS.has(provider)

  if (isLocalProvider) {
    const base =
      env.INTERNAL_API_BASE_URL ||
      (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_APP_URL) ||
      'http://localhost:3000'
    return `${base}/api/chat-completion-streaming`
  }

  return `${SIM_AGENT_API_URL}/api/chat-completion-streaming`
}

export interface OrchestrateStreamOptions extends OrchestratorOptions {
  userId: string
  workflowId: string
  chatId?: string
}

export async function orchestrateCopilotStream(
  requestPayload: Record<string, unknown>,
  options: OrchestrateStreamOptions
): Promise<OrchestratorResult> {
  const { userId, workflowId, chatId } = options
  const execContext = await prepareExecutionContext(userId, workflowId)

  const payloadMsgId = requestPayload?.messageId
  const context = createStreamingContext({
    chatId,
    messageId: typeof payloadMsgId === 'string' ? payloadMsgId : crypto.randomUUID(),
  })

  const streamingUrl = resolveStreamingUrl(requestPayload)
  logger.info('Resolved streaming URL', { url: streamingUrl, provider: requestPayload.provider })

  try {
    await runStreamLoop(
      streamingUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.COPILOT_API_KEY ? { 'x-api-key': env.COPILOT_API_KEY } : {}),
        },
        body: JSON.stringify(requestPayload),
      },
      context,
      execContext,
      options
    )

    const result: OrchestratorResult = {
      success: context.errors.length === 0,
      content: context.accumulatedContent,
      contentBlocks: context.contentBlocks,
      toolCalls: buildToolCallSummaries(context),
      chatId: context.chatId,
      conversationId: context.conversationId,
      errors: context.errors.length ? context.errors : undefined,
    }
    await options.onComplete?.(result)
    return result
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Copilot orchestration failed')
    logger.error('Copilot orchestration failed', { error: err.message })
    await options.onError?.(err)
    return {
      success: false,
      content: '',
      contentBlocks: [],
      toolCalls: [],
      chatId: context.chatId,
      conversationId: context.conversationId,
      error: err.message,
    }
  }
}
