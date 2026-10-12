import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Run from '@pi-plugins/shared/run'
import * as Ui from '@pi-plugins/shared/ui'
import {
  Array,
  Duration,
  Effect,
  Match,
  Number,
  Option,
  Path,
  pipe,
  Schema,
  String,
} from 'effect'
import { Type, type Static } from 'typebox'
import * as Subagent from './subagent'

// Wrapped terminal rows, not source lines, so a row's height stays bounded.
const PROMPT_PREVIEW_LINES = 3
const OUTPUT_PREVIEW_LINES = 5
const METADATA_LABEL_WIDTH = 9

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
        "Leave unset: the subagent then runs on this session's model and thinking level. " +
        'Set it only when the user explicitly asked for a different model — never pass your own.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for the agent process',
    }),
  ),
})

export type SubagentInput = Static<typeof subagentSchema>

const subagentOutputSchema = Type.Object({
  output: Type.String({
    description: "The subagent's final response, not truncated",
  }),
  sessionId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  toolCalls: Type.Number(),
  durationMs: Type.Number(),
  usage: Type.Object({
    turns: Type.Number(),
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    cost: Type.Number({ description: 'Total cost in USD' }),
    contextTokens: Type.Number({
      description: 'Context size in tokens after the final turn',
    }),
  }),
})

export type SubagentOutput = Static<typeof subagentOutputSchema>

const Details = Schema.Struct({
  ...Subagent.Result.fields,
  cwd: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  failed: Schema.optional(Schema.Boolean),
  errorMessage: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
})

function formatTokens(count: number): string {
  return Match.value(count).pipe(
    Match.when(Number.isLessThan(1000), (n) => `${n}`),
    Match.when(Number.isLessThan(10000), (n) => `${(n / 1000).toFixed(1)}k`),
    Match.when(Number.isLessThan(1000000), (n) => `${Math.round(n / 1000)}k`),
    Match.orElse((n) => `${(n / 1000000).toFixed(1)}M`),
  )
}

function formatDuration(duration: Duration.Duration): string {
  const totalSeconds = Math.round(Duration.toSeconds(duration))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const pad = String.padStart(2, '0')
  const seconds = pad(`${totalSeconds % 60}`)
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0
    ? `${hours}h${pad(`${minutes}`)}m${seconds}s`
    : `${minutes}m${seconds}s`
}

function ifPositive(
  count: number,
  format: (count: number) => string,
): Option.Option<string> {
  return count > 0 ? Option.some(format(count)) : Option.none()
}

function formatStats(result: Subagent.Result): string {
  const { usage, toolCalls } = result
  return pipe(
    [
      ifPositive(usage.turns, (n) => `${n} turn${n > 1 ? 's' : ''}`),
      ifPositive(toolCalls, (n) => `${n} tool${n > 1 ? 's' : ''}`),
      ifPositive(usage.input, (n) => `↑${formatTokens(n)}`),
      ifPositive(usage.output, (n) => `↓${formatTokens(n)}`),
      ifPositive(usage.cacheRead, (n) => `R${formatTokens(n)}`),
      ifPositive(usage.cacheWrite, (n) => `W${formatTokens(n)}`),
      ifPositive(usage.cost.total, (n) => `$${n.toFixed(4)}`),
      Option.map(Option.fromUndefinedOr(result.durationMs), (ms) =>
        formatDuration(Duration.millis(ms)),
      ),
    ],
    Array.getSomes,
    Array.join(' '),
  )
}

export default function subagent(pi: ExtensionAPI) {
  pi.registerTool<typeof subagentSchema, typeof Details.Type>({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a substantial, clearly scoped subtask with a concrete deliverable that can be completed independently. ' +
      'Use direct tools for routine searches, file reads, and small changes. ' +
      'The subagent runs as a separate headless pi instance without this conversation’s history. ' +
      'Provide the necessary context, whether edits are allowed, and the expected output. ' +
      'It shares the filesystem with the parent. ' +
      'This call blocks until the subagent finishes, then returns its final response.',
    promptSnippet:
      'Delegate self-contained tasks to subagents (isolated headless pi instances).',
    parameters: subagentSchema,
    outputSchema: subagentOutputSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model =
        params.model ??
        (ctx.model === undefined
          ? undefined
          : `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}`)

      // Inheriting the parent's tool set keeps a restricted parent (e.g.
      // `pi --tools read`) from being escaped through a child with default tools.
      const tools = Array.filter(pi.getActiveTools(), (name) => name !== 'subagent')

      const program = Effect.gen(function* () {
        const path = yield* Path.Path
        const runner = yield* Subagent.Subagent

        // Relative to the parent session's cwd, not the process cwd: they differ
        // for resumed and cross-project sessions.
        const cwd =
          params.cwd === undefined ? ctx.cwd : path.resolve(ctx.cwd, params.cwd)

        const toolResult = yield* runner
          .run({
            prompt: params.prompt,
            name: params.description,
            model,
            cwd,
            tools,
            // The only live update: each one repaints pi's scrollback once the row
            // has scrolled out of view.
            onSession: (sessionId) => {
              onUpdate?.({
                content: [{ type: 'text', text: '' }],
                details: { ...Subagent.emptyResult, sessionId, model, cwd },
              })
            },
          })
          .pipe(
            Effect.map((result) => {
              const structuredContent: SubagentOutput = {
                output: result.output,
                ...(result.sessionId === undefined
                  ? {}
                  : { sessionId: result.sessionId }),
                ...(model === undefined ? {} : { model }),
                toolCalls: result.toolCalls,
                durationMs: result.durationMs ?? 0,
                usage: { ...result.usage, cost: result.usage.cost.total },
              }
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: result.output
                      ? Ui.truncatedText(truncateHead(result.output))
                      : '(no output)',
                  },
                ],
                details: { ...result, model, cwd },
                structuredContent,
              }
            }),
            Effect.catchTag('SubagentError', (error) =>
              Effect.succeed({
                content: [
                  {
                    type: 'text' as const,
                    text: `Subagent ${
                      error.reason._tag === 'StopError'
                        ? error.reason.stopReason
                        : 'failed'
                    }: ${Ui.truncatedText(truncateHead(error.message))}`,
                  },
                ],
                details: {
                  ...error.result,
                  model,
                  cwd,
                  failed: true,
                  errorMessage: error.message,
                  stderr: error.stderr,
                },
                isError: true,
              }),
            ),
          )

        const { input, output, cacheRead, cacheWrite, cost } =
          toolResult.details.usage
        return {
          ...toolResult,
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens: Number.sumAll([input, output, cacheRead, cacheWrite]),
            cost,
          },
        }
      }).pipe(Effect.provide([Subagent.layer, NodePath.layer]))

      return await Run.tool(program, { signal })
    },
    renderCall(args, theme, { expanded }) {
      const title = new Text(
        theme.fg('toolTitle', theme.bold('subagent ')) +
          theme.fg('accent', args.description ?? '...'),
        0,
        0,
      )
      if (args.prompt === undefined) {
        return title
      }

      const preview = new Ui.TextPreview({
        text: args.prompt,
        maxLines: PROMPT_PREVIEW_LINES,
        expanded,
        theme,
      })
      return {
        render: (width) => [...title.render(width), ...preview.render(width)],
        invalidate: () => {
          title.invalidate()
          preview.invalidate()
        },
      }
    },
    renderResult({ details }, { expanded, isPartial }, theme, context) {
      const metadata: Array<[string, string]> = []
      if (details.cwd !== undefined && details.cwd !== context.cwd) {
        metadata.push(['cwd', details.cwd])
      }
      if (details.model !== undefined) {
        metadata.push(['model', details.model])
      }
      if (details.sessionId !== undefined) {
        // Never a prefix: uuidv7 ids share their leading digits across a batch.
        metadata.push(['session', details.sessionId])
      }

      const metadataBlock = pipe(
        metadata,
        Array.map(
          ([label, value]) =>
            theme.fg('dim', String.padEnd(METADATA_LABEL_WIDTH)(label)) +
            theme.fg('muted', value),
        ),
        Array.join('\n'),
      )

      if (isPartial) {
        return new Text(metadataBlock ? `\n${metadataBlock}` : '', 0, 0)
      }

      const failed = details.failed === true
      const stats = formatStats(details)
      let status = failed ? theme.fg('error', '✗') : theme.fg('success', '✓')
      if (stats) {
        status += ` ${theme.fg('muted', stats)}`
      }

      const content =
        details.output ||
        (failed ? String.trim(details.stderr ?? '') : '') ||
        '(no output)'

      let header = metadataBlock ? `\n${metadataBlock}\n\n${status}` : `\n${status}`
      if (failed && details.errorMessage && details.errorMessage !== content) {
        header += `\n${theme.fg('error', `Error: ${details.errorMessage}`)}`
      }

      return new Ui.ExpandableText({
        header,
        content: expanded ? content : Ui.truncatedText(truncateHead(content)),
        maxLines: OUTPUT_PREVIEW_LINES,
        expanded,
        theme,
      })
    },
  })
}
