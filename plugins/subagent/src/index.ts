import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  renderExpandableText,
  spinnerFrame,
  stopSpinner,
  type SpinnerState,
} from '@pi-plugins/shared'
import { Effect } from 'effect'
import { Type, type Static } from 'typebox'
import { isFailure, runSubagent, type SubagentSnapshot } from './runner'
import { capToolOutput, formatUsage, modelPattern } from './utils'

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
  exitCode?: number
  stderr?: string
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
      // Inherit the parent's model and thinking level unless overridden, so an
      // omitted `model` param behaves like "same model", not "child default".
      const model =
        params.model ??
        (ctx.model !== undefined
          ? modelPattern(ctx.model, pi.getThinkingLevel())
          : undefined)

      const program = runSubagent({
        prompt: params.prompt,
        model,
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
              text: `Subagent ${result.stopReason ?? 'failed'}: ${capToolOutput(reason)}`,
            },
          ],
          details: result,
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: result.output ? capToolOutput(result.output) : '(no output)',
          },
        ],
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
