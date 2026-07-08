import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  previewLines,
  renderExpandableText,
  spinnerFrame,
  stopSpinner,
  type SpinnerState,
} from '@pi-plugins/shared'
import { Effect } from 'effect'
import { Type, type Static } from 'typebox'
import {
  emptySnapshot,
  runSubagent,
  type SubagentSnapshot,
  type SubagentUsage,
} from './runner'
import { capToolOutput, formatUsage, modelPattern } from './utils'

const PROMPT_PREVIEW_LINES = 2
const PROMPT_PREVIEW_WIDTH = 80

const subagentSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task',
  }),
  prompt: Type.String({
    description: 'The task for the agent to perform',
  }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model override for this agent (defaults to the current model and thinking level)',
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
  /** Set on the final result when the run failed. */
  failed?: boolean | undefined
  errorMessage?: string | undefined
  stderr?: string | undefined
}

export default function subagent(pi: ExtensionAPI) {
  // Usage from finished subagent runs that has not yet been folded back into
  // the parent session's totals.
  const pending: SubagentUsage[] = []

  // Fold subagent usage back into the parent session so the footer's
  // cumulative token/cost stats include delegated work.
  pi.on('message_end', ({ message }) => {
    if (
      message.role !== 'assistant' ||
      message.usage.totalTokens <= 0 ||
      pending.length === 0
    ) {
      return undefined
    }
    const usage = { ...message.usage, cost: { ...message.usage.cost } }
    for (const run of pending.splice(0)) {
      usage.input += run.input
      usage.output += run.output
      usage.cacheRead += run.cacheRead
      usage.cacheWrite += run.cacheWrite
      usage.cost.total += run.cost
    }
    return { message: { ...message, usage } }
  })

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
      // An omitted `model` should mean "same model", not "child default".
      const model =
        params.model ??
        (ctx.model !== undefined
          ? modelPattern(ctx.model, pi.getThinkingLevel())
          : undefined)

      // Inherit the parent's active tool set (minus subagent itself) so a
      // restricted parent (e.g. `pi --tools read`) cannot be escaped by
      // delegating to a child with default tools.
      const tools = pi.getActiveTools().filter((name) => name !== 'subagent')

      const program = runSubagent({
        prompt: params.prompt,
        model,
        // Resolve relative cwd against the parent session's cwd, not the
        // process cwd (they can differ for resumed/cross-project sessions).
        cwd: params.cwd !== undefined ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
        tools,
        onUpdate: (snapshot) => {
          onUpdate?.({
            content: [{ type: 'text', text: snapshot.output || '(running...)' }],
            details: snapshot,
          })
        },
      }).pipe(
        Effect.map((snapshot) => ({
          content: [
            {
              type: 'text' as const,
              text: snapshot.output ? capToolOutput(snapshot.output) : '(no output)',
            },
          ],
          details: snapshot as SubagentDetails,
        })),
        Effect.catch((error) => {
          const snapshot = 'snapshot' in error ? error.snapshot : emptySnapshot
          const label = error._tag === 'SubagentStopError' ? error.reason : 'failed'
          const reason =
            error._tag === 'PlatformError'
              ? `Failed to run subagent: ${error.message}`
              : error.message
          return Effect.succeed({
            content: [
              {
                type: 'text' as const,
                text: `Subagent ${label}: ${capToolOutput(reason)}`,
              },
            ],
            details: {
              ...snapshot,
              failed: true,
              errorMessage: reason,
              stderr: 'stderr' in error ? error.stderr : undefined,
            },
            isError: true,
          })
        }),
        Effect.tap(({ details }) => Effect.sync(() => pending.push(details.usage))),
        Effect.provide(NodeServices.layer),
      )

      return await Effect.runPromise(program, { signal })
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
        for (const line of previewLines(
          args.prompt,
          PROMPT_PREVIEW_LINES,
          PROMPT_PREVIEW_WIDTH,
        )) {
          text += `\n${theme.fg('dim', line)}`
        }
      }

      return new Text(text, 0, 0)
    },
    renderResult({ details }, { expanded, isPartial }, theme, context) {
      const running = isPartial
      const failed = details.failed === true

      if (!running) {
        stopSpinner(context.state)
      }

      const icon = running
        ? theme.fg('accent', spinnerFrame(context.state, context.invalidate))
        : failed
          ? theme.fg('error', '✗')
          : theme.fg('success', '✓')

      const usage = formatUsage(details.usage, details.model, details.toolCalls)
      let header = icon
      if (usage) {
        header += ` ${theme.fg('muted', usage)}`
      } else if (running) {
        header += ` ${theme.fg('muted', 'starting...')}`
      }
      const content =
        details.output ||
        (failed ? (details.stderr?.trim() ?? '') : '') ||
        (running ? '(running...)' : '(no output)')

      // Skip the error line when it would repeat the rendered content.
      if (failed && details.errorMessage && details.errorMessage !== content) {
        header += `\n${theme.fg('error', `Error: ${details.errorMessage}`)}`
      }

      const text = new Text('', 0, 0)
      text.setText(renderExpandableText({ header, content, expanded, theme }))
      return text
    },
  })
}
