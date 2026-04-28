/**
 * Kurt Klaw startup banner.
 *
 * Renders a branded ASCII art splash as the very first message in the
 * conversation each time pi launches fresh (session_start reason: "startup").
 *
 * Uses pi's custom message renderer so the banner sits inline in the
 * chat history at the top, not as a widget or overlay.
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
	pi.registerMessageRenderer(TYPE, (_message, _options, theme) => {
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
			"",
			theme.fg("muted", "pi personal package"),
		];
		return new Text(lines.join("\n"), 0, 0);
	});

	// Filter the banner out of LLM context so it doesn't consume tokens.
	// The message still appears in the TUI via the custom renderer,
	// but the context hook strips it before it reaches the provider.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(m: Record<string, unknown>) => !("customType" in m && m.customType === TYPE),
		);
		return { messages: filtered };
	});

	pi.on("session_start", (event) => {
		if (event.reason !== "startup" && event.reason !== "new") return;
		pi.sendMessage({ customType: TYPE, content: "Kurt Klaw", display: true });
	});
}
