import type { RateLimitWindow } from './provider/openai'

export function parseResetsAt(
  value: string | number | null | undefined,
): Date | null {
  if (typeof value === 'number') {
    // Epoch seconds, as Claude Code assumes.
    return new Date(value * 1000)
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

export function codexResetsAt(window: RateLimitWindow, now: Date): Date | null {
  if (typeof window.reset_after_seconds === 'number') {
    return new Date(now.getTime() + window.reset_after_seconds * 1000)
  }
  if (typeof window.reset_at === 'number') {
    return new Date(window.reset_at * 1000)
  }
  return null
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(Math.ceil(ms / 60_000), 0)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function formatCompactDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) {
    return `${Math.max(minutes, 1)}m`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
