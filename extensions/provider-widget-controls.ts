import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	PROVIDER_WIDGET_VISIBILITY_EVENT,
	getProviderWidgetVisibilityCompletions,
	loadGlobalProviderWidgetVisibility,
	parseProviderWidgetVisibilityArg,
	persistGlobalProviderWidgetVisibility,
	type ProviderWidgetVisibility,
} from "./lib/provider-widget-visibility";

export default function providerWidgetControls(pi: ExtensionAPI) {
	let currentVisibility: ProviderWidgetVisibility = "auto";

	const loadCurrent = async (ctx?: ExtensionContext) => {
		try {
			currentVisibility = (await loadGlobalProviderWidgetVisibility()) ?? "auto";
		} catch (error) {
			if (ctx?.hasUI) {
				ctx.ui.notify(
					`Provider widgets: failed to load global visibility: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await loadCurrent(ctx);
		pi.events.emit(PROVIDER_WIDGET_VISIBILITY_EVENT, { visibility: currentVisibility });
	});

	pi.registerCommand("provider-widget-visibility", {
		description: "Set all provider widget visibilities at once: auto | always | hidden",
		getArgumentCompletions: getProviderWidgetVisibilityCompletions,
		handler: async (args, ctx) => {
			await loadCurrent(ctx);
			const next = parseProviderWidgetVisibilityArg(args, currentVisibility);
			if (!next) return;
			currentVisibility = next;
			await persistGlobalProviderWidgetVisibility(currentVisibility);
			pi.events.emit(PROVIDER_WIDGET_VISIBILITY_EVENT, { visibility: currentVisibility });
			ctx.ui.notify(`Provider widgets: ${currentVisibility}`, "info");
		},
	});
}
