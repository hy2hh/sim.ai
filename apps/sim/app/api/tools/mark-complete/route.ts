import { type NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/core/config/env'

/**
 * Stub endpoint for the local agent mode.
 * The external copilot.sim.ai backend uses this to receive tool completion
 * notifications. In local agent mode, tools are executed directly, so this
 * endpoint simply acknowledges the request.
 */
export async function POST(req: NextRequest) {
  if (env.COPILOT_API_KEY) {
    const providedKey = req.headers.get('x-api-key')
    if (providedKey !== env.COPILOT_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  return NextResponse.json({ success: true })
}
