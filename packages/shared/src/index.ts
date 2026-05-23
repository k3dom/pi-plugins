import type {
  AgentToolResult,
  Theme,
  TruncationResult,
} from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from '@earendil-works/pi-coding-agent'

export const DEFAULT_PREVIEW_LINES = 10

export interface RenderExpandableTextOptions {
  header: string
  content: string
  expanded: boolean
  theme: Theme
  truncation?: TruncationResult
  previewLines?: number
  emptyText?: string
  expandKeybinding?: Parameters<typeof keyHint>[0]
  expandHint?: string
}

export function trimTrailingEmptyLines(lines: readonly string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') {
    end--
  }
  return lines.slice(0, end)
}

export function expandTabs(text: string): string {
  return text.replace(/\t/g, '   ')
}

export function getTextOutput(
  result: Pick<AgentToolResult<unknown>, 'content'>,
): string {
  return result.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text.replace(/\r/g, ''))
    .join('\n')
}

export function renderExpandableText({
  header,
  content,
  expanded,
  theme,
  truncation,
  previewLines = DEFAULT_PREVIEW_LINES,
  emptyText = '(empty response)',
  expandKeybinding = 'app.tools.expand',
  expandHint = 'to expand',
}: RenderExpandableTextOptions): string {
  const lines = trimTrailingEmptyLines(content.split('\n'))
  const maxLines = expanded ? lines.length : previewLines
  const displayLines = lines.slice(0, maxLines)
  const remaining = lines.length - maxLines

  let text = header

  if (displayLines.length > 0) {
    text += `\n${displayLines
      .map((line) => theme.fg('toolOutput', expandTabs(line)))
      .join('\n')}`
  } else {
    text += `\n${theme.fg('dim', emptyText)}`
  }

  if (remaining > 0) {
    text += `${theme.fg('muted', `\n... (${remaining} more lines,`)} ${keyHint(
      expandKeybinding,
      expandHint,
    )})`
  }

  if (truncation) {
    text += formatTruncationNoticeFooter(truncation, theme)
  }

  return text
}

export function formatTruncationNotice(truncation: TruncationResult): string {
  if (!truncation.truncated) return ''

  if (truncation.firstLineExceedsLimit) {
    return `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`
  }

  if (truncation.truncatedBy === 'lines') {
    return `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`
  }

  return `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`
}

export function formatTruncationNoticeFooter(
  truncation: TruncationResult,
  theme: Theme,
): string {
  const notice = formatTruncationNotice(truncation)
  return notice ? `\n${theme.fg('warning', notice)}` : ''
}
