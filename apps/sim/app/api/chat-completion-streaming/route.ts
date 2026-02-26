import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@sim/logger'
import { NextRequest } from 'next/server'
import { DIRECT_TOOL_DEFS } from '@/lib/copilot/tools/mcp/definitions'
import {
  executeToolServerSide,
  isToolAvailableOnSimSide,
  prepareExecutionContext,
} from '@/lib/copilot/orchestrator/tool-executor'
import { env } from '@/lib/core/config/env'

export const runtime = 'nodejs'

const logger = createLogger('LocalAgentStreamingLocalCli')

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const MAX_PROMPT_CHARS = 120_000
const MAX_AGENT_ITERATIONS = 12
const COMMAND_TIMEOUT_MS = 120_000
const MAX_CONVERSATION_MESSAGES = 40
const MAX_INTEGRATION_TOOLS = 120

type LocalBackend = 'claude' | 'gemini' | 'codex'

type ChatRole = 'user' | 'assistant'

interface ChatMessage {
  role: ChatRole
  content: string
}

interface PromptToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ToolCallRequest {
  id?: string
  name: string
  arguments?: Record<string, unknown>
}

type AgentDecision =
  | { type: 'assistant'; content: string }
  | { type: 'tool_calls'; calls: ToolCallRequest[] }

interface AgentLoopMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
}

const DIRECT_TOOL_NAME_TO_ID: Record<string, string> = Object.fromEntries(
  DIRECT_TOOL_DEFS.map((def) => [def.name, def.toolId])
)

const SERVER_TOOL_DEFINITIONS: PromptToolDefinition[] = [
  {
    name: 'get_blocks_and_tools',
    description: 'List available block types in Sim.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_blocks_metadata',
    description: 'Get metadata for one or more block types.',
    inputSchema: {
      type: 'object',
      properties: {
        blockIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['blockIds'],
    },
  },
  {
    name: 'get_block_options',
    description: 'Get operations/sub-actions for a block type.',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string' },
      },
      required: ['blockId'],
    },
  },
  {
    name: 'get_block_config',
    description: 'Get detailed configuration schema for a block type.',
    inputSchema: {
      type: 'object',
      properties: {
        blockType: { type: 'string' },
        operation: { type: 'string' },
        trigger: { type: 'boolean' },
      },
      required: ['blockType'],
    },
  },
  {
    name: 'get_trigger_blocks',
    description: 'Get available trigger block types.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_workflow',
    description: 'Apply add/edit/delete operations to the workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        operations: { type: 'array' },
      },
      required: ['operations'],
    },
  },
  {
    name: 'get_workflow_console',
    description: 'Fetch recent workflow console logs.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'search_documentation',
    description: 'Search Sim documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_online',
    description: 'Search the web for external references.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'set_environment_variables',
    description: 'Set workflow environment variables.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        variables: { type: 'object' },
      },
      required: ['variables'],
    },
  },
  {
    name: 'get_credentials',
    description: 'Get available OAuth/API credentials for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
      },
    },
  },
  {
    name: 'make_api_request',
    description: 'Make an HTTP request to an external API.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'object' },
      },
      required: ['url', 'method'],
    },
  },
  {
    name: 'knowledge_base',
    description: 'Manage and query knowledge bases.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['operation'],
    },
  },
]

function writeSSE(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  data: unknown
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
}

function normalizeSelectedModel(payload: Record<string, unknown>): string {
  const raw = (typeof payload.model === 'string' ? payload.model : '').trim()
  if (!raw) return DEFAULT_MODEL

  const slashIdx = raw.indexOf('/')
  if (slashIdx > 0 && slashIdx < raw.length - 1) {
    return raw.slice(slashIdx + 1)
  }
  return raw
}

function toClaudeCliModel(model: string): string {
  const normalized = model.toLowerCase()
  if (normalized.includes('opus')) return 'opus'
  if (normalized.includes('sonnet')) return 'sonnet'
  if (normalized.includes('haiku')) return 'haiku'
  return model
}

function toGeminiCliModel(model: string): string {
  const normalized = model.toLowerCase()
  if (normalized.includes('pro')) return 'gemini-2.5-pro'
  if (normalized.includes('flash')) return 'gemini-2.5-flash'
  if (normalized.includes('gemini')) return model
  return 'gemini-2.5-pro'
}

function toCodexCliModel(model: string): string {
  const normalized = model.toLowerCase()
  if (normalized.startsWith('gpt-')) return model
  if (normalized.includes('mini')) return 'gpt-5-mini'
  return 'gpt-5'
}

function normalizeProvider(payload: Record<string, unknown>): string {
  const raw = (typeof payload.provider === 'string' ? payload.provider : '').trim().toLowerCase()
  return raw
}

function resolveBackend(payload: Record<string, unknown>, model: string): LocalBackend {
  const provider = normalizeProvider(payload)
  if (provider === 'google' || provider === 'gemini') return 'gemini'
  if (
    provider === 'openai' ||
    provider === 'openrouter' ||
    provider === 'azure-openai' ||
    provider === 'deepseek' ||
    provider === 'xai'
  ) {
    return 'codex'
  }
  if (provider === 'anthropic') return 'claude'

  const normalizedModel = model.toLowerCase()
  if (normalizedModel.includes('gemini')) return 'gemini'
  if (
    normalizedModel.startsWith('gpt-') ||
    normalizedModel.startsWith('o1') ||
    normalizedModel.startsWith('o3') ||
    normalizedModel.startsWith('o4')
  ) {
    return 'codex'
  }
  return 'claude'
}

function hasLocalCommand(command: string): boolean {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  return result.status === 0
}

function isBackendAvailable(backend: LocalBackend): boolean {
  if (backend === 'gemini') return hasLocalCommand('gemini')
  if (backend === 'codex') return hasLocalCommand('codex')
  return hasLocalCommand('claude')
}

function runCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode: exitCode ?? 1, stderr, stdout: stdout.trim() })
    })
  })
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  return null
}

function parseAgentDecision(raw: string): AgentDecision {
  const candidate = extractJsonCandidate(raw)
  if (!candidate) {
    return { type: 'assistant', content: raw.trim() }
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const type = parsed.type
    if (type === 'assistant' && typeof parsed.content === 'string') {
      return { type: 'assistant', content: parsed.content.trim() }
    }

    const rawCalls = Array.isArray(parsed.calls)
      ? parsed.calls
      : Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
        : null

    if ((type === 'tool_calls' || rawCalls) && rawCalls) {
      const calls: ToolCallRequest[] = rawCalls
        .map((item) => toObject(item))
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : undefined,
          name: typeof item.name === 'string' ? item.name : '',
          arguments: toObject(item.arguments),
        }))
        .filter((call) => call.name)

      if (calls.length > 0) {
        return { type: 'tool_calls', calls }
      }
    }
  } catch {}

  return { type: 'assistant', content: raw.trim() }
}

function truncatePrompt(input: string): string {
  if (input.length <= MAX_PROMPT_CHARS) return input
  return input.slice(input.length - MAX_PROMPT_CHARS)
}

function chunkText(input: string, maxChunk = 320): string[] {
  if (!input) return []
  const chunks: string[] = []
  for (let i = 0; i < input.length; i += maxChunk) {
    chunks.push(input.slice(i, i + maxChunk))
  }
  return chunks
}

function normalizeHistory(payload: Record<string, unknown>): AgentLoopMessage[] {
  const messages: AgentLoopMessage[] = []
  const history = payload.conversationHistory as unknown[] | undefined
  if (Array.isArray(history)) {
    for (const item of history) {
      const msg = toObject(item)
      const role = msg.role
      if (role !== 'user' && role !== 'assistant') continue
      const content = msg.content
      if (!content) continue
      messages.push({
        role,
        content: typeof content === 'string' ? content : safeStringify(content),
      })
    }
  }

  const latestMessage = payload.message as string | undefined
  if (latestMessage) {
    const contexts = payload.context as Array<{ type: string; content: string }> | undefined
    let userContent = latestMessage
    if (Array.isArray(contexts) && contexts.length > 0) {
      const contextParts = contexts
        .filter((c) => c?.content)
        .map((c) => `<context type="${c.type}">\n${c.content}\n</context>`)
        .join('\n\n')
      if (contextParts) userContent = `${contextParts}\n\n${latestMessage}`
    }
    messages.push({ role: 'user', content: userContent })
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' })
  }

  return messages.slice(-MAX_CONVERSATION_MESSAGES)
}

function buildToolDefinitions(integrationTools: unknown[] = []): PromptToolDefinition[] {
  const tools: PromptToolDefinition[] = []
  const seen = new Set<string>()

  const addTool = (name: string, description: string, inputSchema: Record<string, unknown>) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    tools.push({ name, description, inputSchema })
  }

  for (const def of DIRECT_TOOL_DEFS) {
    addTool(
      def.name,
      def.description,
      toObject(def.inputSchema as unknown as Record<string, unknown>)
    )
  }

  for (const def of SERVER_TOOL_DEFINITIONS) {
    addTool(def.name, def.description, def.inputSchema)
  }

  let integrationCount = 0
  for (const raw of integrationTools) {
    if (integrationCount >= MAX_INTEGRATION_TOOLS) break
    const t = toObject(raw)
    const name = typeof t.name === 'string' ? t.name : ''
    const description = typeof t.description === 'string' ? t.description : ''
    if (!name || !description) continue
    const schema = toObject(t.input_schema)
    addTool(name, description, schema)
    integrationCount++
  }

  return tools
}

function buildPlannerPrompt(params: {
  workflowId?: string
  mode?: string
  tools: PromptToolDefinition[]
  messages: AgentLoopMessage[]
}): string {
  const { workflowId, mode, tools, messages } = params

  const compactTools = tools.map((tool) => {
    const schema = toObject(tool.inputSchema)
    const properties = toObject(schema.properties)
    const required = Array.isArray(schema.required) ? schema.required.slice(0, 20) : []
    return {
      name: tool.name,
      description: tool.description,
      params: {
        required,
        properties: Object.keys(properties).slice(0, 30),
      },
    }
  })

  const transcript = messages
    .map((m) => {
      if (m.role === 'tool') {
        return `Tool(${m.name || 'unknown'} #${m.toolCallId || 'n/a'}):\n${m.content}`
      }
      return `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`
    })
    .join('\n\n')

  const prompt = `You are Sim Copilot.

Context:
- Workflow ID: ${workflowId || 'unknown'}
- Mode: ${mode || 'build'}

Platform overview:
- Sim uses blocks + edges to build automations.
- You can inspect available blocks/tools, read block config, then edit workflow.
- Variable references use <BlockName.outputField> style.

Workflow build sequence:
1) Call get_blocks_and_tools
2) For each target block type, call get_block_config
3) Apply changes with edit_workflow (operations array)
4) Validate/debug with get_workflow_console if needed

Available tools (JSON):
${safeStringify(compactTools)}

Conversation:
${transcript}

Decide the next step and output JSON only.

When you need tools:
{
  "type": "tool_calls",
  "calls": [
    {
      "id": "tool_1",
      "name": "tool_name_from_list",
      "arguments": { "key": "value" }
    }
  ]
}

When you can answer directly:
{
  "type": "assistant",
  "content": "final response text for the user"
}

Rules:
- Never call a tool not listed in available tools.
- Keep arguments as a JSON object.
- Prefer tool calls over guessing when workflow state is uncertain.
- Continue the tool loop until enough evidence is collected, then return assistant content.
- Return strict JSON only, with no markdown or code fences.`

  return truncatePrompt(prompt)
}

function buildForcedSummaryPrompt(params: {
  workflowId?: string
  mode?: string
  messages: AgentLoopMessage[]
}): string {
  const { workflowId, mode, messages } = params
  const transcript = messages
    .map((m) => {
      if (m.role === 'tool') {
        return `Tool(${m.name || 'unknown'} #${m.toolCallId || 'n/a'}):\n${m.content}`
      }
      return `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`
    })
    .join('\n\n')

  const prompt = `You are Sim Copilot.

Context:
- Workflow ID: ${workflowId || 'unknown'}
- Mode: ${mode || 'build'}

Conversation and tool results:
${transcript}

Now provide the best possible assistant response to the user.
Rules:
- Do not call tools.
- Respond in plain text only.
- Keep it actionable and concise.`

  return truncatePrompt(prompt)
}

function buildMessages(payload: Record<string, unknown>): ChatMessage[] {
  const messages: ChatMessage[] = []

  const history = payload.conversationHistory as unknown[] | undefined
  if (Array.isArray(history)) {
    for (const item of history) {
      if (typeof item !== 'object' || !item) continue
      const m = item as Record<string, unknown>
      const role = m.role as string | undefined
      if (role !== 'user' && role !== 'assistant') continue
      const content = m.content
      if (!content) continue
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      if (text) messages.push({ role, content: text })
    }
  }

  const latestMessage = payload.message as string | undefined
  if (latestMessage) {
    const contexts = payload.context as Array<{ type: string; content: string }> | undefined
    let userContent = latestMessage

    if (Array.isArray(contexts) && contexts.length > 0) {
      const contextParts = contexts
        .filter((c) => c.content)
        .map((c) => `<context type="${c.type}">\n${c.content}\n</context>`)
        .join('\n\n')

      if (contextParts) {
        userContent = `${contextParts}\n\n${latestMessage}`
      }
    }

    messages.push({ role: 'user', content: userContent })
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' })
  }

  return messages
}

function buildPrompt(payload: Record<string, unknown>): string {
  const workflowId = payload.workflowId as string | undefined
  const mode = payload.mode as string | undefined
  const messages = buildMessages(payload)

  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`)
    .join('\n\n')

  const prompt = `You are Sim Copilot running through the local Claude Code CLI.

Constraints:
- You must only return assistant reply text for the user message.
- Do not include tool-call JSON, XML wrappers, or code fences unless the user asks.
- Keep answers practical and concise.

Context:
- Workflow ID: ${workflowId || 'unknown'}
- Mode: ${mode || 'build'}

Conversation:
${transcript}

Now provide the next assistant response.`

  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(-MAX_PROMPT_CHARS) : prompt
}

async function runClaudeCode(
  prompt: string,
  model: string
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'text',
    '--model',
    toClaudeCliModel(model),
    '--permission-mode',
    'default',
  ]
  return runCommandWithTimeout('claude', args)
}

async function runGeminiCli(
  prompt: string,
  model: string
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const targetModel = toGeminiCliModel(model)
  const variants: string[][] = [
    ['-p', prompt, '--model', targetModel],
    ['--prompt', prompt, '--model', targetModel],
    ['-p', prompt],
  ]

  let lastResult: { exitCode: number; stderr: string; stdout: string } = {
    exitCode: 1,
    stderr: 'gemini command failed',
    stdout: '',
  }
  for (const args of variants) {
    try {
      const result = await runCommandWithTimeout('gemini', args)
      lastResult = result
      if (result.exitCode === 0 && result.stdout) return result
    } catch (error) {
      lastResult = {
        exitCode: 1,
        stderr: error instanceof Error ? error.message : String(error),
        stdout: '',
      }
    }
  }
  return lastResult
}

async function runCodexCli(
  prompt: string,
  model: string
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const modelName = toCodexCliModel(model)
  const tempDir = await mkdtemp(join(tmpdir(), 'sim-copilot-codex-'))
  const outputPath = join(tempDir, 'last-message.txt')
  try {
    const args = [
      'exec',
      prompt,
      '--model',
      modelName,
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
    ]

    const result = await runCommandWithTimeout('codex', args)
    let fileOutput = ''
    try {
      fileOutput = (await readFile(outputPath, 'utf8')).trim()
    } catch {}

    return {
      ...result,
      stdout: fileOutput || result.stdout,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function runLocalBackend(params: {
  backend: LocalBackend
  prompt: string
  model: string
}): Promise<{ exitCode: number; stderr: string; stdout: string; backend: LocalBackend }> {
  const { backend, prompt, model } = params

  if (backend === 'gemini') {
    const result = await runGeminiCli(prompt, model)
    return { ...result, backend }
  }
  if (backend === 'codex') {
    const result = await runCodexCli(prompt, model)
    return { ...result, backend }
  }

  const result = await runClaudeCode(prompt, model)
  return { ...result, backend: 'claude' }
}

export async function POST(req: NextRequest) {
  if (env.COPILOT_API_KEY) {
    const providedKey = req.headers.get('x-api-key')
    if (providedKey !== env.COPILOT_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const userId = payload.userId as string | undefined
  const workflowId = payload.workflowId as string | undefined
  if (!userId || !workflowId) {
    return new Response(JSON.stringify({ error: 'Missing required fields: userId, workflowId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const selectedModel = normalizeSelectedModel(payload)
  const backend = resolveBackend(payload, selectedModel)
  const encoder = new TextEncoder()
  const responseId = crypto.randomUUID()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (!isBackendAvailable(backend)) {
          writeSSE(controller, encoder, {
            type: 'error',
            data: {
              message: `[${backend}] provider unavailable: local CLI is not installed or not accessible on PATH.`,
            },
          })
          return
        }

        const execContext = await prepareExecutionContext(userId, workflowId)
        const integrationTools = Array.isArray(payload.integrationTools)
          ? payload.integrationTools
          : []
        const toolDefs = buildToolDefinitions(integrationTools)
        const conversation = normalizeHistory(payload)
        const mode = typeof payload.mode === 'string' ? payload.mode : undefined

        for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
          writeSSE(controller, encoder, { type: 'reasoning', phase: 'start' })
          const prompt = buildPlannerPrompt({
            workflowId,
            mode,
            tools: toolDefs,
            messages: conversation,
          })

          const result = await runLocalBackend({
            backend,
            prompt,
            model: selectedModel,
          })
          writeSSE(controller, encoder, { type: 'reasoning', phase: 'end' })

          if (result.exitCode !== 0) {
            logger.error('Local model command returned non-zero status', {
              backend: result.backend,
              exitCode: result.exitCode,
              stderr: result.stderr,
            })
            writeSSE(controller, encoder, {
              type: 'error',
              data: {
                message: result.stderr.trim()
                  ? `[${result.backend}] ${result.stderr.trim()}`
                  : `${result.backend} command failed with code ${result.exitCode}`,
              },
            })
            return
          }

          const decision = parseAgentDecision(result.stdout)

          if (decision.type === 'assistant') {
            const finalText = decision.content || result.stdout || '요청을 처리했습니다.'
            for (const chunk of chunkText(finalText)) {
              writeSSE(controller, encoder, { type: 'content', data: chunk })
            }
            writeSSE(controller, encoder, { type: 'done', data: { responseId } })
            return
          }

          if (!decision.calls.length) {
            const fallback = result.stdout || '도구 호출 결과가 비어 있어 응답을 마칩니다.'
            writeSSE(controller, encoder, { type: 'content', data: fallback })
            writeSSE(controller, encoder, { type: 'done', data: { responseId } })
            return
          }

          conversation.push({
            role: 'assistant',
            content: safeStringify({
              type: 'tool_calls',
              calls: decision.calls,
            }),
          })

          for (let index = 0; index < decision.calls.length; index++) {
            const call = decision.calls[index]
            const toolCallId = call.id || `tool_${iteration + 1}_${index + 1}_${crypto.randomUUID()}`
            const originalName = call.name
            const mappedName = DIRECT_TOOL_NAME_TO_ID[originalName] ?? originalName
            const args = toObject(call.arguments)

            writeSSE(controller, encoder, {
              type: 'tool_generating',
              toolCallId,
              toolName: originalName,
            })
            writeSSE(controller, encoder, {
              type: 'tool_call',
              data: { id: toolCallId, name: originalName, arguments: args },
            })

            if (!isToolAvailableOnSimSide(mappedName)) {
              const unavailableMessage = `Tool not available on Sim side: ${originalName}`
              writeSSE(controller, encoder, {
                type: 'tool_result',
                data: {
                  id: toolCallId,
                  name: originalName,
                  success: false,
                  error: unavailableMessage,
                },
              })
              writeSSE(controller, encoder, {
                type: 'tool_error',
                data: {
                  id: toolCallId,
                  name: originalName,
                  error: unavailableMessage,
                },
              })
              conversation.push({
                role: 'tool',
                name: originalName,
                toolCallId,
                content: safeStringify({ success: false, error: unavailableMessage }),
              })
              continue
            }

            const toolCallState = {
              id: toolCallId,
              name: mappedName,
              status: 'executing' as const,
              params: args,
              startTime: Date.now(),
            }

            let execution:
              | { success: true; output?: unknown; error?: string }
              | { success: false; output?: unknown; error?: string }
            try {
              execution = await executeToolServerSide(toolCallState, execContext)
            } catch (error) {
              execution = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }

            writeSSE(controller, encoder, {
              type: 'tool_result',
              data: {
                id: toolCallId,
                name: originalName,
                success: execution.success,
                result: execution.output,
                ...(execution.error ? { error: execution.error } : {}),
              },
            })
            if (!execution.success && execution.error) {
              writeSSE(controller, encoder, {
                type: 'tool_error',
                data: {
                  id: toolCallId,
                  name: originalName,
                  error: execution.error,
                },
              })
            }

            conversation.push({
              role: 'tool',
              name: originalName,
              toolCallId,
              content: safeStringify({
                success: execution.success,
                result: execution.output,
                error: execution.error,
              }),
            })
          }
        }
        const summaryPrompt = buildForcedSummaryPrompt({
          workflowId,
          mode,
          messages: conversation,
        })
        const final = await runLocalBackend({
          backend,
          prompt: summaryPrompt,
          model: selectedModel,
        })
        if (final.exitCode === 0 && final.stdout) {
          for (const chunk of chunkText(final.stdout)) {
            writeSSE(controller, encoder, { type: 'content', data: chunk })
          }
          writeSSE(controller, encoder, { type: 'done', data: { responseId } })
          return
        }

        writeSSE(controller, encoder, {
          type: 'error',
          data: {
            message: final.stderr?.trim()
              ? `[${final.backend}] ${final.stderr.trim()}`
              : '최대 도구 반복 횟수에 도달했고 요약 응답 생성에 실패했습니다.',
          },
        })
      } catch (err) {
        logger.error('Local CLI streaming error', {
          error: err instanceof Error ? err.message : String(err),
        })
        writeSSE(controller, encoder, {
          type: 'error',
          data: { message: err instanceof Error ? err.message : 'Unknown error' },
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
