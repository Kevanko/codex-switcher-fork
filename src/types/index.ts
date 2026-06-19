// Types matching the Rust backend

export type AccountProvider = "codex" | "claude";
export type AuthMode = "api_key" | "chat_g_p_t" | "claude_oauth";

export interface AccountInfo {
  id: string;
  name: string;
  email: string | null;
  plan_type: string | null;
  subscription_expires_at: string | null;
  auth_token_expires_at: string | null;
  provider: AccountProvider;
  auth_mode: AuthMode;
  claude_subscription_type: string | null;
  claude_rate_limit_tier: string | null;
  claude_organization_uuid: string | null;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  cached_usage: UsageInfo | null;
  cached_usage_updated_at: string | null;
}

export interface UsageInfo {
  account_id: string;
  plan_type: string | null;
  primary_used_percent: number | null;
  primary_window_minutes: number | null;
  primary_resets_at: number | null;
  secondary_used_percent: number | null;
  secondary_window_minutes: number | null;
  secondary_resets_at: number | null;
  has_credits: boolean | null;
  unlimited_credits: boolean | null;
  credits_balance: string | null;
  error: string | null;
  /** True when the failure is a transient rate limit (429) — show yellow, keep old data. */
  rate_limited?: boolean | null;
}

export interface OAuthLoginInfo {
  auth_url: string;
  callback_port: number;
}

export interface AccountWithUsage extends AccountInfo {
  usage?: UsageInfo;
  usageLoading?: boolean;
  /** Last refresh attempt failed transiently (rate limit); shown as a yellow hint. */
  usageWarning?: boolean;
}

export interface CodexProcessInfo {
  count: number;
  background_count: number;
  can_switch: boolean;
  pids: number[];
}

/** A Claude CLI long-lived token account (`claude setup-token`). */
export interface ClaudeTokenAccountInfo {
  id: string;
  name: string;
  /** ISO timestamp */
  created_at: string;
  /** ISO timestamp — hard expiry (token TTL is 1 year). */
  expires_at: string;
  is_active: boolean;
  /** Masked token for display, e.g. "sk-ant-…a1b2". */
  token_masked: string;
  plan_label: string | null;
}

/** An Anthropic-compatible gateway account (GLM via z.ai / OpenRouter / custom). */
export interface GatewayAccountInfo {
  id: string;
  name: string;
  /** Anthropic-compatible base URL, e.g. "https://api.z.ai/api/anthropic". */
  base_url: string;
  /** Pinned model id sent via ANTHROPIC_MODEL, e.g. "glm-5.2". */
  model: string | null;
  /** Masked key for display. */
  key_masked: string;
  is_active: boolean;
  /** ISO timestamp */
  created_at: string;
}

export interface WarmupSummary {
  total_accounts: number;
  warmed_accounts: number;
  failed_account_ids: string[];
}

export interface ImportAccountsSummary {
  total_in_payload: number;
  imported_count: number;
  skipped_count: number;
}
