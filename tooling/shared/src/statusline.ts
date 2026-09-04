import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Array, Order, pipe, String } from 'effect'

export interface StatuslineSegment {
  /** Plain text: the whole row is dimmed uniformly across plugins. */
  readonly text: string
  readonly align: 'left' | 'right'
}

const WIDGET_KEY = 'pi-plugins:statusline'

// Each plugin bundles its own copy of this module; `Symbol.for` on
// `globalThis` gives them all the same registry inside one pi process.
const REGISTRY_KEY = Symbol.for('@pi-plugins/statusline-registry')

type Registry = Map<string, StatuslineSegment>

function side(segments: Registry, align: StatuslineSegment['align']): string {
  return pipe(
    Array.fromIterable(segments),
    Array.filter(([, segment]) => segment.align === align),
    Array.sortBy(
      Order.mapInput(
        Order.String,
        ([key]: readonly [string, StatuslineSegment]) => key,
      ),
    ),
    Array.map(([, segment]) => segment.text),
    Array.join(' · '),
  )
}

function textWidth(text: string): number {
  return Array.fromIterable(text).length
}

export function setStatuslineSegment(
  ctx: ExtensionContext,
  key: string,
  segment: StatuslineSegment | undefined,
): void {
  const store = globalThis as { [REGISTRY_KEY]?: Registry }
  store[REGISTRY_KEY] ??= new Map()
  const segments = store[REGISTRY_KEY]
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
    invalidate: () => {},
    render: (width: number) => {
      const left = side(segments, 'left')
      const right = side(segments, 'right')

      // Left indented one column like pi's widget rows, right flush like pi's footer.
      const margin = Math.min(width, 1)
      const inner = width - margin
      const gap = inner - textWidth(left) - textWidth(right)
      const minGap = String.isNonEmpty(left) && String.isNonEmpty(right) ? 2 : 0

      const line =
        String.isNonEmpty(right) && gap >= minGap
          ? `${left}${' '.repeat(gap)}${right}`
          : pipe(
              [left, right],
              Array.filter(String.isNonEmpty),
              Array.join(' · '),
              Array.fromIterable,
              Array.take(Math.max(inner, 0)),
              Array.join(''),
            )

      return [' '.repeat(margin) + theme.fg('dim', line)]
    },
  }))
}
