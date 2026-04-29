import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// PKCE utility tests
// ---------------------------------------------------------------------------
// generatePKCE and base64UrlEncode are private in oauth.ts, so we test
// the logic inline. The actual OAuth flow (browser redirect, callback server)
// is too integration-heavy for unit tests.

describe("PKCE utilities", () => {
	/** Base64url encode without padding — mirrors oauth.ts */
	function base64UrlEncode(buffer: Uint8Array): string {
		return btoa(String.fromCharCode(...buffer))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	/** Generate PKCE verifier and challenge — mirrors oauth.ts */
	async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		const verifier = base64UrlEncode(array);

		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const hash = await crypto.subtle.digest("SHA-256", data);
		const challenge = base64UrlEncode(new Uint8Array(hash));

		return { verifier, challenge };
	}

	it("generates verifier and challenge of correct length", async () => {
		const { verifier, challenge } = await generatePKCE();
		// 32 bytes → 43 base64url chars (no padding)
		expect(verifier.length).toBe(43);
		expect(challenge.length).toBe(43);
		// Both should be valid base64url (no +, /, =)
		expect(verifier).not.toMatch(/[+/=]/);
		expect(challenge).not.toMatch(/[+/=]/);
	});

	it("challenge is deterministic for a given verifier", async () => {
		const { verifier, challenge } = await generatePKCE();
		const encoder = new TextEncoder();
		const hash = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
		const expected = base64UrlEncode(new Uint8Array(hash));
		expect(challenge).toBe(expected);
	});

	it("produces different verifiers on each call", async () => {
		const a = await generatePKCE();
		const b = await generatePKCE();
		expect(a.verifier).not.toBe(b.verifier);
	});
});

describe("base64UrlEncode", () => {
	/** Mirrors oauth.ts implementation */
	function base64UrlEncode(buffer: Uint8Array): string {
		return btoa(String.fromCharCode(...buffer))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	it("encodes bytes without padding", () => {
		const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
		const result = base64UrlEncode(bytes);
		expect(result).toBe("SGVsbG8");
		expect(result).not.toContain("=");
	});

	it("replaces + and / with - and _", () => {
		const bytes = new Uint8Array([0xfb, 0xff]);
		const result = base64UrlEncode(bytes);
		expect(result).not.toContain("+");
		expect(result).not.toContain("/");
		expect(result).toContain("-");
		expect(result).toContain("_");
	});
});
