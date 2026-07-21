/**
 * Kurt Klaw startup banner.
 *
 * Renders a branded splash as a durable custom entry when pi starts fresh.
 * The splash is visible in the transcript, but stays out of LLM context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const TYPE = "kurt-klaw-banner";

// Generated via: npx oh-my-logo "Kurt" sunset --filled --block-font block --no-color
//               npx oh-my-logo "Klaw" sunset --filled --block-font block --no-color
const LOGO = [
	" ██╗  ██╗ ██╗   ██╗ ██████╗  ████████╗",
	" ██║ ██╔╝ ██║   ██║ ██╔══██╗ ╚══██╔══╝",
	" █████╔╝  ██║   ██║ ██████╔╝    ██║",
	" ██╔═██╗  ██║   ██║ ██╔══██╗    ██║",
	" ██║  ██╗ ╚██████╔╝ ██║  ██║    ██║",
	" ╚═╝  ╚═╝  ╚═════╝  ╚═╝  ╚═╝    ╚═╝",
	"",
	" ██╗  ██╗ ██╗       █████╗  ██╗    ██╗",
	" ██║ ██╔╝ ██║      ██╔══██╗ ██║    ██║",
	" █████╔╝  ██║      ███████║ ██║ █╗ ██║",
	" ██╔═██╗  ██║      ██╔══██║ ██║███╗██║",
	" ██║  ██╗ ███████╗ ██║  ██║ ╚███╔███╔╝",
	" ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝  ╚══╝╚══╝",
] as const;

export default function kurtKlawBanner(pi: ExtensionAPI) {
	pi.registerEntryRenderer(TYPE, (_entry, _options, theme) => {
		const lines = [
			theme.fg("accent", LOGO[0]),
			theme.fg("accent", LOGO[1]),
			theme.fg("success", LOGO[2]),
			theme.fg("success", LOGO[3]),
			theme.fg("warning", LOGO[4]),
			theme.fg("warning", LOGO[5]),
			LOGO[6], // blank line between words
			theme.fg("accent", LOGO[7]),
			theme.fg("accent", LOGO[8]),
			theme.fg("success", LOGO[9]),
			theme.fg("success", LOGO[10]),
			theme.fg("warning", LOGO[11]),
			theme.fg("warning", LOGO[12]),
		];
		return new Text(lines.join("\n"), 0, 0);
	});

	// Backward-compat cleanup for older sessions that already stored the banner
	// as a custom message instead of a custom entry.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(m: Record<string, unknown>) => !("customType" in m && m.customType === TYPE),
		);
		return { messages: filtered };
	});

	pi.on("session_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.reason !== "startup" && event.reason !== "new" && event.reason !== "fork") return;
		pi.appendEntry(TYPE);
	});
}
