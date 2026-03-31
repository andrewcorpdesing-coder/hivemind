import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import type { MessageBus } from '../mcp/MessageBus.js'
import type { HiveEvent } from '../types.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

// Slightly under 60s so proxies/clients don't timeout first
const WAIT_TIMEOUT_MS = 55_000

const WaitShape = {
  agent_id: z.string().min(1).describe('Your agent ID'),
}

type WaitParams = { agent_id: string }

export function registerWaitTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  eventQueue: EventQueue,
  messageBus: MessageBus,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_wait',
    'Block until the broker has events for this agent — zero tokens wasted while idle. ' +
    'Returns immediately if events are already queued. ' +
    'Returns { reconnect: true, events: [] } after ~55s with nothing — call again right away. ' +
    'Use this instead of polling with hive_heartbeat when you have no active task.',
    WaitShape,
    async (params: WaitParams) => {
      const agent = agentRegistry.getById(params.agent_id)
      if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')

      // Keep session alive
      agentRegistry.heartbeat(params.agent_id)

      // Return immediately if events already queued
      const immediate: HiveEvent[] = [
        ...eventQueue.drain(params.agent_id),
        ...messageBus.drain(params.agent_id),
      ]
      if (immediate.length > 0) {
        return toolOk({ events: immediate, reconnect: false })
      }

      // Block until an event arrives or timeout
      const events = await new Promise<HiveEvent[]>((resolve) => {
        let settled = false

        const finish = () => {
          if (settled) return
          settled = true
          resolve([
            ...eventQueue.drain(params.agent_id),
            ...messageBus.drain(params.agent_id),
          ])
        }

        const unsubEQ = eventQueue.onNextEvent(params.agent_id, finish)
        const unsubMB = messageBus.onNextMessage(params.agent_id, finish)

        setTimeout(() => {
          unsubEQ()
          unsubMB()
          if (!settled) { settled = true; resolve([]) }
        }, WAIT_TIMEOUT_MS)
      })

      return toolOk({ events, reconnect: events.length === 0 })
    },
  )
}
