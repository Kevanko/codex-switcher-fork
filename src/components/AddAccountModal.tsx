import { useEffect, useState } from "react";
import {
  ArrowUpFromLine,
  Copy,
  ExternalLink,
  FolderOpen,
  KeyRound,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  pickClaudeCredentialsFile,
  type FileSource,
} from "../lib/platform";
import { translations, type Locale } from "../i18n";

interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onImportClaudeFile: (source: FileSource, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
  locale?: Locale;
  mode?: "add" | "reauthorize";
  provider?: "codex" | "claude";
  lockedAccountName?: string;
}

type Tab = "oauth" | "import";

export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onImportClaudeFile,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
  locale = "en",
  mode = "add",
  provider = "codex",
  lockedAccountName,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const tauriRuntime = isTauriRuntime();
  const t = translations[locale];
  const isReauthorize = mode === "reauthorize";
  const isClaude = provider === "claude" && !isReauthorize;

  useEffect(() => {
    if (isOpen && isReauthorize && lockedAccountName) {
      setActiveTab("oauth");
      setName(lockedAccountName);
      setFileSource(null);
      setError(null);
      setAuthUrl("");
      setOauthPending(false);
      setCopied(false);
    }
  }, [isOpen, isReauthorize, lockedAccountName]);

  useEffect(() => {
    if (isOpen && isClaude) {
      setActiveTab("import");
      setFileSource(null);
      setError(null);
      setAuthUrl("");
      setOauthPending(false);
      setCopied(false);
    }
  }, [isOpen, isClaude]);

  const resetForm = () => {
    setName(isReauthorize && lockedAccountName ? lockedAccountName : "");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
    setCopied(false);
  };

  const handleClose = () => {
    if (oauthPending) {
      void onCancelOAuth();
    }
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    const accountName = (isReauthorize && lockedAccountName ? lockedAccountName : name).trim();
    if (!accountName) {
      setError(t.addAccount.enterName);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const info = await onStartOAuth(accountName);
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);
      await onCompleteOAuth();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = isClaude ? await pickClaudeCredentialsFile() : await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!name.trim()) {
      setError(t.addAccount.enterName);
      return;
    }
    if (!fileSource) {
      setError(isClaude ? t.addAccount.selectClaudeFile : t.addAccount.selectFile);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      if (isClaude) {
        await onImportClaudeFile(fileSource, name.trim());
      } else {
        await onImportFile(fileSource, name.trim());
      }
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="config-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        className="config-panel add-account-panel fade-up"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="config-header">
          <div>
            <h2>
              {isReauthorize
                ? t.addAccount.reauthTitle
                : isClaude
                  ? t.addAccount.claudeTitle
                  : t.addAccount.title}
            </h2>
            <p>
              {isReauthorize
                ? t.addAccount.reauthSubtitle
                : isClaude
                  ? t.addAccount.claudeSubtitle
                  : t.addAccount.subtitle}
            </p>
          </div>
          <button type="button" className="ui-icon-button" onClick={handleClose} title={t.common.close}>
            <X size={16} />
          </button>
        </div>

        <div className="config-body">
          {!isReauthorize && !isClaude && (
          <div className="add-account-tabs">
            <button
              type="button"
              className={`ui-segment-button add-account-tab ${activeTab === "oauth" ? "is-selected" : ""}`}
              onClick={() => {
                if (oauthPending) {
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab("oauth");
                setError(null);
              }}
            >
              <ShieldCheck size={16} />
              <span>{t.addAccount.oauthTab}</span>
            </button>
            <button
              type="button"
              className={`ui-segment-button add-account-tab ${activeTab === "import" ? "is-selected" : ""}`}
              onClick={() => {
                if (oauthPending) {
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab("import");
                setError(null);
              }}
            >
              <ArrowUpFromLine size={16} />
              <span>{t.addAccount.importTab}</span>
            </button>
          </div>
          )}

          <label className={`settings-section ${isReauthorize ? "is-readonly-section" : ""}`}>
            <div>
              <h3>{isReauthorize ? t.addAccount.reauthAccount : t.addAccount.name}</h3>
              <p>{isReauthorize ? t.addAccount.reauthHint : t.addAccount.nameHint}</p>
            </div>
            <input
              type="text"
              value={isReauthorize && lockedAccountName ? lockedAccountName : name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t.addAccount.namePlaceholder}
              className="ui-input"
              readOnly={isReauthorize}
            />
          </label>

          {activeTab === "oauth" && !isClaude ? (
            <div className="settings-section">
              <div>
                <h3>{t.addAccount.secureLogin}</h3>
                <p>{t.addAccount.secureHint}</p>
              </div>

              {oauthPending ? (
                <>
                  <div className="inline-alert">
                    <KeyRound size={16} />
                    {t.addAccount.waiting}
                  </div>
                  <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                    <input type="text" readOnly value={authUrl} aria-label={t.addAccount.authUrl} />
                    <button
                      type="button"
                      className="ui-icon-button"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(authUrl)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1800);
                          })
                          .catch(() => {
                            setError(t.addAccount.clipboardUnavailable);
                          });
                      }}
                      title={copied ? t.addAccount.copiedLink : t.addAccount.copyLink}
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button"
                      onClick={() => {
                        void openExternalUrl(authUrl);
                      }}
                      title={t.addAccount.openLink}
                    >
                      <ExternalLink size={16} />
                    </button>
                  </div>
                  {!tauriRuntime && (
                    <div className="inline-alert is-warning">
                      <KeyRound size={16} />
                      {t.addAccount.oauthHostWarning}
                    </div>
                  )}
                </>
              ) : (
                <div className="inline-alert">
                  <ShieldCheck size={16} />
                  {isReauthorize ? t.addAccount.willRefreshLogin : t.addAccount.willCreateUrl}
                </div>
              )}
            </div>
          ) : (
            <div className="settings-section">
              <div>
                <h3>{isClaude ? t.addAccount.importClaude : t.addAccount.importExisting}</h3>
                <p>{isClaude ? t.addAccount.importClaudeHint : t.addAccount.importHint}</p>
              </div>
              <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                <input
                  type="text"
                  readOnly
                  value={describeFileSource(fileSource)}
                  aria-label={isClaude ? t.addAccount.selectedClaudeFile : t.addAccount.selectedFile}
                />
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={() => {
                    void handleSelectFile();
                  }}
                >
                  <FolderOpen size={16} />
                  {t.addAccount.browse}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="inline-alert is-danger">
              <X size={16} />
              {error}
            </div>
          )}

          <div className="modal-footer">
            <button type="button" className="ui-action-button is-ghost" onClick={handleClose}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="ui-action-button is-primary"
              onClick={() => {
                void (activeTab === "oauth" && !isClaude ? handleOAuthLogin() : handleImportFile());
              }}
              disabled={loading || (activeTab === "oauth" && !isClaude && oauthPending)}
            >
              {loading
                ? t.common.working
                : activeTab === "oauth" && !isClaude
                  ? isReauthorize
                    ? t.addAccount.refreshLogin
                    : t.addAccount.generateLink
                  : t.addAccount.importAccount}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
