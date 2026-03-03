import type { CopilotToolCall, ToolState } from '@/stores/panel'

export type NotificationStatus =
  | 'pending'
  | 'success'
  | 'error'
  | 'accepted'
  | 'rejected'
  | 'background'

export type { CopilotToolCall, ToolState }

export interface AvailableModel {
  id: string
  friendlyName: string
  provider: string
  /** Whether the required local CLI is installed on this machine */
  available: boolean
  /** Human-readable reason shown when available is false */
  unavailableReason?: string
}
