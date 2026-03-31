import type { HiveEvent } from '../types.js'

/**
 * Per-agent queue of pending events.
 * Events are delivered as piggyback on the next tool call response.
 */
export class EventQueue {
  private queues  = new Map<string, HiveEvent[]>()
  private waiters = new Map<string, Set<() => void>>()

  push(agentId: string, type: string, payload: Record<string, unknown>): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, [])
    }
    this.queues.get(agentId)!.push({
      type,
      payload,
      timestamp: new Date().toISOString(),
    })
    // Wake any hive_wait call blocking on this agent
    const cbs = this.waiters.get(agentId)
    if (cbs?.size) {
      cbs.forEach(cb => cb())
      this.waiters.delete(agentId)
    }
  }

  /**
   * Register a one-shot callback fired when the next event arrives.
   * Returns an unsubscribe function to cancel before timeout.
   */
  onNextEvent(agentId: string, callback: () => void): () => void {
    const set = this.waiters.get(agentId) ?? new Set<() => void>()
    set.add(callback)
    this.waiters.set(agentId, set)
    return () => {
      this.waiters.get(agentId)?.delete(callback)
    }
  }

  /** Returns and clears all pending events for an agent */
  drain(agentId: string): HiveEvent[] {
    const events = this.queues.get(agentId) ?? []
    this.queues.delete(agentId)
    return events
  }

  peek(agentId: string): HiveEvent[] {
    return this.queues.get(agentId) ?? []
  }

  clear(agentId: string): void {
    this.queues.delete(agentId)
  }
}
