// Stands in for the `claude` CLI: answers its input with the lines of the
// next reply in FAKE_CLAUDE_REPLIES and records what it was given to
// FAKE_CLAUDE_LOG. Like the real CLI, it keeps running until it is stopped.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const counter = `${process.env.FAKE_CLAUDE_LOG}.count`
const run = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(run + 1))
const replies = JSON.parse(process.env.FAKE_CLAUDE_REPLIES)
const reply = replies[Math.min(run, replies.length - 1)]
const log = {
  args,
  env: process.env,
  systemPrompt: readFileSync(option('--system-prompt-file'), 'utf8'),
  settings: JSON.parse(readFileSync(option('--settings'), 'utf8')),
  input: [],
}
const print = (line) => process.stdout.write(`${JSON.stringify(line)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  log.input.push(JSON.parse(line))
  writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(log))
  reply.lines.forEach(print)
  if (reply.exitCode !== undefined) {
    process.exit(reply.exitCode)
  }
})
setInterval(() => {}, 1000)
