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

/** Joins all text blocks of a tool result into one string, stripping carriage returns. */
export function getTextOutput(
  result: Pick<AgentToolResult<unknown>, 'content'>,
): string {
  return result.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text.replace(/\r/g, ''))
    .join('\n')
}

/**
 * Renders a `header` above its `content`. Trailing blank lines are dropped and
 * the body is capped to a 10-line preview unless `expanded`; when the preview
 * hides lines a "... (N more lines, ... to expand)" hint is appended. A
 * `truncation` notice footer is added when provided.
 */
export function renderExpandableText({
  header,
  content,
  expanded,
  theme,
  truncation,
}: {
  header: string
  content: string
  expanded: boolean
  theme: Theme
  truncation?: TruncationResult
}): string {
  const lines = content.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const maxLines = expanded ? lines.length : 10
  const displayLines = lines.slice(0, maxLines)
  const remaining = lines.length - maxLines

  let text = header

  if (displayLines.length > 0) {
    text += `\n${displayLines
      .map((line) => theme.fg('toolOutput', line.replace(/\t/g, '   ')))
      .join('\n')}`
  } else {
    text += `\n${theme.fg('dim', '(empty response)')}`
  }

  if (remaining > 0) {
    text += `${theme.fg('muted', `\n... (${remaining} more lines,`)} ${keyHint(
      'app.tools.expand',
      'to expand',
    )})`
  }

  if (truncation) {
    const notice = formatTruncationNotice(truncation)
    if (notice) {
      text += `\n${theme.fg('warning', notice)}`
    }
  }

  return text
}

/**
 * Builds a human-readable notice describing how a result was truncated (by line
 * or byte limit), or an empty string when it was not truncated.
 */
export function formatTruncationNotice(truncation: TruncationResult): string {
  let result = ''

  if (truncation.truncated) {
    if (truncation.firstLineExceedsLimit) {
      result = `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`
    }

    if (truncation.truncatedBy === 'lines') {
      result = `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`
    } else if (truncation.truncatedBy === 'bytes') {
      result = `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`
    }
  }

  return result
}
