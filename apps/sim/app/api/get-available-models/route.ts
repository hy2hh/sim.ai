import { spawnSync } from 'node:child_process'
import { type NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/core/config/env'

interface ModelEntry {
  id: string
  friendlyName: string
  provider: string
  /** Which local CLI binary is required to run this model */
  requiredCli: string
}

/**
 * Manually-curated list of models supported by sim.ai local agent mode.
 * Each entry declares which CLI binary must be installed for the model to be usable.
 *
 * To add a new model: append an entry here. The availability check is automatic.
 */
const MODEL_REGISTRY: ModelEntry[] = [
  // ── Claude (requires `claude` CLI / Claude Code) ──────────────────────────
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

  // ── Gemini (requires `gemini` CLI) ────────────────────────────────────────
  {
    id: 'gemini-3-pro',
    friendlyName: 'Gemini 3 Pro',
    provider: 'google',
    requiredCli: 'gemini',
  },
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

  // ── Codex (requires `codex` CLI / OpenAI Codex) ───────────────────────────
  {
    id: 'gpt-5.3-codex',
    friendlyName: 'GPT-5.3 Codex',
    provider: 'openai',
    requiredCli: 'codex',
  },
  {
    id: 'gpt-5-codex',
    friendlyName: 'GPT-5 Codex',
    provider: 'openai',
    requiredCli: 'codex',
  },
]

function hasCommand(cmd: string): boolean {
  return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0
}

/**
 * Returns all models known to sim.ai, with an `available` flag indicating
 * whether the required local CLI is installed on this machine.
 */
export async function GET(_req: NextRequest) {
  if (env.COPILOT_API_KEY) {
    const providedKey = _req.headers.get('x-api-key')
    if (providedKey !== env.COPILOT_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // Check each unique CLI once
  const cliCache = new Map<string, boolean>()
  const isCliAvailable = (cli: string): boolean => {
    if (!cliCache.has(cli)) {
      cliCache.set(cli, hasCommand(cli))
    }
    return cliCache.get(cli)!
  }

  const models = MODEL_REGISTRY.map(({ requiredCli, ...model }) => ({
    ...model,
    available: isCliAvailable(requiredCli),
    unavailableReason: isCliAvailable(requiredCli)
      ? undefined
      : `${requiredCli} CLI가 설치되어 있지 않습니다`,
  }))

  return NextResponse.json({ success: true, models })
}
