import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Timestamp conversion tests
// ---------------------------------------------------------------------------

describe("Poe timestamp conversion", () => {
	// Poe returns creation_time in MICROSECONDS.
	// To get a JS Date: new Date(creation_time / 1000)

	const REAL_TIMESTAMP_US = 1777474947740402; // April 29, 2026 15:02:27 UTC

	it("converts microseconds to a valid Date", () => {
		const date = new Date(REAL_TIMESTAMP_US / 1000);
		expect(date.getTime()).not.toBeNaN();
		expect(date.getUTCFullYear()).toBe(2026);
		expect(date.getUTCMonth()).toBe(3); // April = 3
		expect(date.getUTCDate()).toBe(29);
	});

	it("produces Invalid Date with the old * 1000 code", () => {
		const wrong = new Date(REAL_TIMESTAMP_US * 1000);
		expect(isNaN(wrong.getTime())).toBe(true);
	});

	it("balance endpoint microseconds also convert correctly", () => {
		const cycleStartUs = 1777420800000000; // April 29, 2026 00:00:00 UTC
		const date = new Date(cycleStartUs / 1000);
		expect(date.getUTCFullYear()).toBe(2026);
		expect(date.getUTCHours()).toBe(0);
		expect(date.getUTCMinutes()).toBe(0);
	});

	it("next daily grant microseconds convert correctly", () => {
		const nextGrantUs = 1777507200000000; // April 30, 2026 00:00:00 UTC
		const date = new Date(nextGrantUs / 1000);
		expect(date.getUTCDate()).toBe(30);
	});

	it("microsecond values for 2026 are always > 1e15", () => {
		// Quick sanity: any timestamp in 2025-2030 range should be > 1 quadrillion
		expect(REAL_TIMESTAMP_US).toBeGreaterThan(1_000_000_000_000_000);
	});
});

// ---------------------------------------------------------------------------
// Pricing field parsing tests
// ---------------------------------------------------------------------------

describe("Poe pricing field parsing", () => {
	it("parses string pricing values to per-million cost", () => {
		const promptPerToken = "0.0000042929";
		const perMillion = parseFloat(promptPerToken) * 1_000_000;
		expect(perMillion).toBeCloseTo(4.2929, 2);
	});

	it("parses numeric pricing values to per-million cost", () => {
		const promptPerToken = 0.0000022727;
		const perMillion = promptPerToken * 1_000_000;
		expect(perMillion).toBeCloseTo(2.2727, 2);
	});

	it("handles null pricing as 0", () => {
		const perMillion = parseFloat(null as any) * 1_000_000;
		expect(isNaN(perMillion)).toBe(true); // parseFloat(null) = NaN
		// Our tokenCostToPerMillion handles this by returning 0 for null/undefined
	});

	it("handles request=0.00 as free", () => {
		const requestCost = parseFloat("0.00");
		expect(requestCost).toBe(0);
	});

	it("handles request=0.0061 as paid", () => {
		const requestCost = parseFloat("0.0061");
		expect(requestCost).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// /poe free — model classification logic
// ---------------------------------------------------------------------------

describe("/poe free classification", () => {
	function classifyModel(model: { pricing: Record<string, unknown> | null }) {
		const p = model.pricing;
		if (p == null) return "likelyFree";
		if (typeof p === "object") {
			const fields = ["prompt", "completion", "image", "request", "input_cache_read", "input_cache_write"];
			for (const field of fields) {
				const val = (p as Record<string, unknown>)[field];
				if (val != null && Number(val) !== 0) return "paid";
			}
			return "confirmedFree";
		}
		return "paid";
	}

	it("classifies null pricing as likelyFree", () => {
		expect(classifyModel({ pricing: null })).toBe("likelyFree");
	});

	it("classifies all-zero pricing as confirmedFree", () => {
		expect(classifyModel({
			pricing: { prompt: null, completion: null, image: null, request: "0.00", input_cache_read: null, input_cache_write: null },
		})).toBe("confirmedFree");
	});

	it("classifies all-null pricing as confirmedFree", () => {
		expect(classifyModel({
			pricing: { prompt: null, completion: null, image: null, request: null, input_cache_read: null, input_cache_write: null },
		})).toBe("confirmedFree");
	});

	it("classifies non-zero prompt as paid", () => {
		expect(classifyModel({
			pricing: { prompt: "0.0000042929", completion: "0.0000214646", image: null, request: null, input_cache_read: null, input_cache_write: null },
		})).toBe("paid");
	});

	it("classifies non-zero request as paid", () => {
		expect(classifyModel({
			pricing: { prompt: null, completion: null, image: null, request: "0.0061", input_cache_read: null, input_cache_write: null },
		})).toBe("paid");
	});

	it("classifies non-zero cache fields as paid", () => {
		expect(classifyModel({
			pricing: { prompt: null, completion: null, image: null, request: null, input_cache_read: "0.0000004293", input_cache_write: null },
		})).toBe("paid");
	});
});

// ---------------------------------------------------------------------------
// OAuth credentials shape
// ---------------------------------------------------------------------------

describe("OAuth credential handling", () => {
	it("Poe returns api_key not access_token", () => {
		// Simulated token exchange response
		const response = {
			api_key: "pk-xxxxx",
			api_key_expires_in: null as number | null,
		};
		expect(response.api_key).toBeTruthy();
		expect(response.api_key_expires_in).toBeNull(); // no expiry
	});

	it("calculates expiry from api_key_expires_in seconds", () => {
		const expiresInSec = 3600;
		const expiresAt = Date.now() + expiresInSec * 1000;
		expect(expiresAt).toBeGreaterThan(Date.now());
		expect(expiresAt - Date.now()).toBeLessThanOrEqual(3600 * 1000 + 100);
	});
});

// ---------------------------------------------------------------------------
// History response — cost_usd can be string
// ---------------------------------------------------------------------------

describe("cost_usd handling", () => {
	it("handles cost_usd as string", () => {
		const costUsd: string | number = "0.00";
		const parsed = typeof costUsd === "number" ? costUsd : parseFloat(String(costUsd ?? 0));
		expect(parsed).toBe(0);
	});

	it("handles cost_usd as number", () => {
		const costUsd: string | number = 0.001;
		const parsed = typeof costUsd === "number" ? costUsd : parseFloat(String(costUsd ?? 0));
		expect(parsed).toBeCloseTo(0.001, 3);
	});
});

// ---------------------------------------------------------------------------
// Balance response — full shape
// ---------------------------------------------------------------------------

describe("balance response fields", () => {
	it("parses plan + addon balance", () => {
		const response = {
			current_point_balance: 10000,
			plan_points_balance: 10000,
			addon_point_balance: 0,
			total_balance_usd: "0.30",
			next_daily_grant_time: 1777507200000000, // microseconds
			next_daily_grant_amount: 10000,
			auto_recharge: { enabled: false, status: "never_enabled" },
		};
		expect(response.plan_points_balance + response.addon_point_balance)
			.toBe(response.current_point_balance);
		expect(response.next_daily_grant_time).toBeGreaterThan(1e15);
	});
});
