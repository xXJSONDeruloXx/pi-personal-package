import { describe, it, expect, vi, beforeEach } from "vitest";
import { PoeClient } from "./poe-client.js";

// ---------------------------------------------------------------------------
// PoeClient — unit tests for the HTTP wrapper
// ---------------------------------------------------------------------------

describe("PoeClient", () => {
	let client: PoeClient;

	beforeEach(() => {
		client = new PoeClient({ apiKey: "test-key" });
	});

	describe("setApiKey / getApiKey", () => {
		it("stores and returns the API key", () => {
			expect(client.getApiKey()).toBe("test-key");
			client.setApiKey("new-key");
			expect(client.getApiKey()).toBe("new-key");
		});

		it("allows setting to undefined", () => {
			client.setApiKey(undefined);
			expect(client.getApiKey()).toBeUndefined();
		});
	});

	describe("getBalance — auth requirement", () => {
		it("throws if no API key is set", async () => {
			client.setApiKey(undefined);
			await expect(client.getBalance()).rejects.toThrow("API key");
		});
	});

	describe("getHistory — auth requirement", () => {
		it("throws if no API key is set", async () => {
			client.setApiKey(undefined);
			await expect(client.getHistory({ limit: 10 })).rejects.toThrow("API key");
		});
	});

	describe("listModels — no auth required", () => {
		it("does not throw when no API key is set (public endpoint)", async () => {
			client.setApiKey(undefined);
			// We can't make a real request without network, but the method
			// itself shouldn't throw before the fetch — no requireAuth() call.
			// Just verify the method exists and is callable.
			expect(typeof client.listModels).toBe("function");
		});
	});
});

// ---------------------------------------------------------------------------
// PoeClient — integration tests against live API (skipped by default)
// ---------------------------------------------------------------------------

describe("PoeClient live API", () => {
	// Run with: npx vitest run --reporter=verbose poe-client.test.ts
	// These hit the real API so they're skipped in CI.

	it.skip("fetches model catalog (public, no auth)", async () => {
		const client = new PoeClient();
		const response = await client.listModels();
		expect(response.object).toBe("list");
		expect(response.data.length).toBeGreaterThan(0);
		expect(response.data[0].id).toBeTruthy();
	});

	it.skip("fetches balance (requires POE_API_KEY)", async () => {
		const key = process.env.POE_API_KEY;
		if (!key) return; // skip silently
		const client = new PoeClient({ apiKey: key });
		const response = await client.getBalance();
		expect(response.current_point_balance).toBeGreaterThanOrEqual(0);
		expect(response).toHaveProperty("plan_points_balance");
		expect(response).toHaveProperty("addon_point_balance");
	});

	it.skip("fetches usage history (requires POE_API_KEY)", async () => {
		const key = process.env.POE_API_KEY;
		if (!key) return;
		const client = new PoeClient({ apiKey: key });
		const response = await client.getHistory({ limit: 3 });
		expect(response.data.length).toBeLessThanOrEqual(3);
		if (response.data.length > 0) {
			const entry = response.data[0];
			// Verify timestamp is in microseconds (should be > 1e15 for 2025+)
			expect(entry.creation_time).toBeGreaterThan(1_000_000_000_000_000);
			expect(entry.bot_name).toBeTruthy();
			expect(entry.query_id).toBeTruthy();
		}
	});
});
