import { createLogger } from '@sim/logger'

const logger = createLogger('LocalToolDecisions')

/** TTL for stored decisions (10 minutes) */
const DECISION_TTL_MS = 10 * 60 * 1000

interface ToolDecision {
  status: 'accepted' | 'rejected' | 'background' | 'success' | 'error'
  message?: string
  timestamp: number
}

/**
 * In-memory store for local tool decisions.
 * Replaces Redis polling for local CLI provider — the confirm route
 * and the streaming route share the same Next.js process.
 */
const decisions = new Map<string, ToolDecision>()

/** Periodic cleanup of expired entries */
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanupTimer(): void {
  if (cleanupTimer) {
    return
  }
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of decisions) {
      if (now - value.timestamp > DECISION_TTL_MS) {
        decisions.delete(key)
      }
    }
    if (decisions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
  }, 60_000)
}

export function setLocalToolDecision(
  toolCallId: string,
  status: ToolDecision['status'],
  message?: string
): void {
  ensureCleanupTimer()
  decisions.set(toolCallId, {
    status,
    message,
    timestamp: Date.now(),
  })
  logger.info('Local tool decision set', { toolCallId, status })
}

export function getLocalToolDecision(toolCallId: string): ToolDecision | undefined {
  const decision = decisions.get(toolCallId)
  if (!decision) {
    return undefined
  }
  if (Date.now() - decision.timestamp > DECISION_TTL_MS) {
    decisions.delete(toolCallId)
    return undefined
  }
  return decision
}

export function deleteLocalToolDecision(toolCallId: string): void {
  decisions.delete(toolCallId)
}
