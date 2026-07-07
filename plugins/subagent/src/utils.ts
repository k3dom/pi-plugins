import { truncateHead } from '@earendil-works/pi-coding-agent'
import { formatTruncationNotice } from '@pi-plugins/shared'
import type { SubagentUsage } from './runner'

/** Caps text to pi's standard tool-output limits, appending a notice when truncated. */
export function capToolOutput(text: string): string {
  const truncation = truncateHead(text)
  return truncation.truncated
    ? `${truncation.content}\n\n${formatTruncationNotice(truncation)}`
    : truncation.content
}

/** Formats a token count compactly (e.g. `950`, `1.2k`, `45k`, `1.3M`). */
export function formatTokens(count: number): string {
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

/** Formats usage stats as a compact one-line summary (turns, tools, tokens, cost, model). */
export function formatUsage(
  usage: SubagentUsage,
  model?: string,
  toolCalls?: number,
): string {
  const parts: string[] = []
  if (usage.turns > 0) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  }
  if (toolCalls !== undefined && toolCalls > 0) {
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
  if (model !== undefined) {
    parts.push(model)
  }
  return parts.join(' ')
}

/**
 * Wraps a prompt into at most `maxLines` preview lines of `width` characters,
 * marking the last line with `...` when the prompt was cut off.
 */
export function promptPreview(
  prompt: string,
  maxLines: number,
  width: number,
): string[] {
  const lines: string[] = []
  outer: for (const line of prompt.split('\n')) {
    for (let i = 0; i === 0 || i < line.length; i += width) {
      lines.push(line.slice(i, i + width))
      if (lines.length > maxLines) {
        break outer
      }
    }
  }
  if (lines.length <= maxLines) {
    return lines
  }
  const preview = lines.slice(0, maxLines)
  preview[maxLines - 1] += '...'
  return preview
}

/** Builds a `pi --model` pattern (`provider/id:<thinking>`) pinning model and thinking level. */
export function modelPattern(
  model: { provider: string; id: string },
  thinkingLevel?: string,
): string {
  const base = `${model.provider}/${model.id}`
  return thinkingLevel !== undefined ? `${base}:${thinkingLevel}` : base
}
