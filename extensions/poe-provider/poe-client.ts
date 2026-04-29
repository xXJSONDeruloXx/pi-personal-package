/**
 * Poe HTTP client for the pi-poe-provider extension.
 *
 * Wraps the Poe API endpoints used by this extension:
 * - GET /v1/models (public, no auth)
 * - GET /usage/current_balance (auth required)
 * - GET /usage/points_history (auth required)
 * - OAuth token exchange at /token
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw model object from GET /v1/models */
export interface PoeModel {
	id: string;
	name?: string;
	owned_by?: string;
	metadata?: {
		display_name?: string;
		description?: string;
	};
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	context_window?: {
		context_length?: number;
		max_output_tokens?: number;
	};
	pricing?: {
		prompt?: number | string | null;
		completion?: number | string | null;
		image?: number | string | null;
		request?: number | string | null;
		input_cache_read?: number | string | null;
		input_cache_write?: number | string | null;
		[key: string]: unknown;
	};
	reasoning?: boolean;
	/** Additional fields we don't strictly map but preserve for debugging */
	[key: string]: unknown;
}

/** Response from GET /v1/models */
export interface PoeModelsResponse {
	object: string;
	data: PoeModel[];
}

/** Response from GET /usage/current_balance */
export interface PoeBalanceResponse {
	current_point_balance: number;
	plan_points_balance?: number;
	addon_point_balance?: number;
	plan_balance_usd?: string;
	addon_balance_usd?: string;
	total_balance_usd?: string;
	/** Microseconds since epoch */
	points_cycle_start_time?: number;
	/** Microseconds since epoch */
	next_daily_grant_time?: number;
	/** Microseconds since epoch */
	next_monthly_grant_time?: number;
	next_daily_grant_amount?: number;
	next_monthly_grant_amount?: number;
	auto_recharge?: {
		enabled: boolean;
		status: string;
		threshold_points: number;
		threshold_usd: string;
		refill_points: number;
		refill_usd: string;
		last_recharge_failure_time: number | null;
	};
}

/** Single entry from GET /usage/points_history */
export interface PoeHistoryEntry {
	bot_name: string;
	/** Microseconds since epoch (not seconds!) */
	creation_time: number;
	query_id: string;
	cost_points: number;
	cost_usd: number | string;
	/** Keys are categories like "Input", "Output", "Cache write", "Cache discount", "Total"; values are strings */
	cost_breakdown_in_points?: Record<string, string>;
	usage_type: string;
	/** Present when usage_type == "Chat" */
	chat_name?: string;
	/** Present when usage_type == "Canvas App" */
	canvas_tab_name?: string;
	/** Present when usage_type == "API" */
	api_key_name?: string;
}

/** Response from GET /usage/points_history */
export interface PoeHistoryResponse {
	data: PoeHistoryEntry[];
	has_more: boolean;
	length?: number;
}

/** Token exchange response from POST /token (OAuth) */
export interface PoeTokenResponse {
	api_key: string;
	api_key_expires_in: number | null;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PoeClient {
	private readonly baseUrl: string;
	private readonly usageBaseUrl: string;
	private apiKey: string | undefined;

	constructor(options?: { apiKey?: string; baseUrl?: string }) {
		this.baseUrl = options?.baseUrl ?? "https://api.poe.com";
		this.usageBaseUrl = options?.baseUrl ?? "https://api.poe.com";
		this.apiKey = options?.apiKey;
	}

	/** Update the stored API key (e.g. after OAuth) */
	setApiKey(key: string | undefined): void {
		this.apiKey = key;
	}

	/** Get the current API key */
	getApiKey(): string | undefined {
		return this.apiKey;
	}

	// -----------------------------------------------------------------------
	// Public endpoints (no auth required)
	// -----------------------------------------------------------------------

	/** Fetch the public model catalog. No auth required. */
	async listModels(signal?: AbortSignal): Promise<PoeModelsResponse> {
		const url = `${this.baseUrl}/v1/models`;
		const res = await fetch(url, { signal });
		if (!res.ok) {
			throw new Error(`Poe list models failed: ${res.status} ${await res.text()}`);
		}
		return res.json() as Promise<PoeModelsResponse>;
	}

	// -----------------------------------------------------------------------
	// Authenticated endpoints
	// -----------------------------------------------------------------------

	/** Fetch current point balance. Requires API key. */
	async getBalance(signal?: AbortSignal): Promise<PoeBalanceResponse> {
		this.requireAuth();
		const url = `${this.usageBaseUrl}/usage/current_balance`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
			signal,
		});
		if (!res.ok) {
			throw new Error(`Poe get balance failed: ${res.status} ${await res.text()}`);
		}
		return res.json() as Promise<PoeBalanceResponse>;
	}

	/** Fetch usage history. Requires API key. */
	async getHistory(options?: { limit?: number; startingAfter?: string }, signal?: AbortSignal): Promise<PoeHistoryResponse> {
		this.requireAuth();
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.startingAfter) params.set("starting_after", options.startingAfter);
		const qs = params.toString() ? `?${params.toString()}` : "";
		const url = `${this.usageBaseUrl}/usage/points_history${qs}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
			signal,
		});
		if (!res.ok) {
			throw new Error(`Poe get history failed: ${res.status} ${await res.text()}`);
		}
		return res.json() as Promise<PoeHistoryResponse>;
	}

	// -----------------------------------------------------------------------
	// OAuth token exchange
	// -----------------------------------------------------------------------

	/** Exchange an authorization code for an API key via Poe's token endpoint. */
	async exchangeCode(params: {
		clientId: string;
		code: string;
		redirectUri: string;
		codeVerifier: string;
	}, signal?: AbortSignal): Promise<PoeTokenResponse> {
		const url = `${this.baseUrl}/token`;
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: params.clientId,
			code: params.code,
			redirect_uri: params.redirectUri,
			code_verifier: params.codeVerifier,
		});
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal,
		});
		if (!res.ok) {
			throw new Error(`Poe token exchange failed: ${res.status} ${await res.text()}`);
		}
		return res.json() as Promise<PoeTokenResponse>;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private requireAuth(): void {
		if (!this.apiKey) {
			throw new Error("Poe API key is required. Use /login poe or set POE_API_KEY.");
		}
	}
}
