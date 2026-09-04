import { truncateHead } from '@earendil-works/pi-coding-agent'
import { formatTruncationNotice } from '@pi-plugins/shared/ui'
import type { SubagentResult } from './runner'

export function capToolOutput(text: string): string {
  const truncation = truncateHead(text)
  return truncation.truncated
    ? `${truncation.content}\n\n${formatTruncationNotice(truncation)}`
    : truncation.content
}

function formatTokens(count: number): string {
  if (count < 1000) {
    return count.toString()
  }
  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  if (count < 1000000) {
    return `${Math.round(count / 1000)}k`
  }
  return `${(count / 1000000).toFixed(1)}M`
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const seconds = `${totalSeconds % 60}`.padStart(2, '0')
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0
    ? `${hours}h${`${minutes}`.padStart(2, '0')}m${seconds}s`
    : `${minutes}m${seconds}s`
}

export function formatStats(result: SubagentResult): string {
  const { usage, toolCalls } = result
  const parts: string[] = []
  if (usage.turns > 0) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  }
  if (toolCalls > 0) {
    parts.push(`${toolCalls} tool${toolCalls > 1 ? 's' : ''}`)
  }
  if (usage.input > 0) {
    parts.push(`↑${formatTokens(usage.input)}`)
  }
  if (usage.output > 0) {
    parts.push(`↓${formatTokens(usage.output)}`)
  }
  if (usage.cacheRead > 0) {
    parts.push(`R${formatTokens(usage.cacheRead)}`)
  }
  if (usage.cacheWrite > 0) {
    parts.push(`W${formatTokens(usage.cacheWrite)}`)
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(4)}`)
  }
  if (result.durationMs !== undefined) {
    parts.push(formatDuration(result.durationMs))
  }
  return parts.join(' ')
}
