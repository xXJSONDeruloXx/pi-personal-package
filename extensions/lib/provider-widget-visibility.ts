import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProviderWidgetVisibility = "auto" | "always" | "hidden";

export const PROVIDER_WIDGET_VISIBILITY_SETTINGS_KEY = "pi-provider-widgets";
export const PROVIDER_WIDGET_VISIBILITY_EVENT = "provider-widgets:visibility";

const SETTINGS_FILE = path.join(
	process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"),
	"settings.json",
);

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function normalizeProviderWidgetVisibility(value: unknown): ProviderWidgetVisibility | null {
	if (value === "auto" || value === "always" || value === "hidden") return value;
	return null;
}

export function getEffectiveProviderWidgetVisibility(
	localVisibility: ProviderWidgetVisibility,
	globalVisibility: ProviderWidgetVisibility | null,
): ProviderWidgetVisibility {
	return globalVisibility ?? localVisibility;
}

export async function readSettings(): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return asObject(parsed) ?? {};
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw e;
	}
}

export async function writeSettings(settings: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
	await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function loadGlobalProviderWidgetVisibility(): Promise<ProviderWidgetVisibility | null> {
	const settings = await readSettings();
	const providerWidgets = asObject(settings[PROVIDER_WIDGET_VISIBILITY_SETTINGS_KEY]);
	return normalizeProviderWidgetVisibility(providerWidgets?.visibility);
}

export async function persistGlobalProviderWidgetVisibility(
	visibility: ProviderWidgetVisibility,
): Promise<void> {
	const settings = await readSettings();
	const providerWidgets = asObject(settings[PROVIDER_WIDGET_VISIBILITY_SETTINGS_KEY]) ?? {};
	providerWidgets.visibility = visibility;
	settings[PROVIDER_WIDGET_VISIBILITY_SETTINGS_KEY] = providerWidgets;
	await writeSettings(settings);
}

export function parseProviderWidgetVisibilityArg(
	args: string,
	current: ProviderWidgetVisibility,
): ProviderWidgetVisibility | null {
	const token = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
	if (!token || token === "toggle") {
		const cycle: ProviderWidgetVisibility[] = ["auto", "always", "hidden"];
		const idx = cycle.indexOf(current);
		return cycle[(idx + 1) % cycle.length];
	}
	return normalizeProviderWidgetVisibility(token);
}

export function getProviderWidgetVisibilityCompletions(prefix: string) {
	const p = prefix.trim().toLowerCase();
	const items = [
		{ value: "auto", label: "auto", description: "Each widget shows only for its provider" },
		{ value: "always", label: "always", description: "Show all provider widgets regardless of model" },
		{ value: "hidden", label: "hidden", description: "Hide all provider widgets" },
		{ value: "toggle", label: "toggle", description: "Cycle auto → always → hidden" },
	];
	if (!p) return items;
	const filtered = items.filter((i) => i.value.startsWith(p));
	return filtered.length > 0 ? filtered : null;
}
