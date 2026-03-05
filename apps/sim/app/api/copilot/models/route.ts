import { spawnSync } from 'node:child_process'
import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { authenticateCopilotRequestSessionOnly } from '@/lib/copilot/request-helpers'
import type { AvailableModel } from '@/lib/copilot/types'

const logger = createLogger('CopilotModelsAPI')

interface ModelEntry {
  id: string
  friendlyName: string
  provider: string
  requiredCli: string
}

const MODEL_REGISTRY: ModelEntry[] = [
  // Claude (requires `claude` CLI)
  {
    id: 'claude-opus-4-6',
    friendlyName: 'Claude Opus 4.6',
    provider: 'anthropic',
    requiredCli: 'claude',
  },
  {
    id: 'claude-sonnet-4-6',
    friendlyName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    requiredCli: 'claude',
  },
  {
    id: 'claude-haiku-4-5',
    friendlyName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    requiredCli: 'claude',
  },
  // Gemini (requires `gemini` CLI)
  { id: 'gemini-3-pro', friendlyName: 'Gemini 3 Pro', provider: 'google', requiredCli: 'gemini' },
  {
    id: 'gemini-3-flash',
    friendlyName: 'Gemini 3 Flash',
    provider: 'google',
    requiredCli: 'gemini',
  },
  {
    id: 'gemini-2.5-pro',
    friendlyName: 'Gemini 2.5 Pro',
    provider: 'google',
    requiredCli: 'gemini',
  },
  {
    id: 'gemini-2.5-flash',
    friendlyName: 'Gemini 2.5 Flash',
    provider: 'google',
    requiredCli: 'gemini',
  },
  // Codex (requires `codex` CLI)
  { id: 'gpt-5.3-codex', friendlyName: 'GPT-5.3 Codex', provider: 'openai', requiredCli: 'codex' },
  { id: 'gpt-5-codex', friendlyName: 'GPT-5 Codex', provider: 'openai', requiredCli: 'codex' },
]

function hasCommand(cmd: string): boolean {
  return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0
}

export async function GET(_req: NextRequest) {
  const { userId, isAuthenticated } = await authenticateCopilotRequestSessionOnly()
  if (!isAuthenticated || !userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const cliCache = new Map<string, boolean>()
    const isCliAvailable = (cli: string): boolean => {
      if (!cliCache.has(cli)) {
        cliCache.set(cli, hasCommand(cli))
      }
      return cliCache.get(cli)!
    }

    const models: AvailableModel[] = MODEL_REGISTRY.map(({ requiredCli, ...model }) => ({
      ...model,
      available: isCliAvailable(requiredCli),
      unavailableReason: isCliAvailable(requiredCli)
        ? undefined
        : `${requiredCli} CLI가 설치되어 있지 않습니다`,
    }))

    logger.info('Local CLI model availability checked', {
      total: models.length,
      available: models.filter((m) => m.available).length,
    })

    return NextResponse.json({ success: true, models })
  } catch (error) {
    logger.error('Error checking local CLI availability', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { success: false, error: 'Failed to check available models', models: [] },
      { status: 500 }
    )
  }
}
