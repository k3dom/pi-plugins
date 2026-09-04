import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  TruncationResult,
} from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { Text, truncateToWidth } from '@earendil-works/pi-tui'

export interface TextPreviewOptions {
  text: string
  maxLines: number
  expanded: boolean
  theme: Theme
  color?: ThemeColor
}

export class TextPreview implements Component {
  private readonly body: Text
  private readonly maxLines: number
  private readonly expanded: boolean
  private readonly theme: Theme

  constructor({
    text,
    maxLines,
    expanded,
    theme,
    color = 'dim',
  }: TextPreviewOptions) {
    // Styled per source line so wrapping re-emits the color on each visual line.
    const styled = text
      .split('\n')
      .map((line) => theme.fg(color, line))
      .join('\n')
    this.body = new Text(styled, 0, 0)
    this.maxLines = maxLines
    this.expanded = expanded
    this.theme = theme
  }

  invalidate(): void {
    this.body.invalidate()
  }

  render(width: number): string[] {
    const lines = this.body.render(width)
    const hidden = lines.length - this.maxLines
    if (this.expanded || hidden <= 0) {
      return lines
    }
    const hint = `${this.theme.fg('muted', `... (${hidden} more lines,`)} ${keyHint(
      'app.tools.expand',
      'to expand',
    )})`
    return [...lines.slice(0, this.maxLines), truncateToWidth(hint, width, '...')]
  }
}

export function getTextOutput(
  result: Pick<AgentToolResult<unknown>, 'content'>,
): string {
  return result.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text.replace(/\r/g, ''))
    .join('\n')
}

export interface ExpandableTextOptions {
  header: string
  content: string
  maxLines: number
  expanded: boolean
  theme: Theme
  truncation?: TruncationResult
}

export class ExpandableText implements Component {
  private readonly parts: Component[]

  constructor({
    header,
    content,
    maxLines,
    expanded,
    theme,
    truncation,
  }: ExpandableTextOptions) {
    const body = content.replace(/\n+$/, '')
    this.parts = [
      new Text(header, 0, 0),
      body
        ? new TextPreview({
            text: body,
            maxLines,
            expanded,
            theme,
            color: 'toolOutput',
          })
        : new Text(theme.fg('dim', '(empty response)'), 0, 0),
    ]

    const notice = truncation ? formatTruncationNotice(truncation) : ''
    if (notice) {
      this.parts.push(new Text(theme.fg('warning', notice), 0, 0))
    }
  }

  invalidate(): void {
    for (const part of this.parts) {
      part.invalidate()
    }
  }

  render(width: number): string[] {
    return this.parts.flatMap((part) => part.render(width))
  }
}

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
