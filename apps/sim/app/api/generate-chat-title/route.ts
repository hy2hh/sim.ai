import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/core/config/env'

export const runtime = 'nodejs'

const logger = createLogger('LocalAgentGenerateChatTitleLocalCli')
const COMMAND_TIMEOUT_MS = 45_000

type LocalBackend = 'claude' | 'gemini' | 'codex'

function hasLocalCommand(command: string): boolean {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  return result.status === 0
}

function toClaudeCliModel(model?: string): string {
  const normalized = (model || '').toLowerCase()
  if (normalized.includes('opus')) return 'opus'
  if (normalized.includes('haiku')) return 'haiku'
  return 'sonnet'
}

function toGeminiCliModel(model?: string): string {
  const normalized = (model || '').toLowerCase()
  if (normalized.includes('flash')) return 'gemini-2.5-flash'
  return 'gemini-2.5-pro'
}

function toCodexCliModel(model?: string): string {
  const normalized = (model || '').toLowerCase()
  if (normalized.includes('mini')) return 'gpt-5-mini'
  return 'gpt-5'
}

function resolveBackend(provider?: string, model?: string): LocalBackend {
  const p = (provider || '').toLowerCase()
  const m = (model || '').toLowerCase()
  if (p === 'google' || p === 'gemini' || m.includes('gemini')) return 'gemini'
  if (
    p === 'openai' ||
    p === 'openrouter' ||
    p === 'azure-openai' ||
    m.startsWith('gpt-') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  ) {
    return 'codex'
  }
  return 'claude'
}

function runCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ output: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        output: output.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      })
    })
  })
}

async function runClaude(prompt: string, model?: string) {
  return runCommandWithTimeout('claude', [
    '-p',
    prompt,
    '--output-format',
    'text',
    '--model',
    toClaudeCliModel(model),
    '--permission-mode',
    'default',
  ])
}

async function runGemini(prompt: string, model?: string) {
  const target = toGeminiCliModel(model)
  const variants = [
    ['-p', prompt, '--model', target],
    ['--prompt', prompt, '--model', target],
    ['-p', prompt],
  ]
  let last = { output: '', stderr: 'gemini command failed', exitCode: 1 }
  for (const args of variants) {
    try {
      const result = await runCommandWithTimeout('gemini', args)
      last = result
      if (result.exitCode === 0 && result.output) return result
    } catch (error) {
      last = {
        output: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      }
    }
  }
  return last
}

async function runCodex(prompt: string, model?: string) {
  const tempDir = await mkdtemp(join(tmpdir(), 'sim-copilot-title-codex-'))
  const outputPath = join(tempDir, 'last-message.txt')
  try {
    const result = await runCommandWithTimeout('codex', [
      'exec',
      prompt,
      '--model',
      toCodexCliModel(model),
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
    ])
    let fileOutput = ''
    try {
      fileOutput = (await readFile(outputPath, 'utf8')).trim()
    } catch {}
    return { ...result, output: fileOutput || result.output }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function POST(req: NextRequest) {
  if (env.COPILOT_API_KEY) {
    const providedKey = req.headers.get('x-api-key')
    if (providedKey !== env.COPILOT_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const message = body.message as string | undefined
  const model = body.model as string | undefined
  const provider = body.provider as string | undefined
  if (!message) {
    return NextResponse.json({ error: 'Missing message field' }, { status: 400 })
  }

  const prompt = `Create a very short chat title (3-6 words) for this message.
Return only the title with no quotes, no punctuation.

Message:
${message.slice(0, 200)}`

  try {
    const backend = resolveBackend(provider, model)
    if (
      (backend === 'claude' && !hasLocalCommand('claude')) ||
      (backend === 'gemini' && !hasLocalCommand('gemini')) ||
      (backend === 'codex' && !hasLocalCommand('codex'))
    ) {
      logger.warn('Title generation backend unavailable', { backend })
      return NextResponse.json({ title: null })
    }

    const result =
      backend === 'gemini'
        ? await runGemini(prompt, model)
        : backend === 'codex'
          ? await runCodex(prompt, model)
          : await runClaude(prompt, model)

    if (result.exitCode !== 0) {
      logger.error('Local CLI title generation failed', {
        backend,
        exitCode: result.exitCode,
        stderr: result.stderr,
      })
      return NextResponse.json({ title: null })
    }

    const firstLine = result.output.split('\n')[0] || ''
    const title =
      firstLine
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .slice(0, 60) || null
    return NextResponse.json({ title })
  } catch (err) {
    logger.error('Failed to generate chat title', {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ title: null })
  }
}
