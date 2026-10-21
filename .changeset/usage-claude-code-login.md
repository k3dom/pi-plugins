---
'@pi-plugins/usage': minor
---

Read the limits of `claude-cli` models from Claude Code's login, the account those
requests are billed to, instead of pi's Anthropic login. The widget now shows the right
account after switching accounts in Claude Code, and pi needs no Claude sign-in of its
own. With the `claude-cli` provider loaded, `/usage` adds a Claude Code section and
leaves out the Claude section unless pi has its own Claude sign-in. Claude Code's login
is only read, never renewed, and on macOS, where it lives in the Keychain, it is not
read yet.
