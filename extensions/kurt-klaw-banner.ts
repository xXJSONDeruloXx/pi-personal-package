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

// Generated via: npx oh-my-logo "Kurt Klaw" sunset --filled --block-font chrome
const LOGO = [
	"╦╔═ ╦ ╦ ╦═╗ ╔╦╗      ╦╔═ ╦   ╔═╗ ╦ ╦",
	"╠╩╗ ║ ║ ╠╦╝  ║       ╠╩╗ ║   ╠═╣ ║║║",
	"╩ ╩ ╚═╝ ╩╚═  ╩       ╩ ╩ ╩═╝ ╩ ╩ ╚╩╝",
] as const;

export default function kurtKlawBanner(pi: ExtensionAPI) {
	pi.registerMessageRenderer(TYPE, (_message, _options, theme) => {
		const lines = [
			theme.fg("accent", LOGO[0]),
			theme.fg("success", LOGO[1]),
			theme.fg("warning", LOGO[2]),
			"",
			theme.fg("muted", "pi personal package"),
		];
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("session_start", (event) => {
		if (event.reason !== "startup" && event.reason !== "new") return;
		pi.sendMessage({ customType: TYPE, content: "Kurt Klaw", display: true });
	});
}
