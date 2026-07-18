import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Array, Order, pipe, String } from 'effect'

/**
 * One entry on the shared status line. `text` must be plain (un-styled) text —
 * the whole row is dimmed uniformly so segments from different plugins share
 * one look.
 */
export interface StatuslineSegment {
  readonly text: string
  readonly align: 'left' | 'right'
}

const WIDGET_KEY = 'pi-plugins:statusline'

// Each plugin bundles its own copy of this module; `Symbol.for` on
// `globalThis` gives them all the same registry inside one pi process.
const REGISTRY_KEY = Symbol.for('@pi-plugins/statusline-registry')

type Registry = Map<string, StatuslineSegment>

function registry(): Registry {
  const store = globalThis as { [REGISTRY_KEY]?: Registry }
  store[REGISTRY_KEY] ??= new Map()
  return store[REGISTRY_KEY]
}

const byKey = Order.mapInput(
  Order.String,
  ([key]: readonly [string, StatuslineSegment]) => key,
)

function side(segments: Registry, align: StatuslineSegment['align']): string {
  return pipe(
    Array.fromIterable(segments),
    Array.filter(([, segment]) => segment.align === align),
    Array.sortBy(byKey),
    Array.map(([, segment]) => segment.text),
    Array.join(' · '),
  )
}

/** Terminal columns of plain text (code points, no ANSI). */
function textWidth(text: string): number {
  return Array.fromIterable(text).length
}

function truncate(text: string, columns: number): string {
  return pipe(Array.fromIterable(text), Array.take(columns), Array.join(''))
}

/**
 * Lays out `left ... right` across `width`: left indented one column to match
 * pi's built-in widget rows, right flush against the terminal edge to match
 * pi's footer. Falls back to one truncated `left · right` run when too narrow.
 */
function renderLine(segments: Registry, width: number, theme: Theme): string {
  const left = side(segments, 'left')
  const right = side(segments, 'right')

  const margin = Math.min(width, 1)
  const inner = width - margin
  const gap = inner - textWidth(left) - textWidth(right)
  const minGap = String.isNonEmpty(left) && String.isNonEmpty(right) ? 2 : 0

  const line =
    String.isNonEmpty(right) && gap >= minGap
      ? `${left}${' '.repeat(gap)}${right}`
      : truncate(
          pipe([left, right], Array.filter(String.isNonEmpty), Array.join(' · ')),
          Math.max(inner, 0),
        )

  return ' '.repeat(margin) + theme.fg('dim', line)
}

/**
 * Adds, replaces (`segment`), or removes (`undefined`) a keyed segment on a
 * single status line above the editor shared across pi-plugins extensions,
 * instead of each plugin stacking its own widget row.
 */
export function setStatuslineSegment(
  ctx: ExtensionContext,
  key: string,
  segment: StatuslineSegment | undefined,
): void {
  const segments = registry()
  if (segment === undefined) {
    segments.delete(key)
  } else {
    segments.set(key, segment)
  }

  if (!ctx.hasUI) {
    return
  }

  if (segments.size === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined)
    return
  }

  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
    render: (width: number) => [renderLine(segments, width, theme)],
    invalidate: () => {},
  }))
}
