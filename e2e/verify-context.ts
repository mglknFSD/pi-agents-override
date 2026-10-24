import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function verifyContextExtension(pi: ExtensionAPI) {
	pi.on("agent_start", async (_event, ctx) => {
		console.log(JSON.stringify({ systemPrompt: ctx.getSystemPrompt() }));
		process.exit(0);
	});
}
