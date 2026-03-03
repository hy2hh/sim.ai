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
const COMMAND_TIMEOUT_MS = 120_000
/** Shorter timeout for the lightweight router call */
const ROUTER_TIMEOUT_MS = 30_000
const MAX_CONVERSATION_MESSAGES = 40
const MAX_INTEGRATION_TOOLS = 120

type LocalBackend = 'claude' | 'gemini' | 'codex'
type AgentType = 'build' | 'plan' | 'info' | 'debug' | 'research' | 'ask'
type ComplexityLevel = 'simple' | 'medium' | 'complex'
type ModelTier = 'light' | 'medium' | 'heavy'

interface RoutingDecision {
  agentType: AgentType
  complexity: ComplexityLevel
}

interface SubagentConfig {
  systemPrompt: string
  /** SERVER_TOOL_DEFINITIONS names to include; '*' = all */
  allowedServerTools: string[]
  /** DIRECT_TOOL_DEFS names to include; '*' = all */
  allowedDirectTools: string[]
  maxIterations: number
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

// ---------------------------------------------------------------------------
// Model tier mapping (backend → tier → model ID)
// ---------------------------------------------------------------------------

const MODEL_TIERS: Record<LocalBackend, Record<ModelTier, string>> = {
  claude: {
    light: 'claude-haiku-4-5',
    medium: 'claude-sonnet-4-6',
    heavy: 'claude-opus-4-6',
  },
  gemini: {
    light: 'gemini-3-flash',
    medium: 'gemini-3-flash',
    heavy: 'gemini-3-pro',
  },
  codex: {
    light: 'gpt-5-codex',
    medium: 'gpt-5-codex',
    heavy: 'gpt-5.3-codex',
  },
}

// ---------------------------------------------------------------------------
// Subagent configurations
// ---------------------------------------------------------------------------

const SUBAGENT_CONFIGS: Record<AgentType, SubagentConfig> = {
  ask: {
    systemPrompt: `You are Sim Copilot, an expert assistant for the Sim automation platform.
Your role: Answer general questions and explain Sim platform concepts clearly.

Platform overview:
- Sim uses blocks + edges to build workflow automations
- Variable references use <BlockName.outputField> syntax
- Blocks connect via edges to pass data between steps

Guidelines:
- Use search_documentation first to find accurate platform information
- Never modify the workflow or call edit_workflow
- Provide clear, concise explanations with examples when helpful`,
    allowedServerTools: ['search_documentation', 'search_online'],
    allowedDirectTools: [],
    maxIterations: 4,
  },

  info: {
    systemPrompt: `You are Sim Copilot, analyzing and explaining workflow structure.
Your role: Inspect the current workflow state and explain it clearly to the user.

Platform overview:
- Sim uses blocks + edges to build workflow automations
- Variable references use <BlockName.outputField> syntax

Guidelines:
- NEVER call edit_workflow or modify the workflow in any way
- Use get_blocks_and_tools to understand available block types
- Use get_block_config to understand specific block configurations
- Use get_workflow_console to check recent execution logs
- Explain block configurations, connections, and data flow clearly`,
    allowedServerTools: [
      'get_blocks_and_tools',
      'get_blocks_metadata',
      'get_block_options',
      'get_block_config',
      'get_trigger_blocks',
      'get_workflow_console',
      'search_documentation',
    ],
    allowedDirectTools: [],
    maxIterations: 6,
  },

  research: {
    systemPrompt: `You are Sim Copilot, researching external APIs and services.
Your role: Investigate external APIs, services, and documentation to inform workflow building.

Guidelines:
- Use search_online to find API documentation and examples
- Use search_documentation for Sim-specific information
- Use make_api_request to test API endpoints when needed
- Summarize findings clearly: API endpoints, authentication methods, data formats
- Never modify the workflow`,
    allowedServerTools: ['search_online', 'search_documentation', 'make_api_request'],
    allowedDirectTools: [],
    maxIterations: 4,
  },

  plan: {
    systemPrompt: `You are Sim Copilot, planning workflow changes without executing them.
Your role: Design a detailed implementation plan for the requested workflow changes.

Platform overview:
- Sim uses blocks + edges to build workflow automations
- Variable references use <BlockName.outputField> syntax (e.g., <Gmail.subject>)
- Blocks can be triggers, actions, conditions, or utilities

Guidelines:
- NEVER call edit_workflow — this is a planning phase only
- Use get_blocks_and_tools to identify required block types
- Use get_block_config to understand configuration requirements
- Use get_credentials to identify required authentication
- Return a step-by-step plan: required blocks, configurations, connections, credentials needed`,
    allowedServerTools: [
      'get_blocks_and_tools',
      'get_blocks_metadata',
      'get_block_options',
      'get_block_config',
      'get_trigger_blocks',
      'get_workflow_console',
      'search_documentation',
      'get_credentials',
    ],
    allowedDirectTools: [],
    maxIterations: 8,
  },

  debug: {
    systemPrompt: `You are Sim Copilot, diagnosing and fixing workflow errors.
Your role: Analyze workflow errors, identify root causes, and apply fixes.

Platform overview:
- Sim uses blocks + edges to build workflow automations
- Variable references use <BlockName.outputField> syntax

Debugging workflow:
1) Check get_workflow_console for recent error logs
2) Use get_block_config to verify block configurations
3) Use get_blocks_and_tools to confirm available block types
4) Apply targeted fixes with edit_workflow for simple corrections
5) Explain the root cause and what was fixed to the user`,
    allowedServerTools: [
      'get_workflow_console',
      'get_block_config',
      'get_blocks_and_tools',
      'edit_workflow',
      'search_documentation',
    ],
    allowedDirectTools: [],
    maxIterations: 8,
  },

  build: {
    systemPrompt: `You are Sim Copilot, building and modifying workflow automations.
Your role: Create and configure workflow blocks, connections, and settings.

Platform overview:
- Sim uses blocks + edges to build workflow automations
- Variable references use <BlockName.outputField> syntax (e.g., <Gmail.subject>)
- Blocks connect via edges to pass data between steps

Workflow build sequence:
1) Call get_blocks_and_tools to find available block types
2) For each target block, call get_block_config to get the configuration schema
3) Call get_credentials if OAuth/API authentication is required
4) Apply changes with edit_workflow using the operations array
5) Validate with get_workflow_console if needed`,
    allowedServerTools: ['*'],
    allowedDirectTools: ['*'],
    maxIterations: 12,
  },
}

// ---------------------------------------------------------------------------
// Tool name → ID mapping for direct tools
// ---------------------------------------------------------------------------

const DIRECT_TOOL_NAME_TO_ID: Record<string, string> = Object.fromEntries(
  DIRECT_TOOL_DEFS.map((def) => [def.name, def.toolId])
)

// ---------------------------------------------------------------------------
// Server-side tool definitions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function writeSSE(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  data: unknown
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
}

function normalizeSelectedModel(payload: Record<string, unknown>): string {
  const raw = (typeof payload.model === 'string' ? payload.model : '').trim()
  if (!raw) {
    return DEFAULT_MODEL
  }

  const slashIdx = raw.indexOf('/')
  if (slashIdx > 0 && slashIdx < raw.length - 1) {
    return raw.slice(slashIdx + 1)
  }
  return raw
}

/**
 * Pass the exact model ID to the Claude CLI.
 * Claude Code accepts full model IDs (e.g. 'claude-opus-4-6') directly.
 */
function toClaudeCliModel(model: string): string {
  return model
}

/**
 * Pass the exact model ID to the Gemini CLI.
 * Gemini CLI accepts model names as-is (e.g. 'gemini-3-pro', 'gemini-2.5-flash').
 */
function toGeminiCliModel(model: string): string {
  return model
}

/**
 * Pass the exact model ID to the Codex CLI.
 * Codex CLI accepts model names as-is (e.g. 'gpt-5.3-codex', 'gpt-5-codex').
 */
function toCodexCliModel(model: string): string {
  return model
}

function normalizeProvider(payload: Record<string, unknown>): string {
  const raw = (typeof payload.provider === 'string' ? payload.provider : '').trim().toLowerCase()
  return raw
}

function resolveBackend(payload: Record<string, unknown>, model: string): LocalBackend {
  const provider = normalizeProvider(payload)
  if (provider === 'google' || provider === 'gemini') {
    return 'gemini'
  }
  if (
    provider === 'openai' ||
    provider === 'openrouter' ||
    provider === 'azure-openai' ||
    provider === 'deepseek' ||
    provider === 'xai'
  ) {
    return 'codex'
  }
  if (provider === 'anthropic') {
    return 'claude'
  }

  const normalizedModel = model.toLowerCase()
  if (normalizedModel.includes('gemini')) {
    return 'gemini'
  }
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
  if (backend === 'gemini') {
    return hasLocalCommand('gemini')
  }
  if (backend === 'codex') {
    return hasLocalCommand('codex')
  }
  return hasLocalCommand('claude')
}

function runCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const { CLAUDECODE: _, ...envWithoutClaudeCode } = process.env
    const child = spawn(command, args, {
      env: envWithoutClaudeCode,
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
  if (!trimmed) {
    return null
  }

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
  if (input.length <= MAX_PROMPT_CHARS) {
    return input
  }
  return input.slice(input.length - MAX_PROMPT_CHARS)
}

function chunkText(input: string, maxChunk = 320): string[] {
  if (!input) {
    return []
  }
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
      if (role !== 'user' && role !== 'assistant') {
        continue
      }
      const content = msg.content
      if (!content) {
        continue
      }
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
      if (contextParts) {
        userContent = `${contextParts}\n\n${latestMessage}`
      }
    }
    messages.push({ role: 'user', content: userContent })
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Hello' })
  }

  return messages.slice(-MAX_CONVERSATION_MESSAGES)
}

// ---------------------------------------------------------------------------
// CLI runners
// ---------------------------------------------------------------------------

async function runClaudeCode(
  prompt: string,
  model: string,
  timeoutMs = COMMAND_TIMEOUT_MS
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
  return runCommandWithTimeout('claude', args, timeoutMs)
}

async function runGeminiCli(
  prompt: string,
  model: string,
  timeoutMs = COMMAND_TIMEOUT_MS
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
      const result = await runCommandWithTimeout('gemini', args, timeoutMs)
      lastResult = result
      if (result.exitCode === 0 && result.stdout) {
        return result
      }
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
  model: string,
  timeoutMs = COMMAND_TIMEOUT_MS
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

    const result = await runCommandWithTimeout('codex', args, timeoutMs)
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
  timeoutMs?: number
}): Promise<{ exitCode: number; stderr: string; stdout: string; backend: LocalBackend }> {
  const { backend, prompt, model, timeoutMs } = params

  if (backend === 'gemini') {
    const result = await runGeminiCli(prompt, model, timeoutMs)
    return { ...result, backend }
  }
  if (backend === 'codex') {
    const result = await runCodexCli(prompt, model, timeoutMs)
    return { ...result, backend }
  }

  const result = await runClaudeCode(prompt, model, timeoutMs)
  return { ...result, backend: 'claude' }
}

// ---------------------------------------------------------------------------
// Router: Phase 1 — classify intent
// ---------------------------------------------------------------------------

function buildRouterPrompt(message: string, recentHistory: AgentLoopMessage[]): string {
  const recentTurns = recentHistory
    .slice(-2)
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join('\n')

  return `Classify this Sim copilot request. Output JSON only.

agentType: build|plan|info|debug|research|ask
- build: create/modify/configure workflow blocks and connections
- plan: plan workflow changes without executing them
- info: inspect or explain existing workflow state
- debug: diagnose errors or unexpected behavior
- research: look up external APIs or third-party documentation
- ask: general questions about Sim platform

complexity: simple|medium|complex
- simple: 1-2 steps, clear intent, no ambiguity
- medium: multiple blocks/integrations, some investigation needed
- complex: multi-step orchestration, deep debugging, or unclear scope

Request: "${message}"
Recent context: ${recentTurns}

Output: {"agentType":"...","complexity":"..."}`
}

async function classifyRequest(
  message: string,
  history: AgentLoopMessage[],
  backend: LocalBackend
): Promise<RoutingDecision> {
  const fallback: RoutingDecision = { agentType: 'build', complexity: 'medium' }
  try {
    const routerPrompt = buildRouterPrompt(message, history)
    const lightModel = MODEL_TIERS[backend].light
    const result = await runLocalBackend({
      backend,
      prompt: routerPrompt,
      model: lightModel,
      timeoutMs: ROUTER_TIMEOUT_MS,
    })

    if (result.exitCode !== 0 || !result.stdout) {
      return fallback
    }

    const candidate = extractJsonCandidate(result.stdout)
    if (!candidate) {
      return fallback
    }

    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const agentType = parsed.agentType as string
    const complexity = parsed.complexity as string

    const validAgentTypes: AgentType[] = ['build', 'plan', 'info', 'debug', 'research', 'ask']
    const validComplexities: ComplexityLevel[] = ['simple', 'medium', 'complex']

    if (
      !validAgentTypes.includes(agentType as AgentType) ||
      !validComplexities.includes(complexity as ComplexityLevel)
    ) {
      return fallback
    }

    return { agentType: agentType as AgentType, complexity: complexity as ComplexityLevel }
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — dynamic model resolution
// ---------------------------------------------------------------------------

function getModelTierLevel(model: string, backend: LocalBackend): 0 | 1 | 2 {
  const tiers = MODEL_TIERS[backend]

  // Exact match first
  if (model === tiers.light) {
    return 0
  }
  if (model === tiers.medium) {
    return 1
  }
  if (model === tiers.heavy) {
    return 2
  }

  // Fuzzy match by model name patterns
  const lower = model.toLowerCase()
  if (backend === 'claude') {
    if (lower.includes('haiku')) {
      return 0
    }
    if (lower.includes('sonnet')) {
      return 1
    }
    if (lower.includes('opus')) {
      return 2
    }
  }
  if (backend === 'gemini') {
    if (lower.includes('flash')) {
      return 0
    }
    if (lower.includes('pro')) {
      return 2
    }
  }
  if (backend === 'codex') {
    if (lower === 'gpt-5-codex') {
      return 0
    }
    if (lower === 'gpt-5.3-codex') {
      return 2
    }
  }

  return 1 // default to medium
}

function resolveAgentModel(
  userModel: string,
  backend: LocalBackend,
  complexity: ComplexityLevel
): string {
  const complexityTierLevel: Record<ComplexityLevel, 0 | 1 | 2> = {
    simple: 0,
    medium: 1,
    complex: 2,
  }

  const tierNames: Record<0 | 1 | 2, ModelTier> = { 0: 'light', 1: 'medium', 2: 'heavy' }

  const userTierLevel = getModelTierLevel(userModel, backend)
  const targetTierLevel = complexityTierLevel[complexity]
  const resolvedLevel = Math.min(userTierLevel, targetTierLevel) as 0 | 1 | 2
  const resolvedTier = tierNames[resolvedLevel]

  return MODEL_TIERS[backend][resolvedTier] ?? userModel
}

// ---------------------------------------------------------------------------
// Tool definitions builder (per-agent)
// ---------------------------------------------------------------------------

function buildSubagentToolDefinitions(
  agentType: AgentType,
  integrationTools: unknown[] = []
): PromptToolDefinition[] {
  const config = SUBAGENT_CONFIGS[agentType]
  const tools: PromptToolDefinition[] = []
  const seen = new Set<string>()

  const addTool = (name: string, description: string, inputSchema: Record<string, unknown>) => {
    if (!name || seen.has(name)) {
      return
    }
    seen.add(name)
    tools.push({ name, description, inputSchema })
  }

  const allowAllDirect = config.allowedDirectTools.includes('*')
  for (const def of DIRECT_TOOL_DEFS) {
    if (allowAllDirect || config.allowedDirectTools.includes(def.name)) {
      addTool(
        def.name,
        def.description,
        toObject(def.inputSchema as unknown as Record<string, unknown>)
      )
    }
  }

  const allowAllServer = config.allowedServerTools.includes('*')
  for (const def of SERVER_TOOL_DEFINITIONS) {
    if (allowAllServer || config.allowedServerTools.includes(def.name)) {
      addTool(def.name, def.description, def.inputSchema)
    }
  }

  // Only the build agent receives integration tools
  if (agentType === 'build') {
    let integrationCount = 0
    for (const raw of integrationTools) {
      if (integrationCount >= MAX_INTEGRATION_TOOLS) {
        break
      }
      const t = toObject(raw)
      const name = typeof t.name === 'string' ? t.name : ''
      const description = typeof t.description === 'string' ? t.description : ''
      if (!name || !description) {
        continue
      }
      const schema = toObject(t.input_schema)
      addTool(name, description, schema)
      integrationCount++
    }
  }

  return tools
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSubagentPrompt(params: {
  agentType: AgentType
  workflowId?: string
  mode?: string
  tools: PromptToolDefinition[]
  messages: AgentLoopMessage[]
  backend?: LocalBackend
  model?: string
}): string {
  const { agentType, workflowId, mode, tools, messages, backend, model } = params
  const config = SUBAGENT_CONFIGS[agentType]

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

  const prompt = `${config.systemPrompt}

Running via ${backend ?? 'local'} CLI, model: ${model ?? 'unknown'}.

Context:
- Workflow ID: ${workflowId || 'unknown'}
- Mode: ${mode || 'build'}

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
  agentType?: AgentType
  workflowId?: string
  mode?: string
  messages: AgentLoopMessage[]
  backend?: LocalBackend
  model?: string
}): string {
  const { agentType, workflowId, mode, messages, backend, model } = params
  const transcript = messages
    .map((m) => {
      if (m.role === 'tool') {
        return `Tool(${m.name || 'unknown'} #${m.toolCallId || 'n/a'}):\n${m.content}`
      }
      return `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`
    })
    .join('\n\n')

  const agentContext = agentType ? ` (agent: ${agentType})` : ''
  const prompt = `You are Sim Copilot${agentContext} (running via ${backend ?? 'local'} CLI, model: ${model ?? 'unknown'}).

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

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

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

        const conversation = normalizeHistory(payload)
        const latestUserMessage =
          typeof payload.message === 'string' ? payload.message : conversation.at(-1)?.content ?? ''

        // Phase 1: Route the request to the appropriate agent
        const routing = await classifyRequest(
          latestUserMessage,
          conversation.slice(0, -1),
          backend
        )

        // Phase 2: Resolve the model (cap at user's tier)
        const agentModel = resolveAgentModel(selectedModel, backend, routing.complexity)

        // Emit routing decision for UI display
        writeSSE(controller, encoder, {
          type: 'agent_routing',
          data: {
            agentType: routing.agentType,
            complexity: routing.complexity,
            model: agentModel,
            selectedModel,
          },
        })

        logger.info('Agent routing decision', {
          agentType: routing.agentType,
          complexity: routing.complexity,
          selectedModel,
          agentModel,
          backend,
        })

        // Phase 3: Build agent-specific tool set
        const execContext = await prepareExecutionContext(userId, workflowId)
        const integrationTools = Array.isArray(payload.integrationTools)
          ? payload.integrationTools
          : []
        const toolDefs = buildSubagentToolDefinitions(routing.agentType, integrationTools)
        const mode = typeof payload.mode === 'string' ? payload.mode : undefined

        const agentConfig = SUBAGENT_CONFIGS[routing.agentType]

        // Phase 4: Subagent loop
        for (let iteration = 0; iteration < agentConfig.maxIterations; iteration++) {
          writeSSE(controller, encoder, { type: 'reasoning', phase: 'start' })
          const prompt = buildSubagentPrompt({
            agentType: routing.agentType,
            workflowId,
            mode,
            tools: toolDefs,
            messages: conversation,
            backend,
            model: agentModel,
          })

          const result = await runLocalBackend({
            backend,
            prompt,
            model: agentModel,
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
            const toolCallId =
              call.id || `tool_${iteration + 1}_${index + 1}_${crypto.randomUUID()}`
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
          agentType: routing.agentType,
          workflowId,
          mode,
          messages: conversation,
          backend,
          model: agentModel,
        })
        const final = await runLocalBackend({
          backend,
          prompt: summaryPrompt,
          model: agentModel,
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
