export const PI_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

export const CLAUDE_PREAMBLE = PI_PREAMBLE.replace(
  'inside pi,',
  'inside Claude Code,',
)

export const piDocsSection = (root: string) =>
  `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${root}/README.md
- Additional docs: ${root}/docs
- Examples: ${root}/examples (extensions, custom tools, SDK)`

export const NIX_INSTALL_ROOT = '/nix/store/abc-pi-0.86.0/lib/pi'

export const cacheControls = (node: unknown, found: unknown[] = []): unknown[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => cacheControls(child, found))
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'cache_control') {
        found.push(value)
      } else {
        cacheControls(value, found)
      }
    }
  }
  return found
}
