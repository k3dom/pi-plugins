import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { renderExpandableText } from '@pi-plugins/shared'
import { Effect } from 'effect'
import { Type, type Static } from 'typebox'
import {
  isFailure,
  runSubagent,
  type SubagentSnapshot,
  type SubagentUsage,
} from './runner'

const subagentSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task',
  }),
  prompt: Type.String({
    description: 'The task for the agent to perform',
  }),
  model: Type.Optional(
    Type.String({
      description: 'Optional model override for this agent',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for the agent process',
    }),
  ),
})

export type SubagentInput = Static<typeof subagentSchema>

interface SubagentDetails extends SubagentSnapshot {
  exitCode?: number
  stderr?: string
}

/** Row-local renderer state driving the running-spinner animation. */
interface SpinnerState {
  frame?: number
  timer?: ReturnType<typeof setTimeout>
}

/** Same braille spinner pi's own "Working..." loader uses. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

/**
 * Returns the current spinner frame and schedules the next animation tick.
 *
 * Each tick re-renders the tool row via `invalidate()`, which calls back into
 * `renderResult` and schedules the next tick — so the animation stops by
 * itself as soon as the row is no longer rendered.
 */
function spinnerFrame(state: SpinnerState, invalidate: () => void): string {
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

function stopSpinner(state: SpinnerState): void {
  if (state.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
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

function formatUsage(usage: SubagentUsage, model?: string): string {
  const parts: string[] = []
  if (usage.turns > 0) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  }
  if (usage.input > 0) {
    parts.push(`↑${formatTokens(usage.input)}`)
  }
  if (usage.output > 0) {
    parts.push(`↓${formatTokens(usage.output)}`)
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(4)}`)
  }
  if (model !== undefined) {
    parts.push(model)
  }
  return parts.join(' ')
}

export default function subagent(pi: ExtensionAPI) {
  pi.registerTool<typeof subagentSchema, SubagentDetails, SpinnerState>({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a task to a subagent: a fresh headless pi instance with its own isolated context window. ' +
      'The subagent receives only the given prompt (no conversation history) and returns its final response, ' +
      'so include all necessary context in the prompt and describe exactly what it should report back. ' +
      'Use it to keep large exploration or self-contained subtasks out of the main context.',
    promptSnippet:
      'Delegate self-contained tasks to subagents (isolated headless pi instances).',
    parameters: subagentSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const program = runSubagent({
        prompt: params.prompt,
        model: params.model,
        cwd: params.cwd ?? ctx.cwd,
        onUpdate: (snapshot) => {
          onUpdate?.({
            content: [{ type: 'text', text: snapshot.output || '(running...)' }],
            details: snapshot,
          })
        },
      }).pipe(Effect.provide(NodeServices.layer))

      const result = await Effect.runPromise(program, { signal })

      if (isFailure(result)) {
        const reason =
          result.errorMessage ||
          result.stderr.trim() ||
          result.output ||
          `pi exited with code ${result.exitCode}`
        return {
          content: [
            {
              type: 'text',
              text: `Subagent ${result.stopReason ?? 'failed'}: ${reason}`,
            },
          ],
          details: result,
          isError: true,
        }
      }

      return {
        content: [{ type: 'text', text: result.output || '(no output)' }],
        details: result,
      }
    },
    renderCall(args, theme) {
      let text =
        theme.fg('toolTitle', theme.bold('subagent ')) +
        theme.fg('accent', args.description ?? '...')

      const extras: string[] = []
      if (args.model !== undefined) {
        extras.push(args.model)
      }
      if (args.cwd !== undefined) {
        extras.push(args.cwd)
      }
      if (extras.length > 0) {
        text += theme.fg('muted', ` (${extras.join(', ')})`)
      }

      if (args.prompt !== undefined) {
        const firstLine = args.prompt.split('\n', 1)[0] ?? ''
        const preview =
          firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine
        text += `\n  ${theme.fg('dim', preview)}`
      }

      return new Text(text, 0, 0)
    },
    renderResult({ details }, { expanded, isPartial }, theme, context) {
      const running = isPartial || details.exitCode === undefined
      const failed =
        !running &&
        (details.exitCode !== 0 ||
          details.stopReason === 'error' ||
          details.stopReason === 'aborted')

      if (!running) {
        stopSpinner(context.state)
      }

      const icon = running
        ? theme.fg('accent', spinnerFrame(context.state, context.invalidate))
        : failed
          ? theme.fg('error', '✗')
          : theme.fg('success', '✓')

      let header = `${icon} ${theme.fg('accent', context.args.description ?? 'subagent')}`
      const usage = formatUsage(details.usage, details.model)
      if (usage) {
        header += ` ${theme.fg('muted', `(${usage})`)}`
      }
      if (failed && details.errorMessage) {
        header += `\n${theme.fg('error', `Error: ${details.errorMessage}`)}`
      }

      const content =
        details.output ||
        (failed ? (details.stderr?.trim() ?? '') : '') ||
        (running ? '(running...)' : '(no output)')

      const text = new Text('', 0, 0)
      text.setText(renderExpandableText({ header, content, expanded, theme }))
      return text
    },
  })
}
