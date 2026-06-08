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

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const maxConcurrentUsageRequests = 10;

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
      options?: { refreshMetadata?: boolean }
    ) => {
      try {
        let list = (accountList ?? accountsRef.current).filter(
          (account) => account.provider !== "claude"
        );
        if (list.length === 0) {
          return;
        }

        if (options?.refreshMetadata) {
          await runWithConcurrency(
            list,
            async (account) => {
              await invokeBackend<AccountInfo>("refresh_account_metadata", {
                accountId: account.id,
              });
            },
            maxConcurrentUsageRequests
          );

          list = (await loadAccounts(true)).filter((account) => account.provider !== "claude");
        }

        const accountIds = list.map((account) => account.id);
        const accountIdSet = new Set(accountIds);
        const usageResults = new Map<string, UsageInfo>();

        setAccounts((prev) =>
          prev.map((account) =>
            accountIdSet.has(account.id)
              ? { ...account, usageLoading: true }
              : account
          )
        );

        await runWithConcurrency(
          list,
          async (account) => {
            try {
              const usage = await invokeBackend<UsageInfo>("get_usage", {
                accountId: account.id,
              });
              usageResults.set(account.id, usage);
            } catch (err) {
              console.error("Failed to refresh usage:", err);
              if (!("usage" in account) || !account.usage) {
                const message = err instanceof Error ? err.message : String(err);
                usageResults.set(
                  account.id,
                  buildUsageError(account.id, message, account.plan_type ?? null)
                );
              }
            }
          },
          maxConcurrentUsageRequests
        );

        setAccounts((prev) =>
          prev.map((account) => {
            const usage = usageResults.get(account.id);
            if (!usage) return account;
            return {
              ...account,
              cached_usage: usage,
              cached_usage_updated_at: new Date().toISOString(),
              usage,
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
        prev.map((a) =>
          a.id === accountId ? { ...a, usageLoading: true } : a
        )
      );
      const usage = await invokeBackend<UsageInfo>("get_usage", { accountId });
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                cached_usage: usage,
                cached_usage_updated_at: new Date().toISOString(),
                usage,
                usageLoading: false,
              }
            : a
        )
      );
      return usage;
    } catch (err) {
      console.error("Failed to refresh single usage:", err);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                usage:
                  a.usage ??
                  buildUsageError(
                    accountId,
                    err instanceof Error ? err.message : String(err),
                    a.plan_type ?? null
                  ),
                usageLoading: false,
              }
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
    
    // Auto-refresh usage every 60 seconds (same as official Codex CLI)
    const interval = setInterval(() => {
      refreshUsage().catch(() => {});
    }, 60000);
    
    return () => clearInterval(interval);
  }, [loadAccounts, refreshUsage]);

  return {
    accounts,
    loading,
    error,
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
