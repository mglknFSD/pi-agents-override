import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FLAG_NAME = "override-agents";

/** Matches the `<project_context>...</project_context>` block pi renders for AGENTS.md/CLAUDE.md content. */
const PROJECT_CONTEXT_BLOCK_RE = /<project_context>[\s\S]*?<\/project_context>/;

interface Override {
	path: string;
	content: string;
}

/** Renders the same `<project_context>` block pi's own system-prompt builder produces, but for a single file. */
function renderProjectContextBlock(override: Override): string {
	return [
		"<project_context>",
		"Project-specific instructions and guidelines:",
		"",
		`<project_instructions path="${override.path}">`,
		override.content,
		"</project_instructions>",
		"</project_context>",
	].join("\n");
}

/**
 * Returns `systemPrompt` with the default project-context block replaced by one that only
 * contains `override`. Falls back to appending the block when no project-context section
 * exists (e.g. no AGENTS.md/CLAUDE.md was found in the first place).
 *
 * We rebuild the raw prompt text (rather than only mutating `systemPromptOptions.contextFiles`)
 * because some pi versions render the system prompt before extension handlers run and only
 * honor an explicit `systemPrompt` override returned from `before_agent_start`.
 */
function applyOverrideToSystemPrompt(systemPrompt: string, override: Override): string {
	const block = renderProjectContextBlock(override);
	if (PROJECT_CONTEXT_BLOCK_RE.test(systemPrompt)) {
		return systemPrompt.replace(PROJECT_CONTEXT_BLOCK_RE, block);
	}
	return `${systemPrompt}\n\n${block}`;
}

/**
 * Best-effort, non-yielding drain of pending terminal query responses on stdin.
 *
 * pi's startup sends terminal queries (DA1 `CSI c`, Kitty protocol `CSI ?u`, window size
 * `CSI 16t`) whose responses land on stdin moments later. If `resetTerminalAndExit` calls
 * `process.exit()` before those responses arrive, they get flushed to the *parent shell*
 * instead (which reads them back as literal, half-decoded text once cooked mode resumes —
 * e.g. `7u62;22;52c23;8t`).
 *
 * We can't just `await`/`setTimeout` to wait for them: that yields to the event loop, which is
 * a real race, since pi's own startup keeps running concurrently on that same loop and can
 * render its full interactive UI (or reach its own shutdown path first) before a delayed
 * `process.exit()` lands. `Atomics.wait` on a `SharedArrayBuffer`, by contrast, blocks the
 * *thread* synchronously without ever handing control back to libuv, so pi's concurrent code
 * genuinely cannot advance during it — it's a safe way to wait a few milliseconds for the pty
 * to flush those responses.
 *
 * We also can't call a plain blocking `fs.readSync(0, ...)` to check for them per the old
 * version of this comment: on a still-blocking fd that would hang forever once no more bytes
 * are pending. So we flip the fd to non-blocking first via the stream's internal handle (the
 * same trick Node itself uses internally to toggle stdio blocking mode), poll it in short
 * bursts, and always restore blocking mode before returning — that flag lives on the shared
 * kernel file description, not on our fd alone, and this stdin fd is normally a dup of the
 * parent shell's, so leaving it non-blocking would silently break the parent shell's own reads
 * after we exit.
 */
function drainPendingTerminalResponses(maxWaitMs: number): void {
	const stdin = process.stdin as NodeJS.ReadStream & {
		_handle?: { setBlocking?: (blocking: boolean) => void };
	};
	const handle = stdin._handle;
	if (!handle || typeof handle.setBlocking !== "function") return;

	const buf = Buffer.alloc(4096);
	const sleepGate = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + maxWaitMs;

	try {
		handle.setBlocking(false);
		while (Date.now() < deadline) {
			try {
				// Reads straight from the fd, bypassing Node's stream buffering — correct here
				// because we never yield to the event loop, so libuv can't be mid-read on it.
				const n = fs.readSync(0, buf, 0, buf.length, null);
				if (n === 0) break; // EOF: nothing more will ever arrive.
				continue; // Got (and discarded) bytes; keep draining without sleeping.
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EAGAIN" && code !== "EWOULDBLOCK") break;
			}
			Atomics.wait(sleepGate, 0, 0, 2); // No data yet: real thread sleep, no event-loop turn.
		}
	} catch {
		// best-effort only
	} finally {
		try {
			handle.setBlocking(true);
		} catch {
			// best-effort only
		}
	}
}

/**
 * Restore the terminal to a sane state before a hard `process.exit()`.
 *
 * When this extension's `session_start` handler runs, pi's interactive TUI may already have
 * put the terminal into raw mode, enabled progressive enhancements (Kitty keyboard protocol,
 * bracketed paste), and sent the terminal queries drained by `drainPendingTerminalResponses`
 * above — but it has not yet entered the alternate screen buffer at this point (confirmed
 * empirically: no `CSI ?1049h` is sent before `session_start` fires). `process.exit()` skips
 * pi's normal shutdown path (which emits the matching disable sequences before exiting), so
 * calling it directly leaves the parent shell reading raw escape sequences as literal text:
 * every subsequent keystroke misdecoded.
 *
 * Only undo modes pi has actually turned on by this point. In particular, do NOT blindly send
 * `CSI ?1049l` ("exit alt screen, restore saved cursor position") — since pi never entered alt
 * screen yet, that DEC private mode reset can resurrect an unrelated stale cursor position saved
 * by some earlier program in this same terminal tab, which visually overwrites/erases the error
 * message this function is trying to print.
 */
function resetTerminalAndExit(exitCode: number): never {
	if (process.stdout.isTTY) {
		try {
			process.stdout.write(
				"\x1b[?25h" + // show cursor
					"\x1b[?2004l" + // disable bracketed paste
					"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // disable mouse tracking
					"\x1b[<u\x1b[<u\x1b[<u", // pop Kitty keyboard protocol enhancement (stack-safe)
			);
		} catch {
			// best-effort only
		}
	}
	const stdin = process.stdin;
	if (stdin.isTTY && typeof stdin.setRawMode === "function") {
		try {
			// Swallow the DA1/Kitty/window-size query responses pi's startup triggered before
			// they can reach the parent shell (see drainPendingTerminalResponses for why this
			// is safe to do without racing pi's own concurrent startup).
			drainPendingTerminalResponses(30);
			// Return stdin to cooked mode so the parent shell reads normal line-buffered
			// input again instead of raw per-keystroke escape sequences.
			stdin.setRawMode(false);
		} catch {
			// best-effort only
		}
	}
	process.exit(exitCode);
}

function loadOverride(cwd: string, rawPath: string): Override {
	const resolved = path.resolve(cwd, rawPath);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		console.error(`[override-agents] Error: --override-agents path not found: ${resolved}`);
		resetTerminalAndExit(1);
	}
	if (!stat.isFile()) {
		console.error(`[override-agents] Error: --override-agents path is not a file: ${resolved}`);
		resetTerminalAndExit(1);
	}

	const content = fs.readFileSync(resolved, "utf-8");
	return { path: resolved, content };
}

export default function overrideAgentsExtension(pi: ExtensionAPI) {
	pi.registerFlag(FLAG_NAME, {
		description:
			"Replace default AGENTS.md/CLAUDE.md project context with the markdown file at <path>. Relative paths resolve against cwd.",
		type: "string",
	});

	let override: Override | null = null;

	pi.on("session_start", async (event, ctx) => {
		// Re-validate on "startup" (process launch) and "reload" (/reload re-runs extension
		// factories with a fresh closure, so `override` would otherwise be lost). "new",
		// "resume", and "fork" reuse the already-loaded extension instance, so `override`
		// from the initial load is still valid and doesn't need to be recomputed.
		if (event.reason !== "startup" && event.reason !== "reload") return;

		const raw = pi.getFlag(FLAG_NAME) as string | undefined;
		if (!raw) return;

		override = loadOverride(ctx.cwd, raw);
		ctx.ui.notify(
			`[override-agents] Using ${override.path} instead of default AGENTS.md/CLAUDE.md`,
			"info",
		);
	});

	pi.on("before_agent_start", async (event) => {
		if (!override) return;

		// Best-effort: keep systemPromptOptions.contextFiles consistent for pi versions/paths
		// that rebuild the prompt from it (e.g. later handlers, cache-warming, /compact).
		const files = event.systemPromptOptions.contextFiles;
		if (files) {
			files.length = 0;
			files.push(override);
		} else {
			event.systemPromptOptions.contextFiles = [override];
		}

		// Authoritative fix: explicitly replace the rendered system prompt for this turn.
		// This is honored by every pi version, unlike the contextFiles mutation above.
		return { systemPrompt: applyOverrideToSystemPrompt(event.systemPrompt, override) };
	});
}
