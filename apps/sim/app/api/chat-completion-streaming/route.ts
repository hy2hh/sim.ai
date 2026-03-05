import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@sim/logger'
import type { NextRequest } from 'next/server'
import { INTERRUPT_TOOL_SET } from '@/lib/copilot/orchestrator/config'
import { getLocalToolDecision } from '@/lib/copilot/orchestrator/local-tool-decisions'
import {
  executeToolServerSide,
  isToolAvailableOnSimSide,
  prepareExecutionContext,
} from '@/lib/copilot/orchestrator/tool-executor'
import { DIRECT_TOOL_DEFS } from '@/lib/copilot/tools/mcp/definitions'
import { env } from '@/lib/core/config/env'

export const runtime = 'nodejs'

const logger = createLogger('LocalAgentStreamingLocalCli')

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const MAX_PROMPT_CHARS = 120_000
const COMMAND_TIMEOUT_MS = 300_000
/** Shorter timeout for the lightweight router call */
const ROUTER_TIMEOUT_MS = 30_000
const MAX_CONVERSATION_MESSAGES = 40
const MAX_INTEGRATION_TOOLS = 120

const IMMEDIATE_BUILD_PHRASES = [
  'just build it',
  'build now',
  'build it now',
  'immediately build',
  '바로 빌드해줘',
  '지금 빌드해줘',
  '바로 만들어줘',
  '지금 바로 빌드',
  '지금 바로 만들어줘',
]

function isImmediateBuildRequested(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return IMMEDIATE_BUILD_PHRASES.some((phrase) => normalized.includes(phrase))
}

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
- Return a step-by-step plan: required blocks, configurations, connections, credentials needed
- When presenting your plan, wrap the numbered steps in <plan> tags with JSON:
  <plan>{"1":"Step description","2":"Step description",...}</plan>
  This enables the UI to render the plan as an interactive checklist.`,
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
    systemPrompt: `You are Sim Copilot, an expert workflow automation builder for the Sim platform.

Platform overview:
- Sim uses blocks + edges to build workflow automations
- Variable references use <BlockName.outputField> syntax (e.g., <Gmail.subject>)
- Blocks connect via edges to pass data between steps

## Workflow safety policy (match hosted Copilot behavior)
- In a new build request, your FIRST response should be planning + credential status review.
- Do NOT call edit_workflow in the first response unless the user explicitly asks to build immediately.
- Only apply edit_workflow after explicit user confirmation or an explicit immediate-build phrase.

## Build workflow

### Step 1: Understand & Plan
- Read the current workflow state to understand what already exists
- Call get_blocks_and_tools to discover available block types
- Call get_credentials to check which OAuth services and API keys the user has connected
- Create a clear plan with numbered To-dos showing what blocks you will build
- When presenting your plan, wrap the numbered steps in <plan> tags with JSON:
  <plan>{"1":"Step description","2":"Step description",...}</plan>
  This enables the UI to render the plan as an interactive checklist.

### Step 2: Inform the user
Present your plan clearly:
- List the blocks you will add and how they connect
- List which credentials are already connected (✓) and which are missing (✗)
- If credentials are missing, match hosted Copilot UX:
  - Show an integration summary section (service + intended usage)
  - Show a credential table with columns: service, status, purpose
  - Then offer choices wrapped in <options> XML tags with JSON:
    <options>{"1":{"title":"<PrimaryService> 연동하기"},"2":{"title":"모든 서비스 한번에 연동"},"3":{"title":"<PrimaryService>만 먼저 빌드"},"4":{"title":"워크플로우 구조 더 자세히 설명"}}</options>
  - ALWAYS use <options> tags for ANY set of choices or confirmations presented to the user.
  - When asking the user to confirm or start building, ALWAYS include options:
    <options>{"1":{"title":"바로 빌드 시작"},"2":{"title":"워크플로우 구조 더 자세히 설명"},"3":{"title":"도구 구성 변경 (추가/제거)"}}</options>
  - The "primary service" is the main trigger/channel service implied by the request (for Slack workflows, this is Slack)
  - Replace <PrimaryService> with the actual service name (e.g., Slack)

### Step 3: Build (REQUIRED TOOL CALLS)
After the user confirms (or if they ask to build immediately), you MUST:
1) Call get_workflow to inspect existing blocks and avoid duplicate block names
2) Call get_block_config for each target block type to get the exact field names
3) Call edit_workflow with the complete operations array — THIS IS MANDATORY TO ACTUALLY BUILD

⚠️ IMPORTANT:
- get_block_config can be used during planning, but edit_workflow must wait for user confirmation
- Do NOT claim the workflow is built until edit_workflow succeeds

edit_workflow OPERATIONS FORMAT:
Each operation MUST use these exact field names:
- "operation_type": one of "add", "edit", "delete", "insert_into_subflow", "extract_from_subflow"
- "block_id": a unique string ID (e.g., "slack-trigger-1", "agent-block-1")
- "params": object with:
  - "type": block type ID from get_blocks_and_tools
  - "name": human-readable block name
  - "inputs": input field values (use null for missing credentials)
  - "connections": output handle → target block ID map

Example shape (use real field names from get_block_config):
{"type":"tool_calls","calls":[{"id":"t1","name":"edit_workflow","arguments":{"workflowId":"<id>","operations":[{"operation_type":"add","block_id":"slack-trigger-1","params":{"type":"slack","name":"Slack Mention Trigger","triggerMode":true,"inputs":{"signingSecret":null},"connections":{"success":"agent-block-1"}}},{"operation_type":"add","block_id":"agent-block-1","params":{"type":"agent","name":"AI Agent","inputs":{"model":"claude-sonnet-4-6"},"connections":{"success":"slack-reply-1"}}},{"operation_type":"add","block_id":"slack-reply-1","params":{"type":"slack","name":"Slack Reply","inputs":{"operation":"send","text":"<agent-block-1.content>","channel":"<slack-trigger-1.event.channel>","threadTs":"<slack-trigger-1.event.timestamp>"}}}]}}]}

## Important rules
- For optional/secondary integrations, credential fields can be null placeholders.
- For primary OAuth-gated integrations on the main path (especially trigger/reply services like Slack), do NOT build those blocks before auth is connected.
- If a required primary OAuth credential is missing, call oauth_get_auth_link and guide the user to connect first, then continue building.
- For Slack mention/webhook triggers, NEVER use block type "slack_trigger". Use type "slack" with "triggerMode": true.
- For Slack replies/actions, use type "slack" with an explicit operation in inputs (usually "operation":"send").
- After get_workflow, if equivalent blocks already exist, use "edit" on existing block IDs instead of adding duplicate names.
- In edit_workflow connections, every target block_id must already exist in workflow state or be added in the same operations list.
- If the user selects option 1 (connect primary service first) and the primary OAuth is missing:
  - Do NOT call get_block_config or edit_workflow yet.
  - Prefer a direct connection guide response; optionally call oauth_get_auth_link for the primary service only.
  - End with follow-up options using <options> tags:
    <options>{"1":{"title":"<PrimaryService> 연결 완료"},"2":{"title":"연결 방법 더 자세히"}}</options>
- If the user selects option 2 (connect all services now):
  - Do NOT call get_block_config or edit_workflow yet.
  - Do NOT return refusal text (e.g., "can't continue").
  - Provide a per-service connection checklist for all missing required integrations.
  - You may call oauth_get_auth_link for missing OAuth integrations and include available links.
  - End with:
    <options>{"1":{"title":"모든 서비스 연결 완료"},"2":{"title":"<PrimaryService>부터 먼저 연결"},"3":{"title":"연결 방법 더 자세히"}}</options>
- If the user selects option 3 (primary-only build) while the primary OAuth credential is still missing, do NOT call get_block_config or edit_workflow yet.
- In that case, first guide connection and present follow-up options:
    <options>{"1":{"title":"<PrimaryService> 연결 완료"},"2":{"title":"연결 방법 더 자세히"}}</options>
- If the user selects option 4 (explain detailed structure):
  - Explain the workflow structure in more depth (trigger fields, agent/tool routing, response mapping, error/fallback strategy, context optimization).
  - Do NOT call get_block_config or edit_workflow yet.
  - Re-offer the same next-step choices:
    <options>{"1":{"title":"<PrimaryService> 연동하기"},"2":{"title":"모든 서비스 한번에 연동"},"3":{"title":"<PrimaryService>만 먼저 빌드"},"4":{"title":"워크플로우 구조 더 자세히 설명"}}</options>
- For quick-reply numeric selections (1/2/3/4), avoid unnecessary tool calls. For 1/2/4, prefer direct assistant guidance using already-known credential status.
- Only proceed to Step 3 after the user confirms choice 1 (connected).
- If the user explicitly says "just build it", "build now", "바로 빌드해줘", "지금 빌드해줘", "바로 만들어줘", "지금 바로 빌드", or similar "build immediately" phrases, skip to Step 3 immediately without checking credentials
- After edit_workflow succeeds, THEN output assistant text confirming what was created
- If edit_workflow already created the requested structure, stop tool calls and return the final response`,
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
    description:
      'Apply operations to the workflow. Each operation: {operation_type:"add"|"edit"|"delete", block_id:"string", params:{type,name,inputs,connections}}.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['operation_type', 'block_id'],
            properties: {
              operation_type: {
                type: 'string',
                enum: ['add', 'edit', 'delete', 'insert_into_subflow', 'extract_from_subflow'],
              },
              block_id: { type: 'string' },
              params: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: 'Block type ID from get_blocks_and_tools' },
                  name: { type: 'string', description: 'Human-readable block name' },
                  inputs: { type: 'object', description: 'Block input field values' },
                  connections: {
                    type: 'object',
                    description: 'Output handle to target block_id map',
                  },
                },
              },
            },
          },
        },
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
    name: 'oauth_get_auth_link',
    description:
      'Get the URL for the user to connect an OAuth service (e.g. Slack, GitHub, Jira). Returns a link the user must open to authorize the connection.',
    inputSchema: {
      type: 'object',
      properties: {
        providerName: {
          type: 'string',
          description: 'Name of the OAuth provider to connect (e.g. "Slack", "GitHub", "Jira")',
        },
      },
      required: ['providerName'],
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
  timeoutMs = COMMAND_TIMEOUT_MS,
  onStderrChunk?: (chunk: string) => void
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
      setTimeout(() => {
        child.kill('SIGKILL')
      }, 3000)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      onStderrChunk?.(text)
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

/**
 * Strips ANSI escape codes from a string
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

/**
 * Runs Claude CLI with --output-format stream-json to capture thinking events in real-time.
 * Parses JSONL stdout for thinking_delta and text_delta events.
 */
async function runClaudeCodeStreaming(
  prompt: string,
  model: string,
  onThinking: (chunk: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS,
  effort: 'low' | 'medium' | 'high' = 'low'
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--model',
    toClaudeCliModel(model),
    '--tools',
    '',
    '--effort',
    effort,
  ]

  return new Promise((resolve, reject) => {
    const { CLAUDECODE: _, ...envWithoutClaudeCode } = process.env
    const child = spawn('claude', args, {
      env: envWithoutClaudeCode,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    let finalText = ''
    let lineBuffer = ''

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
      }, 3000)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer | string) => {
      lineBuffer += chunk.toString()
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        try {
          const event = JSON.parse(line)
          if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
              onThinking(event.delta.thinking)
            }
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              finalText += event.delta.text
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            finalText = event.result
          }
        } catch {
          // Not valid JSON line, accumulate as raw text fallback
          finalText += line
        }
      }
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
      // Process remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer)
          if (event.type === 'result' && typeof event.result === 'string') {
            finalText = event.result
          }
        } catch {
          finalText += lineBuffer
        }
      }
      resolve({ exitCode: exitCode ?? 1, stderr, stdout: finalText.trim() })
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

const SLACK_TRIGGER_TYPE_ALIASES = new Set([
  'slack_trigger',
  'slack_mention_trigger',
  'slack_webhook_trigger',
])

const SLACK_REPLY_TYPE_ALIASES = new Set(['slack_reply', 'slack_send', 'slack_send_message'])

function normalizeBlockNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function extractExistingBlockNameMap(conversation: AgentLoopMessage[]): Map<string, string> {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i]
    if (message.role !== 'tool' || message.name !== 'get_workflow') {
      continue
    }

    const parsed = tryParseJsonCandidate(message.content)
    if (!parsed) {
      continue
    }

    const result = toObject(parsed.result)
    const userWorkflowRaw = result.userWorkflow
    if (typeof userWorkflowRaw !== 'string' || !userWorkflowRaw.trim()) {
      continue
    }

    try {
      const userWorkflowParsed = JSON.parse(userWorkflowRaw) as Record<string, unknown>
      const blocks = toObject(userWorkflowParsed.blocks)
      const map = new Map<string, string>()
      for (const [blockId, blockRaw] of Object.entries(blocks)) {
        const block = toObject(blockRaw)
        const name = typeof block.name === 'string' ? block.name : ''
        if (!name.trim()) {
          continue
        }
        map.set(normalizeBlockNameKey(name), blockId)
      }
      return map
    } catch {}
  }

  return new Map<string, string>()
}

function remapConnectionValue(value: unknown, blockIdRemap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return blockIdRemap.get(value) ?? value
  }

  if (Array.isArray(value)) {
    return value.map((item) => remapConnectionValue(item, blockIdRemap))
  }

  if (typeof value === 'object' && value !== null) {
    const obj = toObject(value)
    if (typeof obj.block === 'string') {
      return {
        ...obj,
        block: blockIdRemap.get(obj.block) ?? obj.block,
      }
    }

    const remappedObject: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(obj)) {
      remappedObject[key] = remapConnectionValue(nestedValue, blockIdRemap)
    }
    return remappedObject
  }

  return value
}

function normalizeEditWorkflowOperation(
  operation: Record<string, unknown>
): Record<string, unknown> {
  const normalizedOp = { ...operation }
  const params = toObject(operation.params)
  if (Object.keys(params).length === 0) {
    return normalizedOp
  }

  const normalizedParams: Record<string, unknown> = { ...params }
  const rawType = typeof params.type === 'string' ? params.type.trim().toLowerCase() : ''

  if (SLACK_TRIGGER_TYPE_ALIASES.has(rawType)) {
    normalizedParams.type = 'slack'
    normalizedParams.triggerMode = true
  } else if (SLACK_REPLY_TYPE_ALIASES.has(rawType)) {
    normalizedParams.type = 'slack'
  }

  if (
    typeof normalizedParams.type === 'string' &&
    normalizedParams.type.toLowerCase() === 'slack'
  ) {
    const isTrigger =
      normalizedParams.triggerMode === true || SLACK_TRIGGER_TYPE_ALIASES.has(rawType)
    const inputs = toObject(normalizedParams.inputs)
    const normalizedInputs: Record<string, unknown> = { ...inputs }

    if ('thread_ts' in normalizedInputs && !('threadTs' in normalizedInputs)) {
      normalizedInputs.threadTs = normalizedInputs.thread_ts
      normalizedInputs.thread_ts = undefined
    }

    if (isTrigger) {
      normalizedParams.triggerMode = true
      normalizedParams.inputs = normalizedInputs
    } else {
      if (typeof normalizedInputs.operation !== 'string' || !normalizedInputs.operation.trim()) {
        normalizedInputs.operation = 'send'
      }
      normalizedParams.inputs = normalizedInputs
    }
  }

  if (typeof normalizedParams.name === 'string') {
    normalizedParams.name = normalizedParams.name.trim()
  }

  normalizedOp.params = normalizedParams
  return normalizedOp
}

function normalizeToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  workflowId: string,
  conversation: AgentLoopMessage[]
): Record<string, unknown> {
  if (toolName !== 'edit_workflow') {
    return args
  }

  const normalizedArgs: Record<string, unknown> = { ...args }
  if (typeof normalizedArgs.workflowId !== 'string' || !normalizedArgs.workflowId.trim()) {
    normalizedArgs.workflowId = workflowId
  }

  const operations = Array.isArray(args.operations) ? args.operations : null
  if (!operations) {
    return normalizedArgs
  }

  let normalizedOperations = operations.map((op) => normalizeEditWorkflowOperation(toObject(op)))

  const existingBlockNameMap = extractExistingBlockNameMap(conversation)
  if (existingBlockNameMap.size > 0) {
    const blockIdRemap = new Map<string, string>()

    normalizedOperations = normalizedOperations.map((rawOperation) => {
      const operation = toObject(rawOperation)
      const operationType =
        typeof operation.operation_type === 'string' ? operation.operation_type : ''
      const blockId = typeof operation.block_id === 'string' ? operation.block_id : ''
      const params = toObject(operation.params)
      const blockName = typeof params.name === 'string' ? params.name : ''

      if (operationType !== 'add' || !blockId || !blockName.trim()) {
        return operation
      }

      const existingId = existingBlockNameMap.get(normalizeBlockNameKey(blockName))
      if (!existingId) {
        return operation
      }

      blockIdRemap.set(blockId, existingId)
      const convertedParams: Record<string, unknown> = { ...params }
      convertedParams.type = undefined

      return {
        ...operation,
        operation_type: 'edit',
        block_id: existingId,
        params: convertedParams,
      }
    })

    if (blockIdRemap.size > 0) {
      normalizedOperations = normalizedOperations.map((rawOperation) => {
        const operation = toObject(rawOperation)
        const currentBlockId = typeof operation.block_id === 'string' ? operation.block_id : ''
        const params = toObject(operation.params)
        const connections = toObject(params.connections)

        const remappedOperation: Record<string, unknown> = {
          ...operation,
          ...(currentBlockId
            ? { block_id: blockIdRemap.get(currentBlockId) ?? currentBlockId }
            : {}),
        }

        if (Object.keys(connections).length > 0) {
          remappedOperation.params = {
            ...params,
            connections: remapConnectionValue(connections, blockIdRemap),
          }
        }

        return remappedOperation
      })
    }
  }

  normalizedArgs.operations = normalizedOperations
  return normalizedArgs
}

/** Extract the first complete JSON object or array using bracket counting. */
function extractFirstCompleteJson(raw: string, startIdx = 0): string | null {
  let depth = 0
  let start = -1
  let openChar: string | null = null
  let closeChar: string | null = null
  let inString = false
  let escaped = false

  for (let i = startIdx; i < raw.length; i++) {
    const c = raw[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && inString) {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) {
      continue
    }

    if ((c === '{' || c === '[') && depth === 0) {
      start = i
      openChar = c
      closeChar = c === '{' ? '}' : ']'
      depth = 1
    } else if (depth > 0) {
      if (c === openChar) {
        depth++
      } else if (c === closeChar) {
        depth--
        if (depth === 0) {
          return raw.slice(start, i + 1)
        }
      }
    }
  }

  return null
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  return extractFirstCompleteJson(trimmed)
}

function tryParseJsonCandidate(candidate: string): Record<string, unknown> | null {
  // Attempt 1: standard parse
  try {
    return JSON.parse(candidate) as Record<string, unknown>
  } catch {}

  // Attempt 2: normalize literal newlines/tabs inside JSON string values
  // (models sometimes emit pretty-printed JSON with literal newlines in content)
  try {
    const normalized = candidate.replace(/"((?:[^"\\]|\\.)*)"/gs, (_match, inner: string) => {
      const fixed = inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
      return `"${fixed}"`
    })
    return JSON.parse(normalized) as Record<string, unknown>
  } catch {}

  return null
}

function tryParseDecisionJson(candidate: string): AgentDecision | null {
  const parsed = tryParseJsonCandidate(candidate)
  if (!parsed) {
    return null
  }

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

  return null
}

function parseAgentDecision(raw: string): AgentDecision {
  const trimmed = raw.trim()

  // Check for fenced code blocks first
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    const result = tryParseDecisionJson(fencedMatch[1].trim())
    if (result) {
      return result
    }
  }

  // Look for the LAST occurrence of expected type fields.
  // The model sometimes outputs context/analysis JSON before the actual decision JSON,
  // so we scan backward to find the most recent matching JSON.
  const typePatterns = [
    '"type":"tool_calls"',
    '"type": "tool_calls"',
    '"type":"assistant"',
    '"type": "assistant"',
  ]
  let lastTypeIdx = -1
  for (const pattern of typePatterns) {
    const idx = trimmed.lastIndexOf(pattern)
    if (idx > lastTypeIdx) {
      lastTypeIdx = idx
    }
  }

  if (lastTypeIdx > 0) {
    const braceIdx = trimmed.lastIndexOf('{', lastTypeIdx)
    if (braceIdx >= 0) {
      const candidate = extractFirstCompleteJson(trimmed, braceIdx)
      if (candidate) {
        const result = tryParseDecisionJson(candidate)
        if (result) {
          return result
        }
      }
    }
  }

  // Fallback: scan all JSON objects in order and return the first valid decision
  let searchIdx = 0
  while (searchIdx < trimmed.length) {
    const candidate = extractFirstCompleteJson(trimmed, searchIdx)
    if (!candidate) {
      break
    }

    const result = tryParseDecisionJson(candidate)
    if (result) {
      return result
    }

    const foundAt = trimmed.indexOf(candidate, searchIdx)
    searchIdx = foundAt < 0 ? trimmed.length : foundAt + candidate.length
  }

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
// Interrupt tool decision polling (in-memory, no Redis needed)
// ---------------------------------------------------------------------------

const CLIENT_RUN_TOOLS = new Set([
  'run_workflow',
  'run_workflow_until_block',
  'run_from_block',
  'run_block',
])

async function waitForLocalToolDecision(
  toolCallId: string,
  timeoutMs: number,
  /** If true, ignore 'accepted' and wait for 'success'/'error' (client-run tools) */
  waitForCompletion = false
): Promise<{ status: string; message?: string } | null> {
  const start = Date.now()
  let interval = 100

  while (Date.now() - start < timeoutMs) {
    const decision = getLocalToolDecision(toolCallId)
    if (decision) {
      if (waitForCompletion) {
        if (
          decision.status === 'success' ||
          decision.status === 'error' ||
          decision.status === 'rejected'
        ) {
          return decision
        }
      } else {
        return decision
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval))
    if (interval < 3000) {
      interval = Math.min(interval * 2, 3000)
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// CLI runners
// ---------------------------------------------------------------------------

async function runClaudeCode(
  prompt: string,
  model: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  effort: 'low' | 'medium' | 'high' = 'low'
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'text',
    '--model',
    toClaudeCliModel(model),
    '--tools',
    '',
    '--effort',
    effort,
  ]
  return runCommandWithTimeout('claude', args, timeoutMs)
}

async function runGeminiCli(
  prompt: string,
  model: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
  onStderrChunk?: (chunk: string) => void
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
      const result = await runCommandWithTimeout('gemini', args, timeoutMs, onStderrChunk)
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
  timeoutMs = COMMAND_TIMEOUT_MS,
  onStderrChunk?: (chunk: string) => void
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
      '-c',
      'model_reasoning_effort="high"',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--color',
      'never',
      '--output-last-message',
      outputPath,
    ]

    const result = await runCommandWithTimeout('codex', args, timeoutMs, onStderrChunk)
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
  effort?: 'low' | 'medium' | 'high'
  onThinking?: (chunk: string) => void
}): Promise<{ exitCode: number; stderr: string; stdout: string; backend: LocalBackend }> {
  const { backend, prompt, model, timeoutMs, effort, onThinking } = params

  if (backend === 'gemini') {
    const stderrFilter = onThinking
      ? (chunk: string) => {
          const clean = stripAnsi(chunk).trim()
          if (clean) {
            onThinking(clean)
          }
        }
      : undefined
    const result = await runGeminiCli(prompt, model, timeoutMs, stderrFilter)
    return { ...result, backend }
  }
  if (backend === 'codex') {
    const stderrFilter = onThinking
      ? (chunk: string) => {
          const clean = stripAnsi(chunk).trim()
          if (clean) {
            onThinking(clean)
          }
        }
      : undefined
    const result = await runCodexCli(prompt, model, timeoutMs, stderrFilter)
    return { ...result, backend }
  }

  if (onThinking) {
    const result = await runClaudeCodeStreaming(prompt, model, onThinking, timeoutMs, effort ?? 'low')
    return { ...result, backend: 'claude' }
  }

  const result = await runClaudeCode(prompt, model, timeoutMs, effort ?? 'low')
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
  if (isImmediateBuildRequested(message)) {
    return { agentType: 'build', complexity: 'complex' }
  }
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
  const latestUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const immediateBuildMode = agentType === 'build' && isImmediateBuildRequested(latestUserMessage)

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
- Immediate build mode: ${immediateBuildMode ? 'ON' : 'OFF'}

Available tools (JSON):
${safeStringify(compactTools)}

Conversation:
${transcript}

Decide the next step and output a SINGLE LINE of JSON only. No markdown, no code fences, no extra text.

When you need tools: {"type":"tool_calls","calls":[{"id":"t1","name":"tool_name","arguments":{"key":"value"}}]}
When done: {"type":"assistant","content":"your response here"}

Rules:
- Output JSON on ONE LINE only. Never use literal newlines inside JSON strings — use \\n instead.
- Never call a tool not listed in available tools.
- Keep arguments as a JSON object.
- Prefer tool calls over guessing when workflow state is uncertain.
- For BUILD tasks: default to planning + credential audit first. Use edit_workflow only after explicit user confirmation or explicit immediate-build phrasing.
- Assistant content without edit_workflow is valid during planning and credential-check phases.
- After successful edit_workflow that satisfies the request, return assistant response immediately and avoid extra tool loops.
- If Immediate build mode is ON:
  - Your FIRST response MUST be {"type":"tool_calls",...}; do not return assistant text first.
  - In that first tool-call response, include edit_workflow before any assistant-only response.
  - Query current workflow state first and prefer editing existing block IDs over adding duplicate block names.
  - Do not emit connections to non-existent target block IDs.
  - Do not stop at planning/credential audit. Proceed directly to real build actions.`

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
          typeof payload.message === 'string'
            ? payload.message
            : (conversation.at(-1)?.content ?? '')

        // Phase 1: Route the request to the appropriate agent
        const routing = await classifyRequest(latestUserMessage, conversation.slice(0, -1), backend)

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
        // Unique prefix per request to prevent dedup collisions across HTTP requests.
        // The CLI reuses sequential IDs (t1, t2, …) across iterations AND requests.
        const requestPrefix = crypto.randomUUID().slice(0, 8)

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
            onThinking: (chunk) => {
              writeSSE(controller, encoder, { type: 'reasoning', data: chunk })
            },
          })

          if (result.exitCode !== 0) {
            // If stdout has a valid JSON response, treat it as success despite non-zero exit code.
            // Claude CLI sometimes exits with code 1 due to permission prompts or minor issues
            // but still produces valid output.
            const hasValidOutput = result.stdout && !!extractJsonCandidate(result.stdout)
            if (!hasValidOutput) {
              const detail = result.stderr.trim() || result.stdout.trim()
              const errMsg = detail
                ? `[${result.backend}] ${detail.slice(0, 300)}`
                : `${result.backend} command failed with code ${result.exitCode}`
              writeSSE(controller, encoder, { type: 'reasoning', data: errMsg })
              writeSSE(controller, encoder, { type: 'reasoning', phase: 'end' })
              logger.error('Local model command returned non-zero status', {
                backend: result.backend,
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout.slice(0, 500),
              })
              writeSSE(controller, encoder, { type: 'error', data: { message: errMsg } })
              return
            }
            logger.warn('Local model exited with non-zero code but has valid stdout, continuing', {
              backend: result.backend,
              exitCode: result.exitCode,
            })
          }

          const decision = parseAgentDecision(result.stdout)

          if (decision.type === 'assistant' && result.stdout.includes('"type":"tool_calls"')) {
            logger.warn('parseAgentDecision fell back to assistant despite tool_calls in stdout', {
              stdoutPreview: result.stdout.slice(0, 400),
              iteration,
            })
          }

          // End the thinking block without internal debug text
          writeSSE(controller, encoder, { type: 'reasoning', phase: 'end' })

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
            // Always generate a unique ID to prevent dedup collisions.
            // The Claude CLI reuses sequential IDs (t1, t2, ...) across iterations AND requests,
            // which would be incorrectly filtered by the module-level seenToolCalls Set.
            const toolCallId = `${requestPrefix}_${iteration + 1}_${index + 1}_${call.id || crypto.randomUUID()}`
            const originalName = call.name
            const mappedName = DIRECT_TOOL_NAME_TO_ID[originalName] ?? originalName
            const rawArgs = toObject(call.arguments)
            const args = normalizeToolArguments(mappedName, rawArgs, workflowId, conversation)

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

            // Phase 2: Interrupt tool approval flow
            if (INTERRUPT_TOOL_SET.has(mappedName)) {
              const decision = await waitForLocalToolDecision(toolCallId, COMMAND_TIMEOUT_MS)

              if (!decision || decision.status === 'rejected') {
                const skipMsg = decision?.message || 'Tool execution was skipped by user.'
                writeSSE(controller, encoder, {
                  type: 'tool_result',
                  data: { id: toolCallId, name: originalName, success: false, error: skipMsg },
                })
                conversation.push({
                  role: 'tool',
                  name: originalName,
                  toolCallId,
                  content: safeStringify({ success: false, error: skipMsg }),
                })
                continue
              }

              if (decision.status === 'background') {
                const bgMsg = decision.message || 'Tool moved to background by user.'
                writeSSE(controller, encoder, {
                  type: 'tool_result',
                  data: { id: toolCallId, name: originalName, success: true, result: bgMsg },
                })
                conversation.push({
                  role: 'tool',
                  name: originalName,
                  toolCallId,
                  content: safeStringify({ success: true, result: bgMsg }),
                })
                continue
              }

              // Phase 3: Client-run tools wait for client-side completion
              if (CLIENT_RUN_TOOLS.has(mappedName)) {
                const completion = await waitForLocalToolDecision(
                  toolCallId,
                  COMMAND_TIMEOUT_MS,
                  true
                )
                const isSuccess = completion?.status === 'success'
                const resultMsg =
                  completion?.message ||
                  (isSuccess
                    ? 'Workflow executed successfully.'
                    : 'Workflow execution failed or timed out.')
                writeSSE(controller, encoder, {
                  type: 'tool_result',
                  data: {
                    id: toolCallId,
                    name: originalName,
                    success: isSuccess,
                    ...(isSuccess ? { result: resultMsg } : { error: resultMsg }),
                  },
                })
                conversation.push({
                  role: 'tool',
                  name: originalName,
                  toolCallId,
                  content: safeStringify({
                    success: isSuccess,
                    ...(isSuccess ? { result: resultMsg } : { error: resultMsg }),
                  }),
                })
                continue
              }

              // 'accepted' for non-client-run tools → fall through to server execution
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
