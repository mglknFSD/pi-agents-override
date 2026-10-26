# pi-override-agents

A [pi](https://github.com/earendil-works/pi-coding-agent) package that lets you replace the
default project context (`AGENTS.md` / `CLAUDE.md`) with any markdown file, on a per-invocation
basis, via a single `--override-agents <path>` flag.

Useful when you want to run pi in a repository but give the agent a different set of project
instructions — e.g. per-task instruction files, generated playbooks, or test fixtures — without
touching the repo's actual `AGENTS.md`.

## Install

```sh
# from npm (once published)
pi install npm:pi-override-agents

# from git
pi install git:github.com/mglknFSD/pi-agents-override

# from a local path
pi install ./pi-agents-override
```

Requires `@earendil-works/pi-coding-agent` as the host (declared in `peerDependencies`).

## Usage

```sh
pi --override-agents ./SOME_AGENTS.md
```

- Relative paths resolve against the current working directory.
- The file must exist and be a regular file; otherwise pi exits with an error before the session
  starts (the terminal is restored to a sane state first).
- Without the flag, pi behaves exactly as usual — the extension is a no-op.
- Works across `startup`, `reload`, `new`, `resume`, and `fork` session lifecycles.

What the agent sees: the default `<project_context>` block that pi renders from
`AGENTS.md`/`CLAUDE.md` is replaced with a block containing only your file, labeled with its
resolved absolute path. If the project has no `AGENTS.md`/`CLAUDE.md` at all, the block is
appended instead.

## How it works

The extension (`extensions/override-agents.ts`):

1. **Registers the flag** — `pi.registerFlag("override-agents", ...)` adds a string CLI flag.
2. **Validates on `session_start`** — on `startup` and `reload` the file is resolved, checked,
   and loaded; other reasons (`new`, `resume`, `fork`) reuse the already-loaded override.
   A UI notification confirms which file is in use.
3. **Swaps the context on `before_agent_start`** — two mechanisms, belt and suspenders:
   - Mutates `systemPromptOptions.contextFiles` so pi versions/paths that rebuild the prompt
     from it (later handlers, cache warming, `/compact`) stay consistent.
   - Returns an explicit `systemPrompt` override with the rendered `<project_context>` block
     replaced — honored by every pi version.
4. **Exits cleanly on bad input** — before a hard `process.exit()`, the terminal is restored
   (raw mode off, Kitty keyboard enhancements popped, bracketed paste/mouse tracking disabled)
   and pending terminal-query responses are drained, so the parent shell isn't left reading
   raw escape sequences.

## Development

```sh
npm install
```

### E2E test

The `e2e/` directory contains a scratch extension (`verify-context.ts`) that dumps the system
prompt as JSON and a sample override file (`MAESTRO_AGENTS.md`, containing the marker
`MAESTRO_OVERRIDE_CONTEXT_12345`). Run pi from the project root with the local package
(wired via `.pi/settings.json`) and the flag:

```sh
pi --extension ./e2e/verify-context.ts --override-agents ./e2e/MAESTRO_AGENTS.md
```

The printed `systemPrompt` should contain `MAESTRO_OVERRIDE_CONTEXT_12345` and **not** the
default `AGENTS.md` content (marker `DEFAULT_AGENTS_CONTEXT_67890`).

## Publish

This package is listed on [pi.dev/packages](https://pi.dev/packages) when published to npm with the `pi-package` keyword and a valid `pi` manifest (already configured in `package.json`).

```sh
npm login
npm run typecheck
npm pack --dry-run   # should list only extensions/, README.md, LICENSE
npm publish
```

After publish, install with `pi install npm:pi-override-agents`.

## License

ISC — see [LICENSE](./LICENSE).
