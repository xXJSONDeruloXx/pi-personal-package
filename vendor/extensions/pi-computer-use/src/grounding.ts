/**
 * Grounding provider that uses pi-ai's `completeSimple` to call the LLM.
 * No manual HTTP, no URL construction — pi handles all provider-specific formatting.
 */
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

// ─── Value helpers ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number.parseFloat(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GroundingPoint {
	x: number;
	y: number;
}

export interface GroundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface GroundingResult {
	method: "grounding";
	provider: string;
	confidence: number;
	reason: string;
	coordinateSpace: "image_pixels";
	point: GroundingPoint;
	box?: GroundingBox;
	raw?: unknown;
}

export interface GroundingRequest {
	imageBytes: Buffer;
	imageMimeType: string;
	imageWidth?: number;
	imageHeight?: number;
	target: string;
	scope?: string;
	app?: string;
	action?: string;
	groundingMode?: "single" | "complex";
	locationHint?: string;
	captureMode?: "window" | "display";
	windowTitle?: string;
}

export interface GroundingProvider {
	ground(params: GroundingRequest): Promise<GroundingResult | undefined>;
}

// ─── Prompt building ───────────────────────────────────────────────────────

function buildGroundingPrompt(params: {
	target: string;
	scope?: string;
	app?: string;
	width?: number;
	height?: number;
	action?: string;
	locationHint?: string;
	captureMode?: string;
	windowTitle?: string;
	groundingMode?: string;
}): string {
	return [
		"You are a GUI grounding model.",
		"Ground the single best UI target in this screenshot.",
		`Action intent: ${params.action ?? "locate"}.`,
		`Target description: ${params.target}`,
		...(params.locationHint ? [`Coarse location hint: ${params.locationHint}`] : []),
		...(params.scope ? [`Scope hint: ${params.scope}`] : []),
		...(params.app ? [`App hint: ${params.app}`] : []),
		...(params.windowTitle ? [`Window title hint: ${params.windowTitle}`] : []),
		...(params.captureMode ? [`Capture mode: ${params.captureMode}.`] : []),
		...(params.width && params.height ? [`Image size: ${params.width}x${params.height} pixels.`] : []),
		`Grounding mode: ${params.groundingMode ?? "single"}.`,
		"Use only visible screenshot evidence. Do not rely on hidden accessibility labels or DOM ids.",
		'Return screenshot-relative coordinates with coordinate_space set to "image_pixels".',
		"Choose the exact point a careful operator should use for this action intent.",
		"The bbox must tightly cover the actionable/editable surface itself, not a larger container.",
		"Choose the smallest obvious actionable surface, and keep the click_point on the visible hit target.",
		"Keep the reason terse, at most 8 words.",
		"Return strict JSON only:",
		'{"status":"resolved|not_found","confidence":0.0,"reason":"short reason","coordinate_space":"image_pixels","click_point":{"x":0,"y":0},"bbox":{"x1":0,"y1":0,"x2":0,"y2":0}}',
		'Use status "resolved" when you have a best candidate and "not_found" when the target is missing or too ambiguous.',
	].join("\n");
}

// ─── Response parsing ──────────────────────────────────────────────────────

function extractJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	try { const p = JSON.parse(trimmed); if (p && typeof p === "object") return p; } catch {}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	if (fenced) { try { const p = JSON.parse(fenced.trim()); if (p && typeof p === "object") return p; } catch {} }
	const start = trimmed.indexOf("{");
	if (start >= 0) {
		let depth = 0, inStr = false, esc = false;
		for (let i = start; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (esc) { esc = false; continue; }
			if (ch === "\\" && inStr) { esc = true; continue; }
			if (ch === '"') { inStr = !inStr; continue; }
			if (inStr) continue;
			if (ch === "{") depth++;
			if (ch === "}") { depth--; if (depth === 0) {
				try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { break; }
			}}
		}
	}
	throw new Error(`Grounding response was not valid JSON: ${trimmed.slice(0, 200)}`);
}

function parseGroundingBox(payload: Record<string, unknown>): GroundingBox | undefined {
	const rawBox = asRecord(payload.bbox) ?? asRecord(payload.box);
	if (!rawBox) return undefined;
	let x1 = asNumber(rawBox.x1) ?? asNumber(rawBox.left) ?? asNumber(rawBox.x);
	let y1 = asNumber(rawBox.y1) ?? asNumber(rawBox.top) ?? asNumber(rawBox.y);
	let x2 = asNumber(rawBox.x2) ?? asNumber(rawBox.right);
	let y2 = asNumber(rawBox.y2) ?? asNumber(rawBox.bottom);
	const w = asNumber(rawBox.width), h = asNumber(rawBox.height);
	if (x2 === undefined && x1 !== undefined && w !== undefined) x2 = x1 + w;
	if (y2 === undefined && y1 !== undefined && h !== undefined) y2 = y1 + h;
	if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined;
	return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.max(1, Math.abs(x2 - x1)), height: Math.max(1, Math.abs(y2 - y1)) };
}

function parseGroundingPoint(payload: Record<string, unknown>): GroundingPoint | undefined {
	const rawPoint = asRecord(payload.click_point) ?? asRecord(payload.target_point) ?? asRecord(payload.point);
	if (!rawPoint) return undefined;
	const x = asNumber(rawPoint.x), y = asNumber(rawPoint.y);
	if (x === undefined || y === undefined) return undefined;
	return { x, y };
}

// ─── Provider creation ─────────────────────────────────────────────────────

export interface GroundingModelResolver {
	resolve(): Promise<{ model: Model<Api>; apiKey: string }>;
}

export function createGroundingProvider(resolver: GroundingModelResolver): GroundingProvider {
	return {
		async ground(params: GroundingRequest): Promise<GroundingResult | undefined> {
			const { model, apiKey } = await resolver.resolve();
			const providerName = `${model.provider}:${model.id}`;

			const prompt = buildGroundingPrompt({
				target: params.target,
				scope: params.scope,
				app: params.app,
				width: params.imageWidth,
				height: params.imageHeight,
				action: params.action,
				locationHint: params.locationHint,
				captureMode: params.captureMode,
				windowTitle: params.windowTitle,
				groundingMode: params.groundingMode,
			});

			// Use pi-ai's completeSimple — handles all provider-specific formatting
			const response = await completeSimple(model, {
				messages: [{
					role: "user",
					content: [
						{ type: "image", data: params.imageBytes.toString("base64"), mimeType: params.imageMimeType },
						{ type: "text", text: prompt },
					],
					timestamp: Date.now(),
				}],
			}, {
				apiKey,
			});

			// Extract text from response
			const textParts = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text);
			const responseText = textParts.join("\n").trim();

			if (!responseText) {
				throw new Error(`${providerName} grounding response was empty`);
			}

			const parsed = extractJsonObject(responseText);
			const status = asString(parsed.status)?.toLowerCase();
			if (status === "not_found" || asBoolean(parsed.found) === false) {
				return undefined;
			}

			const box = parseGroundingBox(parsed);
			const point = parseGroundingPoint(parsed);
			if (!point) {
				if (box) {
					return {
						method: "grounding", provider: providerName,
						confidence: asNumber(parsed.confidence) ?? 0.75,
						reason: asString(parsed.reason) ?? "matched",
						coordinateSpace: "image_pixels",
						point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
						box, raw: parsed,
					};
				}
				return undefined;
			}

			return {
				method: "grounding", provider: providerName,
				confidence: asNumber(parsed.confidence) ?? 0.75,
				reason: asString(parsed.reason) ?? "matched",
				coordinateSpace: "image_pixels",
				point, box, raw: parsed,
			};
		},
	};
}
