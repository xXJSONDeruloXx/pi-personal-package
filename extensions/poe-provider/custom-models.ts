/**
 * Custom/community bot model management for Poe provider.
 *
 * Stores user-added custom bot IDs that may not appear in the official
 * Poe model catalog, allowing them to be used via the Poe API.
 */

import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

// Use pi's standard agent config directory
const CONFIG_DIR = join(homedir(), ".pi", "agent", "poe-provider");
const CUSTOM_MODELS_FILE = join(CONFIG_DIR, "custom-models.json");

export interface CustomModelsConfig {
	/** Custom bot IDs added by the user */
	models: string[];
	/** When the config was last modified */
	lastModified: string;
}

const DEFAULT_CONFIG: CustomModelsConfig = {
	models: [],
	lastModified: new Date().toISOString(),
};

/**
 * Load custom model IDs from the config file.
 * Returns empty array if file doesn't exist or is malformed.
 */
export async function loadCustomModels(): Promise<string[]> {
	try {
		const data = await readFile(CUSTOM_MODELS_FILE, "utf-8");
		const config: CustomModelsConfig = JSON.parse(data);
		return Array.isArray(config.models) ? config.models : [];
	} catch {
		// File doesn't exist or is malformed - return empty
		return [];
	}
}

/**
 * Save a new custom model ID to the config file.
 * Deduplicates with existing entries.
 */
export async function saveCustomModel(modelId: string): Promise<void> {
	// Ensure config directory exists
	await mkdir(CONFIG_DIR, { recursive: true });

	// Load existing or create fresh
	let config: CustomModelsConfig;
	try {
		const data = await readFile(CUSTOM_MODELS_FILE, "utf-8");
		config = JSON.parse(data);
	} catch {
		config = { ...DEFAULT_CONFIG };
	}

	// Deduplicate and add new model
	const existing = Array.isArray(config.models) ? config.models : [];
	if (!existing.includes(modelId)) {
		config.models = [...existing, modelId];
		config.lastModified = new Date().toISOString();

		await writeFile(
			CUSTOM_MODELS_FILE,
			JSON.stringify(config, null, 2),
			"utf-8"
		);
	}
}

/**
 * Remove a custom model ID from the config file.
 */
export async function removeCustomModel(modelId: string): Promise<void> {
	try {
		const data = await readFile(CUSTOM_MODELS_FILE, "utf-8");
		const config: CustomModelsConfig = JSON.parse(data);

		if (Array.isArray(config.models)) {
			config.models = config.models.filter((m) => m !== modelId);
			config.lastModified = new Date().toISOString();

			await writeFile(
				CUSTOM_MODELS_FILE,
				JSON.stringify(config, null, 2),
				"utf-8"
			);
		}
	} catch {
		// File doesn't exist - nothing to remove
	}
}
