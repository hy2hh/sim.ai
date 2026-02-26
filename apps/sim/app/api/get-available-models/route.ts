import { type NextRequest, NextResponse } from 'next/server'
import { spawnSync } from 'node:child_process'
import { env } from '@/lib/core/config/env'

/**
 * Returns the model list for local agent mode.
 * Uses locally installed CLIs (Claude Code / Gemini / Codex).
 */
export async function GET(_req: NextRequest) {
  if (env.COPILOT_API_KEY) {
    const providedKey = _req.headers.get('x-api-key')
    if (providedKey !== env.COPILOT_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const hasCommand = (cmd: string): boolean => {
    const result = spawnSync('which', [cmd], { encoding: 'utf8' })
    return result.status === 0
  }

  const models: Array<{ id: string; friendlyName: string; provider: string }> = []

  if (hasCommand('claude')) {
    models.push(
      {
        id: 'claude-opus-4-6',
        friendlyName: 'Claude Opus 4.6 (Claude Code)',
        provider: 'anthropic',
      },
      {
        id: 'claude-sonnet-4-6',
        friendlyName: 'Claude Sonnet 4.6 (Claude Code)',
        provider: 'anthropic',
      },
      {
        id: 'claude-haiku-4-5',
        friendlyName: 'Claude Haiku 4.5 (Claude Code)',
        provider: 'anthropic',
      }
    )
  }

  if (hasCommand('gemini')) {
    models.push(
      {
        id: 'gemini-2.5-pro',
        friendlyName: 'Gemini 2.5 Pro (Gemini CLI)',
        provider: 'google',
      },
      {
        id: 'gemini-2.5-flash',
        friendlyName: 'Gemini 2.5 Flash (Gemini CLI)',
        provider: 'google',
      }
    )
  }

  if (hasCommand('codex')) {
    models.push(
      {
        id: 'gpt-5',
        friendlyName: 'GPT-5 (Codex CLI)',
        provider: 'openai',
      },
      {
        id: 'gpt-5-mini',
        friendlyName: 'GPT-5 Mini (Codex CLI)',
        provider: 'openai',
      }
    )
  }

  if (models.length === 0) {
    // Conservative fallback
    models.push({
      id: 'claude-sonnet-4-6',
      friendlyName: 'Claude Sonnet 4.6 (Claude Code)',
      provider: 'anthropic',
    })
  }

  return NextResponse.json({
    success: true,
    models,
  })
}
