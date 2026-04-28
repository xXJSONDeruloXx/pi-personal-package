/**
 * Poe OAuth implementation for pi's /login flow.
 *
 * Poe uses OAuth 2.0 Authorization Code Grant with mandatory PKCE.
 * The flow returns an API key (not a traditional access/refresh token pair),
 * so we adapt it to pi's OAuthCredentials shape.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { PoeClient } from "./poe-client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTHORIZE_URL = "https://poe.com/oauth/authorize";
const DEFAULT_SCOPE = "apikey:create";

/** Get the Poe OAuth client ID from env or config */
function getClientId(): string | undefined {
	return process.env.POE_CLIENT_ID?.trim() || undefined;
}

/** Get the redirect URI for the local callback server */
function getRedirectUri(port: number): string {
	return `http://127.0.0.1:${port}/callback`;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** Generate PKCE code_verifier and code_challenge (S256) */
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

/** Base64url encode without padding */
function base64UrlEncode(buffer: Uint8Array): string {
	return btoa(String.fromCharCode(...buffer))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Local callback server
// ---------------------------------------------------------------------------

/**
 * Start a temporary HTTP server on a random port to receive the OAuth callback.
 * Returns the server and the chosen port.
 */
function startCallbackServer(): Promise<{ server: import("http").Server; port: number; codePromise: Promise<string> }> {
	let resolveCode: (code: string) => void;
	const codePromise = new Promise<string>((resolve) => { resolveCode = resolve; });

	// Try Node.js http module first
	try {
		const http = require("http") as typeof import("http");
		const server = http.createServer((req, res) => {
			const url = new URL(req.url!, `http://127.0.0.1`);
			if (url.pathname === "/callback") {
				const code = url.searchParams.get("code");
				if (code) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");
					resolveCode(code);
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<h1>Authorization failed</h1><p>No code received.</p>");
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		return new Promise((resolve, reject) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as import("net").AddressInfo;
				resolve({ server, port: addr.port, codePromise });
			});
			server.on("error", reject);
		});
	} catch {
		throw new Error("Could not start local callback server. Node.js http module not available.");
	}
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

/**
 * Implement the Poe OAuth login flow.
 *
 * 1. Generate PKCE verifier/challenge
 * 2. Start a local callback server
 * 3. Open the browser via callbacks.onAuth()
 * 4. Wait for the redirect callback with the auth code
 * 5. Exchange the code for an API key
 * 6. Return OAuthCredentials
 */
export async function loginPoe(callbacks: OAuthLoginCallbacks, client: PoeClient): Promise<OAuthCredentials> {
	const clientId = getClientId();

	// If no OAuth client configured, offer API key entry (the common path)
	if (!clientId) {
		const key = await callbacks.onPrompt({
			message:
				"Enter your Poe API key (from https://poe.com/api/keys)." +
				"\nFor browser OAuth, set POE_CLIENT_ID (from https://poe.com/api/clients) and run /login poe again.",
		});
		if (!key) throw new Error("Poe API key is required.");
		client.setApiKey(key.trim());
		return {
			access: key.trim(),
			refresh: "",
			expires: 0, // no expiry when manually entered
		};
	}

	// PKCE generation
	const { verifier, challenge } = await generatePKCE();

	// Start callback server
	const { server, port, codePromise } = await startCallbackServer();
	const redirectUri = getRedirectUri(port);

	// Build authorization URL
	const authParams = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: DEFAULT_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

	// Open browser
	callbacks.onAuth({ url: authUrl });

	// Wait for callback
	const code = await codePromise;

	// Close the server
	try {
		if ("close" in server && typeof server.close === "function") {
			server.close();
		}
	} catch { /* ignore */ }

	// Exchange code for API key
	const tokenResponse = await client.exchangeCode({
		clientId,
		code,
		redirectUri,
		codeVerifier: verifier,
	});

	const apiKey = tokenResponse.api_key;
	const expiresAt = tokenResponse.api_key_expires_in
		? Date.now() + tokenResponse.api_key_expires_in * 1000
		: 0;

	client.setApiKey(apiKey);

	return {
		access: apiKey,
		refresh: "", // Poe doesn't provide a refresh token
		expires: expiresAt,
	};
}

/**
 * Attempt to refresh Poe credentials.
 * Since Poe doesn't document a refresh flow, we check if the key is still valid.
 * If expired, this throws, prompting a re-login.
 */
export async function refreshPoeToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	// If not expired, return as-is
	if (credentials.expires === 0 || credentials.expires > Date.now()) {
		return credentials;
	}

	// Poe doesn't document a refresh token grant
	throw new Error("Poe API key has expired. Please run /login poe again.");
}

/** Extract the API key from stored credentials */
export function getPoeApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
