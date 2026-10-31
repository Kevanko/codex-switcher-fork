import { useEffect, useRef, useState } from "react";
import {
  ArrowUpFromLine,
  ClipboardPaste,
  Check,
  Copy,
  ExternalLink,
  Mail,
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
import type { MailCode } from "../types";
import { OPENAI_PHONE_URL, splitMailInput } from "../lib/mail";

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
  /** Paste an account someone shared (Copy as JSON) or a raw auth.json / .credentials.json. */
  onImportJson?: (contents: string, name: string) => Promise<unknown>;
  /** Fetch the newest login code from a mailbox (saved on the account, or typed in). */
  onFetchCode?: (args: { accountId?: string; address?: string; password?: string; since?: number }) => Promise<MailCode | null>;
  /** Remember the mailbox on the account once it exists. */
  onSaveMail?: (accountId: string, address: string, password: string) => Promise<unknown>;
  /** Real mailbox sign-in; rejects with a readable reason. */
  onCheckMail?: (address: string, password: string) => Promise<unknown>;
  /** Re-login of an account that already has a mailbox saved. */
  mailAccountId?: string;
  savedMailAddress?: string | null;
  locale?: Locale;
  mode?: "add" | "reauthorize";
  provider?: "codex" | "claude";
  lockedAccountName?: string;
}

type Tab = "oauth" | "import" | "auto" | "paste";

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
  onImportJson,
  onFetchCode,
  onSaveMail,
  onCheckMail,
  mailAccountId,
  savedMailAddress,
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
  const [pasted, setPasted] = useState("");
  const [mailAddr, setMailAddr] = useState("");
  const [mailPass, setMailPass] = useState("");
  const [loginCode, setLoginCode] = useState<MailCode | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const loginStartedAt = useRef(0);
  const useSavedMail = Boolean(mailAccountId && savedMailAddress);
  const canFetchCode = Boolean(onFetchCode) && (useSavedMail || (mailAddr.trim() && mailPass));

  // While the browser login is open, watch the mailbox for the code OpenAI sends.
  useEffect(() => {
    if (!oauthPending || !canFetchCode || !onFetchCode) return;
    let stop = false;
    const tick = async () => {
      try {
        const c = await onFetchCode({
          accountId: useSavedMail ? mailAccountId : undefined,
          address: mailAddr.trim(),
          password: mailPass,
          since: loginStartedAt.current - 60,
        });
        if (stop || !c) return;
        setLoginCode((prev) => {
          if (prev?.code === c.code) return prev;
          void navigator.clipboard.writeText(c.code).then(() => setCodeCopied(true)).catch(() => {});
          return c;
        });
      } catch { /* mailbox hiccup — try again on the next tick */ }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 4000);
    return () => { stop = true; window.clearInterval(id); };
  }, [oauthPending, canFetchCode, onFetchCode, useSavedMail, mailAccountId, mailAddr, mailPass]);
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
    if (isOpen && !isReauthorize) {
      setActiveTab(isClaude ? "auto" : "oauth");
      setPasted("");
      setName("");
      setFileSource(null);
      setError(null);
      setAuthUrl("");
      setOauthPending(false);
      setCopied(false);
    }
  }, [isOpen, isClaude, isReauthorize]);

  const resetForm = () => {
    setName(isReauthorize && lockedAccountName ? lockedAccountName : "");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
    setCopied(false);
    setSessionCleared(false);
    setPasted("");
    setMailAddr("");
    setMailPass("");
    setLoginCode(null);
    setCodeCopied(false);
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
      // A mailbox that does not sign in is reported now, before the browser opens.
      if (!useSavedMail && mailAddr.trim() && mailPass && onCheckMail) {
        try { await onCheckMail(mailAddr.trim(), mailPass); }
        catch (e) {
          setError((ru ? "Почта: " : "Mailbox: ") + (e instanceof Error ? e.message : String(e)));
          setLoading(false);
          return;
        }
      }
      const info = await onStartOAuth(accountName);
      setAuthUrl(info.auth_url);
      loginStartedAt.current = Math.floor(Date.now() / 1000);
      setLoginCode(null);
      setCodeCopied(false);
      setOauthPending(true);
      setLoading(false);
      const done = (await onCompleteOAuth()) as { id?: string } | undefined;
      if (!useSavedMail && mailAddr.trim() && mailPass && done?.id && onSaveMail) {
        try { await onSaveMail(done.id, mailAddr.trim(), mailPass); }
        catch (e) {
          setOauthPending(false);
          setError((ru ? "Аккаунт добавлен, но почту привязать не вышло: " : "Account added, but the mailbox was not linked: ") + (e instanceof Error ? e.message : String(e)));
          return;
        }
      }
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

  const handleImportJson = async () => {
    if (!onImportJson) return;
    if (!pasted.trim()) { setError(ru ? "Вставь JSON аккаунта." : "Paste the account JSON."); return; }
    try {
      setLoading(true);
      setError(null);
      await onImportJson(pasted, name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleSubmit = () => {
    if (activeTab === "paste") { void handleImportJson(); return; }
    if (isClaude) {
      void (activeTab === "auto" ? handleAddFromSession() : handleImportFile());
    } else {
      void (activeTab === "oauth" && !isClaude ? handleOAuthLogin() : handleImportFile());
    }
  };

  const submitLabel = () => {
    if (loading) return t.common.working;
    if (activeTab === "paste") return ru ? "Добавить аккаунт" : "Add account";
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
              {onImportJson && (
                <button
                  type="button"
                  className={`ui-segment-button add-account-tab ${activeTab === "paste" ? "is-selected" : ""}`}
                  onClick={() => {
                    if (oauthPending) { void onCancelOAuth().catch(() => {}); setOauthPending(false); setLoading(false); }
                    setActiveTab("paste"); setError(null);
                  }}
                >
                  <ClipboardPaste size={16} /><span>{ru ? "Вставить JSON" : "Paste JSON"}</span>
                </button>
              )}
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
              {onImportJson && (
                <button
                  type="button"
                  className={`ui-segment-button add-account-tab ${activeTab === "paste" ? "is-selected" : ""}`}
                  onClick={() => {
                    if (oauthPending) { void onCancelOAuth().catch(() => {}); setOauthPending(false); setLoading(false); }
                    setActiveTab("paste"); setError(null);
                  }}
                >
                  <ClipboardPaste size={16} /><span>{ru ? "Вставить JSON" : "Paste JSON"}</span>
                </button>
              )}
            </div>
          )}

          {/* Name field */}
          <label className={`settings-section ${isReauthorize ? "is-readonly-section" : ""}`}>
            <div>
              <h3>{isReauthorize ? t.addAccount.reauthAccount : t.addAccount.name}</h3>
              <p>
                {isReauthorize
                  ? t.addAccount.reauthHint
                  : activeTab === "paste"
                    ? (ru ? "Необязательно — иначе возьмём имя из JSON." : "Optional — the name from the JSON is used otherwise.")
                    : t.addAccount.nameHint}
              </p>
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

              {/* Optional mailbox: the one-time code OpenAI mails is fetched and copied for you. */}
              {onFetchCode && (useSavedMail ? (
                <div className="inline-alert">
                  <Mail size={16} />
                  {ru ? `Код входа возьмём из почты ${savedMailAddress}` : `The login code will be read from ${savedMailAddress}`}
                </div>
              ) : !oauthPending && (
                <div className="mail-box">
                  <div className="mail-box-title"><Mail size={14} />{ru ? "Почта для кодов (необязательно)" : "Mailbox for codes (optional)"}</div>
                  <input type="text" className="ui-input" value={mailAddr} onChange={(e) => { const sp = splitMailInput(e.target.value); if (sp) { setMailAddr(sp.address); setMailPass(sp.password); } else setMailAddr(e.target.value); }}
                    placeholder="name@firstmail.ltd" autoComplete="off" spellCheck={false} />
                  <input type="password" className="ui-input" value={mailPass} onChange={(e) => setMailPass(e.target.value)}
                    placeholder={ru ? "пароль от почты" : "mailbox password"} autoComplete="off" />
                  <p>{ru ? "Код придёт сам и скопируется в буфер. Почта и пароль хранятся только на этом компьютере." : "The code is fetched and copied for you. Mailbox and password stay on this computer."}</p>
                </div>
              ))}
              {oauthPending && (
                <div className="inline-alert is-warning phone-hint">
                  <KeyRound size={16} />
                  <span>
                    {ru ? "Если OpenAI просит подтвердить телефон — сделай это на их странице, вход в программе продолжится сам." : "If OpenAI asks you to verify a phone, do it on their page; sign-in here continues by itself."}
                    {" "}
                    <button type="button" className="link-btn" onClick={() => void openExternalUrl(OPENAI_PHONE_URL)}>
                      {ru ? "Открыть страницу телефона" : "Open the phone page"}
                    </button>
                  </span>
                </div>
              )}
              {oauthPending && canFetchCode && (
                <div className={"mail-code" + (loginCode ? " is-ready" : "")}>
                  {loginCode ? (
                    <>
                      <span className="mail-code-n">{loginCode.code}</span>
                      <span className="mail-code-h">{codeCopied ? <><Check size={13} />{ru ? "скопирован" : "copied"}</> : (ru ? "из письма" : "from the email")}</span>
                      <button type="button" className="ui-icon-button" title={ru ? "Скопировать" : "Copy"}
                        onClick={() => void navigator.clipboard.writeText(loginCode.code).then(() => setCodeCopied(true))}>
                        <Copy size={15} />
                      </button>
                    </>
                  ) : (
                    <span className="mail-code-h"><Mail size={13} />{ru ? "Жду письмо с кодом…" : "Waiting for the code email…"}</span>
                  )}
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

          {activeTab === "paste" && (
            <div className="settings-section">
              <div>
                <h3><ClipboardPaste size={14} style={{ display: "inline", marginRight: 6 }} />{ru ? "JSON аккаунта" : "Account JSON"}</h3>
                <p>
                  {ru
                    ? "То, что скопировали кнопкой «Копировать как JSON», или содержимое auth.json / .credentials.json. Codex или Claude определится сам."
                    : "What “Copy as JSON” produced, or the contents of auth.json / .credentials.json. Codex vs Claude is detected automatically."}
                </p>
              </div>
              <textarea
                className="config-textarea"
                style={{ minHeight: 140 }}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder='{ "codex_switcher_account": 1, ... }'
                spellCheck={false}
                autoFocus
              />
              <div className="inline-alert is-warning">
                <KeyRound size={16} />
                {ru
                  ? "Внутри — живые токены входа. Передавай только тому, кому доверяешь, как пароль."
                  : "This holds live sign-in tokens. Share it only with someone you trust, like a password."}
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
