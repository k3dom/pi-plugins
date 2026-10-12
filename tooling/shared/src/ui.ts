import type {
  Theme,
  ThemeColor,
  TruncationResult,
} from '@earendil-works/pi-coding-agent'
import { formatSize, keyHint } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { Text, truncateToWidth } from '@earendil-works/pi-tui'
import { Array, Match, pipe, String } from 'effect'

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
  }: {
    readonly text: string
    readonly maxLines: number
    readonly expanded: boolean
    readonly theme: Theme
    readonly color?: ThemeColor
  }) {
    // Styled per source line so wrapping re-emits the color on each visual line.
    const styled = pipe(
      text,
      String.split('\n'),
      Array.map((line) => theme.fg(color, line)),
      Array.join('\n'),
    )
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
    return [...Array.take(lines, this.maxLines), truncateToWidth(hint, width, '...')]
  }
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
  }: {
    readonly header: string
    readonly content: string
    readonly maxLines: number
    readonly expanded: boolean
    readonly theme: Theme
    readonly truncation?: TruncationResult
  }) {
    const body = String.replace(/\n+$/, '')(content)
    this.parts = [
      new Text(header, 0, 0),
      String.isNonEmpty(body)
        ? new TextPreview({
            text: body,
            maxLines,
            expanded,
            theme,
            color: 'toolOutput',
          })
        : new Text(theme.fg('dim', '(empty response)'), 0, 0),
    ]

    const notice = truncation ? truncationNotice(truncation) : ''
    if (String.isNonEmpty(notice)) {
      this.parts.push(new Text(theme.fg('warning', notice), 0, 0))
    }
  }

  invalidate(): void {
    for (const part of this.parts) {
      part.invalidate()
    }
  }

  render(width: number): string[] {
    return Array.flatMap(this.parts, (part) => part.render(width))
  }
}

export function truncationNotice(truncation: TruncationResult): string {
  if (!truncation.truncated) {
    return ''
  }
  return Match.value(truncation.truncatedBy).pipe(
    Match.when(
      'lines',
      () =>
        `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit)]`,
    ),
    Match.when(
      'bytes',
      () =>
        `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit)]`,
    ),
    Match.orElse(() =>
      truncation.firstLineExceedsLimit
        ? `[First line exceeds ${formatSize(truncation.maxBytes)} limit]`
        : '',
    ),
  )
}

export function truncatedText(truncation: TruncationResult): string {
  return truncation.truncated
    ? `${truncation.content}\n\n${truncationNotice(truncation)}`
    : truncation.content
}
