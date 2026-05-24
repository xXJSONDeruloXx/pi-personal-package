import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES_DIR = path.join(ROOT, "node_modules");
const VENDOR_EXTENSIONS_DIR = path.join(ROOT, "vendor", "extensions");

const PACKAGES = [
	{
		source: "@0xkobold/pi-autoupdate",
		dest: "pi-autoupdate",
		rootPatterns: [/^index\.ts$/, /^package\.json$/],
	},
	{
		source: "@ifi/pi-extension-subagents",
		dest: "pi-extension-subagents",
		rootPatterns: [/\.ts$/, /^package\.json$/],
		paths: ["agents"],
	},
	{
		source: "@tmustier/pi-files-widget",
		dest: "pi-files-widget",
		rootPatterns: [/\.ts$/, /^package\.json$/],
	},
	{
		source: "@tmustier/pi-ralph-wiggum",
		dest: "pi-ralph-wiggum",
		rootPatterns: [/^index\.ts$/, /^SKILL\.md$/, /^package\.json$/],
	},
	{
		source: "pi-command-center",
		dest: "pi-command-center",
		rootPatterns: [/^package\.json$/],
		paths: ["extensions/command-center"],
	},
	{
		source: "pi-hide-messages",
		dest: "pi-hide-messages",
		rootPatterns: [/^config\.json$/, /^index\.ts$/, /^package\.json$/],
		paths: ["config", "src"],
	},
	{
		source: "pi-interactive-shell",
		dest: "pi-interactive-shell",
		rootPatterns: [/\.ts$/, /^package\.json$/, /^SKILL\.md$/],
		paths: ["examples/skills", "scripts"],
	},
	{
		source: "pi-stash",
		dest: "pi-stash",
		rootPatterns: [/^package\.json$/],
		paths: ["src"],
	},
	{
		source: "pi-tool-display",
		dest: "pi-tool-display",
		rootPatterns: [/^index\.ts$/, /^package\.json$/],
		paths: ["config", "src"],
	},
];

function copyPath(sourcePath, destinationPath) {
	mkdirSync(path.dirname(destinationPath), { recursive: true });
	cpSync(sourcePath, destinationPath, { recursive: true });
}

function syncPackage({ source, dest, rootPatterns = [], paths = [] }) {
	const sourceDir = path.join(NODE_MODULES_DIR, source);
	if (!existsSync(sourceDir)) {
		throw new Error(`Missing source package: ${source}`);
	}

	const destinationDir = path.join(VENDOR_EXTENSIONS_DIR, dest);
	rmSync(destinationDir, { recursive: true, force: true });
	mkdirSync(destinationDir, { recursive: true });

	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (!rootPatterns.some((pattern) => pattern.test(entry.name))) continue;
		copyPath(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name));
	}

	for (const relativePath of paths) {
		const sourcePath = path.join(sourceDir, relativePath);
		if (!existsSync(sourcePath)) {
			throw new Error(`Missing path "${relativePath}" in ${source}`);
		}
		copyPath(sourcePath, path.join(destinationDir, relativePath));
	}
}

mkdirSync(VENDOR_EXTENSIONS_DIR, { recursive: true });
for (const pkg of PACKAGES) {
	syncPackage(pkg);
}

console.log(`Synced ${PACKAGES.length} vendored extension packages into ${path.relative(ROOT, VENDOR_EXTENSIONS_DIR)}`);
