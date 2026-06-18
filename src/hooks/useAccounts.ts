import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
  ImportAccountsSummary,
} from "../types";
import { invokeBackend, type FileSource } from "../lib/platform";

function hydrateAccountUsage(account: AccountInfo): AccountWithUsage {
  return {
    ...account,
    usage: account.cached_usage ?? undefined,
    usageLoading: false,
  };
}

// Pacing for the automatic background poll. The active account is deliberately
// polled GENTLY, not aggressively: its OAuth token is also used by the running
// Codex CLI / Claude Code, which poll the same usage endpoint, so hammering it
// every minute is exactly what trips a 429. Usage windows (5h/7d) move slowly,
// so a few minutes of staleness in the background is fine — selecting an
// account or pressing Refresh always fetches immediately.
const ACTIVE_USAGE_REFRESH_MS = 150_000; // ~2.5 min
const INACTIVE_USAGE_REFRESH_MS = 360_000; // ~6 min
// Random per-account stagger added on top of the base interval so our polls do
// not phase-lock with each other or with the external CLI's own 60s cycle.
const USAGE_REFRESH_JITTER_MS = 60_000;
const RATE_LIMIT_FRONTEND_BACKOFF_MS = 330_000; // > backend cooldown floor (300s)

// Stable per-account jitter in [0, USAGE_REFRESH_JITTER_MS) derived from the id,
// so an account's effective interval is consistent across ticks (no thrashing).
function usageJitterForAccount(accountId: string): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash * 31 + accountId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % USAGE_REFRESH_JITTER_MS;
}

function isNetworkError(msg: string): boolean {
  if (!navigator.onLine) return true;
  const m = msg.toLowerCase();
  return (
    m.includes("connection refused") ||
    m.includes("failed to connect") ||
    m.includes("error sending request") ||
    m.includes("error trying to connect") ||
    m.includes("tcp connect") ||
    m.includes("network") ||
    m.includes("no route to host") ||
    m.includes("os error 10060") ||   // Windows connection timeout
    m.includes("os error 10061") ||   // Windows connection refused
    m.includes("os error 11001") ||   // Windows DNS lookup failed
    m.includes("timed out") ||
    m.includes("dns") ||
    m.includes("name or service not known") ||
    m.includes("no such host") ||
    m.includes("socket")
  );
}

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [networkOffline, setNetworkOffline] = useState(false);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  // Low concurrency spreads requests out instead of firing them as one burst.
  const maxConcurrentUsageRequests = 3;
  // Per-account pacing state for the automatic poll.
  const usageAttemptAtRef = useRef<Record<string, number>>({});
  const usageBlockedUntilRef = useRef<Record<string, number>>({});
  // Debounce for OS "online" events, which fire on every adapter change on Windows.
  const lastOnlineRefreshRef = useRef<number>(0);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const buildUsageError = useCallback(
    (accountId: string, message: string, planType: string | null): UsageInfo => ({
      account_id: accountId,
      plan_type: planType,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: message,
    }),
    []
  );

  const runWithConcurrency = useCallback(
    async <T,>(
      items: T[],
      worker: (item: T) => Promise<void>,
      concurrency: number
    ) => {
      if (items.length === 0) return;
      const limit = Math.min(Math.max(concurrency, 1), items.length);
      let index = 0;
      const runners = Array.from({ length: limit }, async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) return;
          await worker(items[current]);
        }
      });
      await Promise.allSettled(runners);
    },
    []
  );

  const loadAccounts = useCallback(async (preserveUsage = false) => {
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts");
      
      if (preserveUsage) {
        // Preserve existing usage data when just updating account info
        setAccounts((prev) => {
          const usageMap = new Map(
            prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }])
          );
          return accountList.map((a) => {
            const hydrated = hydrateAccountUsage(a);
            const preserved = usageMap.get(a.id);
            return {
              ...hydrated,
              usage: preserved?.usage ?? hydrated.usage,
              usageLoading: preserved?.usageLoading ?? hydrated.usageLoading,
            };
          });
        });
      } else {
        setAccounts(accountList.map(hydrateAccountUsage));
      }
      return accountList;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: { refreshMetadata?: boolean; auto?: boolean }
    ) => {
      try {
        let list: AccountInfo[] | AccountWithUsage[] = [
          ...(accountList ?? accountsRef.current),
        ];

        // Parked (inactive) OAuth accounts — Claude AND Codex — are frozen like a
        // powered-off PC: never contacted, served from cache only. Both providers
        // rotate refresh tokens with reuse detection, so a background refresh of an
        // account another client also holds would log that client out. Skipping
        // them here keeps their "last updated" timestamp honest (so the UI can
        // truthfully say the data is stale) and guarantees zero network on their
        // rotation-sensitive token. API-key accounts have no usage to fetch anyway.
        list = list.filter(
          (account) => account.is_active || account.auth_mode === "api_key"
        );

        if (options?.auto) {
          // Automatic poll: skip accounts refreshed recently or cooling down after a 429.
          const now = Date.now();
          list = list.filter((account) => {
            if (now < (usageBlockedUntilRef.current[account.id] ?? 0)) return false;
            const lastAttempt = usageAttemptAtRef.current[account.id] ?? 0;
            const base = account.is_active
              ? ACTIVE_USAGE_REFRESH_MS
              : INACTIVE_USAGE_REFRESH_MS;
            const minInterval = base + usageJitterForAccount(account.id);
            return now - lastAttempt >= minInterval;
          });
        } else {
          // Manual/explicit refresh: never bypass an active 429 cooldown, or we
          // just walk straight back into the rate limit.
          const now = Date.now();
          list = list.filter(
            (account) => now >= (usageBlockedUntilRef.current[account.id] ?? 0)
          );
          if (list.length === 0) return;
        }

        if (list.length === 0) {
          return;
        }

        if (options?.refreshMetadata) {
          // Metadata refresh is a ChatGPT-only operation; skip Claude accounts.
          await runWithConcurrency(
            list.filter((account) => account.provider !== "claude"),
            async (account) => {
              await invokeBackend<AccountInfo>("refresh_account_metadata", {
                accountId: account.id,
              });
            },
            maxConcurrentUsageRequests
          );

          list = await loadAccounts(true);
        }

        const accountIds = list.map((account) => account.id);
        const accountIdSet = new Set(accountIds);
        const usageResults = new Map<string, UsageInfo>();

        const attemptStamp = Date.now();
        accountIds.forEach((id) => {
          usageAttemptAtRef.current[id] = attemptStamp;
        });

        setAccounts((prev) =>
          prev.map((account) =>
            accountIdSet.has(account.id)
              ? { ...account, usageLoading: true }
              : account
          )
        );

        let networkErrorCount = 0;

        await runWithConcurrency(
          list,
          async (account) => {
            try {
              const usage = await invokeBackend<UsageInfo>("get_usage", {
                accountId: account.id,
              });
              usageResults.set(account.id, usage);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (isNetworkError(message)) {
                networkErrorCount++;
              } else {
                console.error("Failed to refresh usage:", err);
                if (!("usage" in account) || !account.usage) {
                  usageResults.set(
                    account.id,
                    buildUsageError(account.id, message, account.plan_type ?? null)
                  );
                }
              }
            }
          },
          maxConcurrentUsageRequests
        );

        // If every request failed with a network error → we're offline.
        // Don't overwrite account data with errors; just set the offline flag.
        if (networkErrorCount > 0 && networkErrorCount === list.length) {
          setNetworkOffline(true);
          setAccounts((prev) =>
            prev.map((a) => accountIdSet.has(a.id) ? { ...a, usageLoading: false } : a)
          );
          return;
        }

        // Some succeeded → we're back online (or were never offline).
        if (networkErrorCount === 0) setNetworkOffline(false);

        usageResults.forEach((usage, id) => {
          if (usage.rate_limited) {
            usageBlockedUntilRef.current[id] = Date.now() + RATE_LIMIT_FRONTEND_BACKOFF_MS;
          }
        });

        setAccounts((prev) =>
          prev.map((account) => {
            const usage = usageResults.get(account.id);
            if (!usage) return account;
            if (usage.rate_limited && account.usage && !account.usage.error) {
              // Transient 429: keep the last good data, just flag the failed refresh.
              return { ...account, usageWarning: true, usageLoading: false };
            }
            return {
              ...account,
              cached_usage: usage,
              cached_usage_updated_at: new Date().toISOString(),
              usage,
              usageWarning: Boolean(usage.rate_limited),
              usageLoading: false,
            };
          })
        );
      } catch (err) {
        console.error("Failed to refresh usage:", err);
        throw err;
      }
    },
    [buildUsageError, loadAccounts, maxConcurrentUsageRequests, runWithConcurrency]
  );

  const refreshSingleUsage = useCallback(async (
    accountId: string,
    options?: { refreshMetadata?: boolean }
  ) => {
    try {
      if (options?.refreshMetadata) {
        await invokeBackend<AccountInfo>("refresh_account_metadata", { accountId });
        await loadAccounts(true);
      }

      setAccounts((prev) =>
        prev.map((a) => a.id === accountId ? { ...a, usageLoading: true } : a)
      );
      usageAttemptAtRef.current[accountId] = Date.now();
      const usage = await invokeBackend<UsageInfo>("get_usage", { accountId });
      setNetworkOffline(false);
      if (usage.rate_limited) {
        usageBlockedUntilRef.current[accountId] = Date.now() + RATE_LIMIT_FRONTEND_BACKOFF_MS;
      }
      setAccounts((prev) =>
        prev.map((a) => {
          if (a.id !== accountId) return a;
          if (usage.rate_limited && a.usage && !a.usage.error) {
            // Transient 429: keep the last good data, just flag the failed refresh.
            return { ...a, usageWarning: true, usageLoading: false };
          }
          return {
            ...a,
            cached_usage: usage,
            cached_usage_updated_at: new Date().toISOString(),
            usage,
            usageWarning: Boolean(usage.rate_limited),
            usageLoading: false,
          };
        })
      );
      return usage;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNetworkError(message)) {
        setNetworkOffline(true);
        setAccounts((prev) =>
          prev.map((a) => a.id === accountId ? { ...a, usageLoading: false } : a)
        );
        throw err;
      }
      console.error("Failed to refresh single usage:", err);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? { ...a, usage: a.usage ?? buildUsageError(accountId, message, a.plan_type ?? null), usageLoading: false }
            : a
        )
      );
      throw err;
    }
  }, [buildUsageError, loadAccounts]);

  const warmupAccount = useCallback(async (accountId: string) => {
    try {
      await invokeBackend("warmup_account", { accountId });
    } catch (err) {
      console.error("Failed to warm up account:", err);
      throw err;
    }
  }, []);

  const warmupAllAccounts = useCallback(async () => {
    try {
      return await invokeBackend<WarmupSummary>("warmup_all_accounts");
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      throw err;
    }
  }, []);

  const switchAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("switch_account", { accountId });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      try {
        const removedAccount = accountsRef.current.find((account) => account.id === accountId);
        await invokeBackend("delete_account", { accountId });

        setAccounts((prev) => prev.filter((account) => account.id !== accountId));

        if (removedAccount?.is_active) {
          await loadAccounts(true);
        }
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      try {
        await invokeBackend("rename_account", { accountId, newName });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const importClaudeFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_claude_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_claude_account_from_credentials_text", {
            name,
            contents,
          });
        }
        await loadAccounts();
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const startOAuthLogin = useCallback(async (accountName: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_login",
        { accountName }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_login");
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const completeOAuthReauth = useCallback(async (accountId: string) => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_reauth_login", { accountId });
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const exportAccountsSlimText = useCallback(async () => {
    try {
      return await invokeBackend<string>("export_accounts_slim_text");
    } catch (err) {
      throw err;
    }
  }, []);

  const importAccountsSlimText = useCallback(
    async (payload: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>("import_accounts_slim_text", {
          payload,
        });
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const exportAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        await invokeBackend("export_accounts_full_encrypted_file", { path });
      } catch (err) {
        throw err;
      }
    },
    []
  );

  const importAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>(
          "import_accounts_full_encrypted_file",
          { path }
        );
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  }, []);

  const checkClaudeFileStatus = useCallback(async (): Promise<
    "file_not_found" | "matched" | "unknown"
  > => {
    try {
      return await invokeBackend<"file_not_found" | "matched" | "unknown">(
        "check_claude_file_status"
      );
    } catch (err) {
      console.error("Failed to check Claude file status:", err);
      return "matched";
    }
  }, []);

  const addClaudeFromActiveSession = useCallback(
    async (name: string) => {
      const account = await invokeBackend<AccountInfo>(
        "add_claude_account_from_active_session",
        { name }
      );
      await loadAccounts();
      return account;
    },
    [loadAccounts]
  );

  const updateActiveClaudeFromFile = useCallback(async () => {
    await invokeBackend("update_active_claude_account_from_file");
    await loadAccounts(true);
  }, [loadAccounts]);

  const clearClaudeActiveSession = useCallback(async () => {
    await invokeBackend("clear_claude_active_session");
    await loadAccounts(true);
  }, [loadAccounts]);

  const loadMaskedAccountIds = useCallback(async () => {
    try {
      return await invokeBackend<string[]>("get_masked_account_ids");
    } catch (err) {
      console.error("Failed to load masked account IDs:", err);
      return [];
    }
  }, []);

  const saveMaskedAccountIds = useCallback(async (ids: string[]) => {
    try {
      await invokeBackend("set_masked_account_ids", { ids });
    } catch (err) {
      console.error("Failed to save masked account IDs:", err);
    }
  }, []);

  useEffect(() => {
    loadAccounts().then((accountList) => refreshUsage(accountList));

    // Auto-refresh tick every 60 seconds; per-account pacing inside refreshUsage
    // decides who actually gets fetched (active ~3 min, inactive ~6 min, both
    // jittered) so we don't out-poll the provider on the shared active token.
    const interval = setInterval(() => {
      refreshUsage(undefined, { auto: true }).catch(() => {});
    }, 60000);

    return () => clearInterval(interval);
  }, [loadAccounts, refreshUsage]);

  // When the browser/OS signals the network is back, retry usage — but debounced,
  // because Windows fires "online" on every adapter/VPN change, and respecting
  // 429 cooldowns (manual refreshUsage path) so we don't walk back into a limit.
  useEffect(() => {
    const handleOnline = () => {
      setNetworkOffline(false);
      const now = Date.now();
      if (now - lastOnlineRefreshRef.current < 30_000) return;
      lastOnlineRefreshRef.current = now;
      refreshUsage().catch(() => {});
    };
    const handleOffline = () => setNetworkOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refreshUsage]);

  return {
    accounts,
    loading,
    error,
    networkOffline,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    importClaudeFromFile,
    exportAccountsSlimText,
    importAccountsSlimText,
    exportAccountsFullEncryptedFile,
    importAccountsFullEncryptedFile,
    startOAuthLogin,
    completeOAuthLogin,
    completeOAuthReauth,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
    checkClaudeFileStatus,
    addClaudeFromActiveSession,
    updateActiveClaudeFromFile,
    clearClaudeActiveSession,
  };
}
