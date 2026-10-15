// Stands in for the `claude` CLI. It answers its input with the lines of the
// next reply in FAKE_CLAUDE_REPLIES, `delayMs` apart, records what it was
// given to FAKE_CLAUDE_LOG, and adds its pid to FAKE_CLAUDE_LOG.stopped when it
// is stopped. Like the real CLI, it applies settings from control requests,
// refuses them with the reply's `settingsError`, and keeps running until it is
// stopped.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

process.on('SIGTERM', () => {
  appendFileSync(`${process.env.FAKE_CLAUDE_LOG}.stopped`, `${process.pid}\n`)
  process.exit(0)
})

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const counter = `${process.env.FAKE_CLAUDE_LOG}.count`
const run = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(run + 1))
const replies = JSON.parse(process.env.FAKE_CLAUDE_REPLIES)
const reply = replies[Math.min(run, replies.length - 1)]
const log = {
  pid: process.pid,
  startedAt: Date.now(),
  args,
  env: process.env,
  systemPrompt: readFileSync(option('--system-prompt-file'), 'utf8'),
  settings: {},
  input: [],
}
const print = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const { request_id } = message
    if (reply.settingsError === undefined) {
      Object.assign(log.settings, message.request.settings)
    }
    writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(log))
    print({
      type: 'control_response',
      response:
        reply.settingsError === undefined
          ? { subtype: 'success', request_id }
          : { subtype: 'error', request_id, error: reply.settingsError },
    })
    return
  }
  log.input.push(message)
  writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(log))
  const delayMs = reply.delayMs ?? 0
  reply.lines.forEach((next, index) =>
    setTimeout(() => print(next), index * delayMs),
  )
  if (reply.exitCode !== undefined) {
    setTimeout(() => process.exit(reply.exitCode), reply.lines.length * delayMs)
  }
})
setInterval(() => {}, 1000)
