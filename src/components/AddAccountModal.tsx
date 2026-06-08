import { useEffect, useState } from "react";
import {
  ArrowUpFromLine,
  Copy,
  ExternalLink,
  FolderOpen,
  KeyRound,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
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
  onAddClaudeFromSession: (name: string) => Promise<unknown>;
  onClearClaudeSession: () => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
  locale?: Locale;
  mode?: "add" | "reauthorize";
  provider?: "codex" | "claude";
  lockedAccountName?: string;
}

type Tab = "oauth" | "import" | "auto";

export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onImportClaudeFile,
  onAddClaudeFromSession,
  onClearClaudeSession,
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
  const [sessionCleared, setSessionCleared] = useState(false);
  const tauriRuntime = isTauriRuntime();
  const t = translations[locale];
  const isReauthorize = mode === "reauthorize";
  const isClaude = provider === "claude" && !isReauthorize;
  const ru = locale === "ru";

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
      setActiveTab("auto");
      setName("");
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
    setSessionCleared(false);
  };

  const handleClose = () => {
    if (oauthPending) void onCancelOAuth();
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    const accountName = (isReauthorize && lockedAccountName ? lockedAccountName : name).trim();
    if (!accountName) { setError(t.addAccount.enterName); return; }
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
    if (!name.trim()) { setError(t.addAccount.enterName); return; }
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

  const handleAddFromSession = async () => {
    if (!name.trim()) { setError(t.addAccount.enterName); return; }
    try {
      setLoading(true);
      setError(null);
      await onAddClaudeFromSession(name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleSubmit = () => {
    if (isClaude) {
      void (activeTab === "auto" ? handleAddFromSession() : handleImportFile());
    } else {
      void (activeTab === "oauth" && !isClaude ? handleOAuthLogin() : handleImportFile());
    }
  };

  const submitLabel = () => {
    if (loading) return t.common.working;
    if (isClaude) return activeTab === "auto"
      ? (ru ? "Добавить аккаунт" : "Add account")
      : t.addAccount.importAccount;
    if (activeTab === "oauth") return isReauthorize ? t.addAccount.refreshLogin : t.addAccount.generateLink;
    return t.addAccount.importAccount;
  };

  const submitDisabled = loading || (!isClaude && activeTab === "oauth" && oauthPending);

  return (
    <div
      className="config-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="config-panel add-account-panel fade-up"
        onMouseDown={(e) => e.stopPropagation()}
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
          {/* Codex tabs */}
          {!isReauthorize && !isClaude && (
            <div className="add-account-tabs">
              <button
                type="button"
                className={`ui-segment-button add-account-tab ${activeTab === "oauth" ? "is-selected" : ""}`}
                onClick={() => {
                  if (oauthPending) { void onCancelOAuth().catch(() => {}); setOauthPending(false); setLoading(false); }
                  setActiveTab("oauth"); setError(null);
                }}
              >
                <ShieldCheck size={16} /><span>{t.addAccount.oauthTab}</span>
              </button>
              <button
                type="button"
                className={`ui-segment-button add-account-tab ${activeTab === "import" ? "is-selected" : ""}`}
                onClick={() => {
                  if (oauthPending) { void onCancelOAuth().catch(() => {}); setOauthPending(false); setLoading(false); }
                  setActiveTab("import"); setError(null);
                }}
              >
                <ArrowUpFromLine size={16} /><span>{t.addAccount.importTab}</span>
              </button>
            </div>
          )}

          {/* Claude tabs */}
          {isClaude && (
            <div className="add-account-tabs">
              <button
                type="button"
                className={`ui-segment-button add-account-tab ${activeTab === "auto" ? "is-selected" : ""}`}
                onClick={() => { setActiveTab("auto"); setError(null); }}
              >
                <Zap size={16} /><span>{ru ? "Авто" : "Auto"}</span>
              </button>
              <button
                type="button"
                className={`ui-segment-button add-account-tab ${activeTab === "import" ? "is-selected" : ""}`}
                onClick={() => { setActiveTab("import"); setError(null); }}
              >
                <ArrowUpFromLine size={16} /><span>{ru ? "Из файла" : "From file"}</span>
              </button>
            </div>
          )}

          {/* Name field */}
          <label className={`settings-section ${isReauthorize ? "is-readonly-section" : ""}`}>
            <div>
              <h3>{isReauthorize ? t.addAccount.reauthAccount : t.addAccount.name}</h3>
              <p>{isReauthorize ? t.addAccount.reauthHint : t.addAccount.nameHint}</p>
            </div>
            <input
              type="text"
              value={isReauthorize && lockedAccountName ? lockedAccountName : name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.addAccount.namePlaceholder}
              className="ui-input"
              readOnly={isReauthorize}
            />
          </label>

          {/* Claude — Auto tab */}
          {isClaude && activeTab === "auto" && (
            <div className="settings-section">
              <div>
                <h3><Sparkles size={14} style={{ display: "inline", marginRight: 6 }} />{ru ? "Текущий сеанс" : "Current session"}</h3>
                <p>
                  {ru
                    ? "Считывает токен из ~/.claude/.credentials.json и сохраняет в switcher. Файл остаётся нетронутым."
                    : "Reads the token from ~/.claude/.credentials.json and stores it in the switcher. The file is left untouched."}
                </p>
              </div>
              {sessionCleared ? (
                <div className="inline-alert">
                  <Zap size={16} />
                  {ru
                    ? "Сессия удалена. Войдите через «claude login», затем нажмите «Добавить аккаунт»."
                    : "Session cleared. Log in via «claude login», then click «Add account»."}
                </div>
              ) : (
                <div className="inline-alert">
                  <Zap size={16} />
                  {ru
                    ? "Уже вошли? Введите имя и нажмите «Добавить аккаунт». Хотите войти в другой — сначала удалите активную сессию."
                    : "Already logged in? Enter a name and click «Add account». Want a different account — clear the active session first."}
                </div>
              )}
              <button
                type="button"
                className="ui-action-button is-ghost"
                style={{ alignSelf: "flex-start", color: "var(--bad)" }}
                disabled={loading || sessionCleared}
                onClick={async () => {
                  try {
                    setLoading(true);
                    setError(null);
                    await onClearClaudeSession();
                    setSessionCleared(true);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                {ru ? "Удалить активную сессию" : "Clear active session"}
              </button>
            </div>
          )}

          {/* Claude — From file tab */}
          {isClaude && activeTab === "import" && (
            <div className="settings-section">
              <div>
                <h3>{t.addAccount.importClaude}</h3>
                <p>{t.addAccount.importClaudeHint}</p>
              </div>
              <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                <input
                  type="text"
                  readOnly
                  value={describeFileSource(fileSource)}
                  aria-label={t.addAccount.selectedClaudeFile}
                />
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={() => void handleSelectFile()}
                >
                  <FolderOpen size={16} />{t.addAccount.browse}
                </button>
              </div>
            </div>
          )}

          {/* Codex — OAuth tab */}
          {!isClaude && activeTab === "oauth" && (
            <div className="settings-section">
              <div>
                <h3>{t.addAccount.secureLogin}</h3>
                <p>{t.addAccount.secureHint}</p>
              </div>
              {oauthPending ? (
                <>
                  <div className="inline-alert">
                    <KeyRound size={16} />{t.addAccount.waiting}
                  </div>
                  <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                    <input type="text" readOnly value={authUrl} aria-label={t.addAccount.authUrl} />
                    <button
                      type="button"
                      className="ui-icon-button"
                      onClick={() => {
                        void navigator.clipboard.writeText(authUrl).then(() => {
                          setCopied(true); setTimeout(() => setCopied(false), 1800);
                        }).catch(() => setError(t.addAccount.clipboardUnavailable));
                      }}
                      title={copied ? t.addAccount.copiedLink : t.addAccount.copyLink}
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button"
                      onClick={() => void openExternalUrl(authUrl)}
                      title={t.addAccount.openLink}
                    >
                      <ExternalLink size={16} />
                    </button>
                  </div>
                  {!tauriRuntime && (
                    <div className="inline-alert is-warning">
                      <KeyRound size={16} />{t.addAccount.oauthHostWarning}
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
          )}

          {/* Codex — Import tab */}
          {!isClaude && activeTab === "import" && (
            <div className="settings-section">
              <div>
                <h3>{t.addAccount.importExisting}</h3>
                <p>{t.addAccount.importHint}</p>
              </div>
              <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                <input
                  type="text"
                  readOnly
                  value={describeFileSource(fileSource)}
                  aria-label={t.addAccount.selectedFile}
                />
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={() => void handleSelectFile()}
                >
                  <FolderOpen size={16} />{t.addAccount.browse}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="inline-alert is-danger">
              <X size={16} />{error}
            </div>
          )}

          <div className="modal-footer">
            <button type="button" className="ui-action-button is-ghost" onClick={handleClose}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="ui-action-button is-primary"
              onClick={handleSubmit}
              disabled={submitDisabled}
            >
              {submitLabel()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
