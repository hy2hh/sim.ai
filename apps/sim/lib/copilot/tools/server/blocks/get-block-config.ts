import { createLogger } from '@sim/logger'
import type { BaseServerTool } from '@/lib/copilot/tools/server/base-tool'
import {
  GetBlockConfigInput,
  type GetBlockConfigInputType,
  GetBlockConfigResult,
  type GetBlockConfigResultType,
} from '@/lib/copilot/tools/shared/schemas'
import { getAllowedIntegrationsFromEnv } from '@/lib/core/config/feature-flags'
import { registry as blockRegistry, getLatestBlock } from '@/blocks/registry'
import { isHiddenFromDisplay, type SubBlockConfig } from '@/blocks/types'
import { getUserPermissionConfig } from '@/ee/access-control/utils/permission-check'
import { PROVIDER_DEFINITIONS } from '@/providers/models'
import { tools as toolsRegistry } from '@/tools/registry'
import { getTrigger, isTriggerValid } from '@/triggers'

interface InputFieldSchema {
  type: string
  description?: string
  placeholder?: string
  required?: boolean
  options?: string[]
  default?: any
  min?: number
  max?: number
}

/**
 * Gets all available models from PROVIDER_DEFINITIONS as static options.
 * This provides fallback data when store state is not available server-side.
 */
function getStaticModelOptions(): string[] {
  const models: string[] = []

  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    // Skip providers with dynamic/fetched models
    if (provider.id === 'ollama' || provider.id === 'vllm' || provider.id === 'openrouter') {
      continue
    }
    if (provider?.models) {
      for (const model of provider.models) {
        models.push(model.id)
      }
    }
  }

  return models
}

/**
 * Attempts to call a dynamic options function with fallback data injected.
 */
function callOptionsWithFallback(optionsFn: () => any[]): any[] | undefined {
  const staticModels = getStaticModelOptions()

  const mockProvidersState = {
    providers: {
      base: { models: staticModels },
      ollama: { models: [] },
      vllm: { models: [] },
      openrouter: { models: [] },
    },
  }

  let originalGetState: (() => any) | undefined
  let store: any

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    store = require('@/stores/providers')
    if (store?.useProvidersStore?.getState) {
      originalGetState = store.useProvidersStore.getState
      store.useProvidersStore.getState = () => mockProvidersState
    }
  } catch {
    // Store module not available
  }

  try {
    return optionsFn()
  } finally {
    if (store?.useProvidersStore && originalGetState) {
      store.useProvidersStore.getState = originalGetState
    }
  }
}

/**
 * Resolves options from a subBlock, handling both static arrays and dynamic functions
 */
function resolveSubBlockOptions(sb: SubBlockConfig): string[] | undefined {
  // Skip if subblock uses fetchOptions (async network calls)
  if (sb.fetchOptions) {
    return undefined
  }

  let rawOptions: any[] | undefined

  try {
    if (typeof sb.options === 'function') {
      rawOptions = callOptionsWithFallback(sb.options)
    } else {
      rawOptions = sb.options
    }
  } catch {
    return undefined
  }

  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    return undefined
  }

  // Return the actual option ID/value that edit_workflow expects, not the display label
  return rawOptions
    .map((opt: any) => {
      if (!opt) return undefined
      if (typeof opt === 'object') {
        return opt.id || opt.label // Prefer id (actual value) over label (display name)
      }
      return String(opt)
    })
    .filter((o): o is string => o !== undefined)
}

interface OutputFieldSchema {
  type: string
  description?: string
  properties?: Record<string, OutputFieldSchema>
  items?: { type: string }
}

interface NormalizedGetBlockConfigArgs {
  blockType: string
  operation?: string
  trigger?: boolean
}

function normalizeTriggerMode(trigger: unknown): boolean | undefined {
  if (typeof trigger === 'boolean') return trigger
  if (typeof trigger === 'string') {
    const normalized = trigger.trim().toLowerCase()
    if (!normalized) return undefined
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
    return true
  }
  return undefined
}

function normalizeOperationAlias(
  blockType: string,
  operation: string | undefined,
  validOperations?: string[]
): string | undefined {
  if (!operation) return undefined
  const normalized = operation.trim().toLowerCase()
  if (!normalized) return undefined

  // Common aliases used by models when planning Slack workflows
  if (blockType === 'slack') {
    const slackAliasMap: Record<string, string> = {
      send_message: 'send',
      send_reply: 'send',
      reply: 'send',
      send_thread_reply: 'send',
      post_message: 'send',
      read_messages: 'read',
      read_message: 'read',
      list_messages: 'read',
      update_message: 'update',
      delete_message: 'delete',
      add_reaction: 'react',
      get_messages: 'read',
    }
    const mapped = slackAliasMap[normalized] ?? normalized
    if (validOperations?.length) {
      if (validOperations.includes(mapped)) return mapped
      // Fuzzy fallback for unknown aliases
      if (mapped.includes('send') && validOperations.includes('send')) return 'send'
      if (mapped.includes('read') && validOperations.includes('read')) return 'read'
      if (mapped.includes('update') && validOperations.includes('update')) return 'update'
      if (mapped.includes('delete') && validOperations.includes('delete')) return 'delete'
      if (mapped.includes('react') && validOperations.includes('react')) return 'react'
      return undefined
    }
    return mapped
  }

  if (validOperations?.length) {
    if (validOperations.includes(normalized)) return normalized
    return undefined
  }
  return normalized
}

function normalizeGetBlockConfigArgs(
  blockType: string,
  operation: string | undefined,
  trigger: unknown
): NormalizedGetBlockConfigArgs {
  const raw = blockType.trim().toLowerCase()
  let normalizedBlockType = raw
  let normalizedTrigger = normalizeTriggerMode(trigger)
  let normalizedOperation = operation

  // Block-type aliases commonly generated by LLMs for Slack workflows
  const blockAliases: Record<string, { blockType: string; trigger?: boolean; operation?: string }> =
    {
      slack_trigger: { blockType: 'slack', trigger: true },
      slack_mention_trigger: { blockType: 'slack', trigger: true },
      slack_webhook_trigger: { blockType: 'slack', trigger: true },
      slack_reply: { blockType: 'slack', operation: 'send' },
      slack_send: { blockType: 'slack', operation: 'send' },
      slack_send_message: { blockType: 'slack', operation: 'send' },
      ai_agent: { blockType: 'agent' },
      llm_agent: { blockType: 'agent' },
    }

  const alias = blockAliases[raw]
  if (alias) {
    normalizedBlockType = alias.blockType
    if (alias.trigger !== undefined && normalizedTrigger === undefined) {
      normalizedTrigger = alias.trigger
    }
    if (alias.operation && !normalizedOperation) {
      normalizedOperation = alias.operation
    }
  }

  // If a model asks for "*_trigger" config, treat as trigger mode of base block where possible.
  if (normalizedBlockType.endsWith('_trigger')) {
    normalizedBlockType = normalizedBlockType.replace(/_trigger$/, '')
    if (normalizedTrigger === undefined) normalizedTrigger = true
  }

  return {
    blockType: normalizedBlockType,
    operation: normalizedOperation,
    trigger: normalizedTrigger,
  }
}

/**
 * Resolves the condition to check if it matches the given operation
 */
function matchesOperation(condition: any, operation: string): boolean {
  if (!condition) return false

  const cond = typeof condition === 'function' ? condition({ operation }) : condition
  if (!cond) return false

  if (cond.field === 'operation') {
    const values = Array.isArray(cond.value) ? cond.value : [cond.value]
    const included = values.includes(operation)
    return cond.not ? !included : included
  }

  return false
}

/**
 * Extracts input schema from subBlocks
 */
function extractInputsFromSubBlocks(
  subBlocks: SubBlockConfig[],
  operation?: string,
  triggerMode?: boolean
): Record<string, InputFieldSchema> {
  const inputs: Record<string, InputFieldSchema> = {}

  for (const sb of subBlocks) {
    // Handle trigger vs non-trigger mode filtering
    if (triggerMode) {
      // In trigger mode, only include subBlocks with mode: 'trigger'
      if (sb.mode !== 'trigger') continue
    } else {
      // In non-trigger mode, skip trigger-mode subBlocks
      if (sb.mode === 'trigger') continue
    }

    // Skip hidden subBlocks
    if (sb.hidden) continue

    // If operation is specified, only include subBlocks that:
    // 1. Have no condition (common parameters)
    // 2. Have a condition matching the operation
    if (operation) {
      const condition =
        typeof sb.condition === 'function' ? sb.condition({ operation }) : sb.condition
      if (condition && !matchesOperation(condition, operation)) {
        continue
      }
    }

    const field: InputFieldSchema = {
      type: mapSubBlockTypeToSchemaType(sb.type),
    }

    if (sb.description) field.description = sb.description
    if (sb.title && !sb.description) field.description = sb.title
    if (sb.placeholder) field.placeholder = sb.placeholder

    // Handle required
    if (typeof sb.required === 'boolean') {
      field.required = sb.required
    } else if (typeof sb.required === 'object') {
      field.required = true // Has conditional requirement
    }

    // Handle options using the resolver that handles dynamic model lists
    const resolvedOptions = resolveSubBlockOptions(sb)
    if (resolvedOptions && resolvedOptions.length > 0) {
      field.options = resolvedOptions
    }

    // Handle default value
    if (sb.defaultValue !== undefined) {
      field.default = sb.defaultValue
    }

    // Handle numeric constraints
    if (sb.min !== undefined) field.min = sb.min
    if (sb.max !== undefined) field.max = sb.max

    inputs[sb.id] = field
  }

  return inputs
}

/**
 * Maps subBlock type to a simplified schema type
 */
function mapSubBlockTypeToSchemaType(type: string): string {
  const typeMap: Record<string, string> = {
    'short-input': 'string',
    'long-input': 'string',
    code: 'string',
    dropdown: 'string',
    combobox: 'string',
    slider: 'number',
    switch: 'boolean',
    'tool-input': 'json',
    'checkbox-list': 'array',
    'grouped-checkbox-list': 'array',
    'condition-input': 'json',
    'eval-input': 'json',
    'time-input': 'string',
    'oauth-input': 'credential',
    'file-selector': 'string',
    'project-selector': 'string',
    'channel-selector': 'string',
    'user-selector': 'string',
    'folder-selector': 'string',
    'knowledge-base-selector': 'string',
    'document-selector': 'string',
    'mcp-server-selector': 'string',
    'mcp-tool-selector': 'string',
    table: 'json',
    'file-upload': 'file',
    'messages-input': 'array',
  }

  return typeMap[type] || 'string'
}

/**
 * Extracts a single output field schema, including nested properties
 */
function extractOutputField(def: any): OutputFieldSchema {
  if (typeof def === 'string') {
    return { type: def }
  }

  if (typeof def !== 'object' || def === null) {
    return { type: 'any' }
  }

  const field: OutputFieldSchema = {
    type: def.type || 'any',
  }

  if (def.description) {
    field.description = def.description
  }

  // Include nested properties if present
  if (def.properties && typeof def.properties === 'object') {
    field.properties = {}
    for (const [propKey, propDef] of Object.entries(def.properties)) {
      field.properties[propKey] = extractOutputField(propDef)
    }
  }

  // Include items schema for arrays
  if (def.items && typeof def.items === 'object') {
    field.items = { type: def.items.type || 'any' }
  }

  return field
}

/**
 * Extracts trigger outputs from the first available trigger
 */
function extractTriggerOutputs(blockConfig: any): Record<string, OutputFieldSchema> {
  const outputs: Record<string, OutputFieldSchema> = {}

  if (!blockConfig.triggers?.enabled || !blockConfig.triggers?.available?.length) {
    return outputs
  }

  // Get the first available trigger's outputs as a baseline
  const triggerId = blockConfig.triggers.available[0]
  if (triggerId && isTriggerValid(triggerId)) {
    const trigger = getTrigger(triggerId)
    if (trigger.outputs) {
      for (const [key, def] of Object.entries(trigger.outputs)) {
        if (isHiddenFromDisplay(def)) continue
        outputs[key] = extractOutputField(def)
      }
    }
  }

  return outputs
}

/**
 * Extracts output schema from block config or tool
 */
function extractOutputs(
  blockConfig: any,
  operation?: string,
  triggerMode?: boolean
): Record<string, OutputFieldSchema> {
  const outputs: Record<string, OutputFieldSchema> = {}

  // In trigger mode, return trigger outputs
  if (triggerMode && blockConfig.triggers?.enabled) {
    return extractTriggerOutputs(blockConfig)
  }

  // If operation is specified, try to get outputs from the specific tool
  if (operation) {
    try {
      const toolSelector = blockConfig.tools?.config?.tool
      if (typeof toolSelector === 'function') {
        const toolId = toolSelector({ operation })
        const tool = toolsRegistry[toolId]
        if (tool?.outputs) {
          for (const [key, def] of Object.entries(tool.outputs)) {
            if (isHiddenFromDisplay(def)) continue
            outputs[key] = extractOutputField(def)
          }
          return outputs
        }
      }
    } catch {
      // Fall through to block-level outputs
    }
  }

  // Use block-level outputs
  if (blockConfig.outputs) {
    for (const [key, def] of Object.entries(blockConfig.outputs)) {
      if (isHiddenFromDisplay(def)) continue
      outputs[key] = extractOutputField(def)
    }
  }

  return outputs
}

export const getBlockConfigServerTool: BaseServerTool<
  GetBlockConfigInputType,
  GetBlockConfigResultType
> = {
  name: 'get_block_config',
  inputSchema: GetBlockConfigInput,
  outputSchema: GetBlockConfigResult,
  async execute(
    { blockType, operation, trigger }: GetBlockConfigInputType,
    context?: { userId: string }
  ): Promise<GetBlockConfigResultType> {
    const logger = createLogger('GetBlockConfigServerTool')
    const normalized = normalizeGetBlockConfigArgs(blockType, operation, trigger)
    let normalizedOperation = normalized.operation
    logger.debug('Executing get_block_config', {
      blockType,
      operation,
      trigger,
      normalizedBlockType: normalized.blockType,
      normalizedOperation,
      normalizedTrigger: normalized.trigger,
    })

    if (normalized.blockType === 'loop') {
      const result = {
        blockType: normalized.blockType,
        blockName: 'Loop',
        operation: normalizedOperation,
        trigger: normalized.trigger,
        inputs: {
          loopType: {
            type: 'string',
            description: 'Loop type',
            options: ['for', 'forEach', 'while', 'doWhile'],
            default: 'for',
          },
          iterations: {
            type: 'number',
            description: 'Number of iterations (for loop type "for")',
          },
          collection: {
            type: 'string',
            description: 'Collection to iterate (for loop type "forEach")',
          },
          condition: {
            type: 'string',
            description: 'Loop condition (for loop types "while" and "doWhile")',
          },
        },
        outputs: {},
      }
      return GetBlockConfigResult.parse(result)
    }

    if (normalized.blockType === 'parallel') {
      const result = {
        blockType: normalized.blockType,
        blockName: 'Parallel',
        operation: normalizedOperation,
        trigger: normalized.trigger,
        inputs: {
          parallelType: {
            type: 'string',
            description: 'Parallel type',
            options: ['count', 'collection'],
            default: 'count',
          },
          count: {
            type: 'number',
            description: 'Number of parallel branches (for parallel type "count")',
          },
          collection: {
            type: 'string',
            description: 'Collection to branch over (for parallel type "collection")',
          },
        },
        outputs: {},
      }
      return GetBlockConfigResult.parse(result)
    }

    const permissionConfig = context?.userId ? await getUserPermissionConfig(context.userId) : null
    const allowedIntegrations =
      permissionConfig?.allowedIntegrations ?? getAllowedIntegrationsFromEnv()

    if (
      allowedIntegrations != null &&
      !allowedIntegrations.includes(normalized.blockType.toLowerCase())
    ) {
      throw new Error(`Block "${normalized.blockType}" is not available`)
    }

    const blockConfig = blockRegistry[normalized.blockType]
    if (!blockConfig) {
      throw new Error(`Block not found: ${normalized.blockType}`)
    }

    // Validate trigger mode is supported for this block
    if (normalized.trigger && !blockConfig.triggers?.enabled && !blockConfig.triggerAllowed) {
      throw new Error(
        `Block "${normalized.blockType}" does not support trigger mode. Only blocks with triggers.enabled or triggerAllowed can be used in trigger mode.`
      )
    }

    // If operation is specified, normalize aliases and validate if options are static.
    if (normalizedOperation) {
      const operationSubBlock = blockConfig.subBlocks?.find((sb) => sb.id === 'operation')
      if (operationSubBlock && Array.isArray(operationSubBlock.options)) {
        const validOperations = operationSubBlock.options.map((o) =>
          typeof o === 'object' ? o.id : o
        )
        normalizedOperation = normalizeOperationAlias(
          normalized.blockType,
          normalizedOperation,
          validOperations
        )
        if (!normalizedOperation) {
          logger.warn(
            'Invalid operation requested; returning block config without operation filter',
            {
              blockType: normalized.blockType,
              requestedOperation: operation,
              validOperations,
            }
          )
        }
      } else {
        normalizedOperation = normalizeOperationAlias(normalized.blockType, normalizedOperation)
      }
    }

    const subBlocks = Array.isArray(blockConfig.subBlocks) ? blockConfig.subBlocks : []
    const inputs = extractInputsFromSubBlocks(subBlocks, normalizedOperation, normalized.trigger)
    const outputs = extractOutputs(blockConfig, normalizedOperation, normalized.trigger)

    const latestBlock = getLatestBlock(normalized.blockType)
    const displayName = latestBlock?.name ?? blockConfig.name

    const result = {
      blockType: normalized.blockType,
      blockName: displayName,
      operation: normalizedOperation,
      trigger: normalized.trigger,
      inputs,
      outputs,
    }

    return GetBlockConfigResult.parse(result)
  },
}
