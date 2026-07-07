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

/** Row-local renderer state driving a running-spinner animation. */
export interface SpinnerState {
  frame?: number
  timer?: ReturnType<typeof setTimeout>
}

/** Same braille spinner pi's own "Working..." loader uses. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

/**
 * Returns the current spinner frame and schedules the next animation tick.
 *
 * Each tick invalidates the row, whose re-render schedules the next tick — so
 * the animation stops by itself once the row is no longer rendered. Use
 * {@link stopSpinner} to cancel the pending tick eagerly.
 */
export function spinnerFrame(state: SpinnerState, invalidate: () => void): string {
  if (state.timer === undefined) {
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.frame = ((state.frame ?? 0) + 1) % SPINNER_FRAMES.length
      invalidate()
    }, SPINNER_INTERVAL_MS)
    state.timer.unref?.()
  }
  return SPINNER_FRAMES[(state.frame ?? 0) % SPINNER_FRAMES.length] ?? ''
}

/** Cancels a pending spinner tick, if any. */
export function stopSpinner(state: SpinnerState): void {
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
}

/**
 * Wraps text into at most `maxLines` preview lines of `width` characters,
 * marking the last line with `...` when the text was cut off.
 */
export function previewLines(
  text: string,
  maxLines: number,
  width: number,
): string[] {
  const lines: string[] = []
  outer: for (const line of text.split('\n')) {
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
