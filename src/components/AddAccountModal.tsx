import { useState } from "react";
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
  type FileSource,
} from "../lib/platform";

interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

type Tab = "oauth" | "import";

export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
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

  const resetForm = () => {
    setName("");
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
    if (!name.trim()) {
      setError("Enter an account name first.");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const info = await onStartOAuth(name.trim());
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
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!name.trim()) {
      setError("Enter an account name first.");
      return;
    }
    if (!fileSource) {
      setError("Select an auth.json file.");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, name.trim());
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
            <h2>Add account</h2>
            <p>Use a clean login flow or import an existing `auth.json` file.</p>
          </div>
          <button type="button" className="ui-icon-button" onClick={handleClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="config-body">
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
              ChatGPT login
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
              Import file
            </button>
          </div>

          <label className="settings-section">
            <div>
              <h3>Account name</h3>
              <p>This label is used in the sidebar and account switcher.</p>
            </div>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Work account"
              className="ui-input"
            />
          </label>

          {activeTab === "oauth" ? (
            <div className="settings-section">
              <div>
                <h3>Secure login</h3>
                <p>Generate a login link and finish the sign-in in your browser.</p>
              </div>

              {oauthPending ? (
                <>
                  <div className="inline-alert">
                    <KeyRound size={16} />
                    Waiting for browser login to complete.
                  </div>
                  <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                    <input type="text" readOnly value={authUrl} aria-label="Authentication URL" />
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
                            setError("Clipboard unavailable. Copy the link manually.");
                          });
                      }}
                      title={copied ? "Copied" : "Copy login link"}
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button"
                      onClick={() => {
                        void openExternalUrl(authUrl);
                      }}
                      title="Open login link"
                    >
                      <ExternalLink size={16} />
                    </button>
                  </div>
                  {!tauriRuntime && (
                    <div className="inline-alert is-warning">
                      <KeyRound size={16} />
                      OAuth must finish on the same host because the callback uses `localhost`.
                    </div>
                  )}
                </>
              ) : (
                <div className="inline-alert">
                  <ShieldCheck size={16} />
                  The app will create a login URL for the selected account name.
                </div>
              )}
            </div>
          ) : (
            <div className="settings-section">
              <div>
                <h3>Import existing credentials</h3>
                <p>Choose an `auth.json` file from an existing Codex profile.</p>
              </div>
              <div className="sidebar-search" style={{ height: "auto", minHeight: 56 }}>
                <input
                  type="text"
                  readOnly
                  value={describeFileSource(fileSource)}
                  aria-label="Selected auth.json file"
                />
                <button
                  type="button"
                  className="ui-action-button"
                  onClick={() => {
                    void handleSelectFile();
                  }}
                >
                  <FolderOpen size={16} />
                  Browse
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
              Cancel
            </button>
            <button
              type="button"
              className="ui-action-button is-primary"
              onClick={() => {
                void (activeTab === "oauth" ? handleOAuthLogin() : handleImportFile());
              }}
              disabled={loading || (activeTab === "oauth" && oauthPending)}
            >
              {loading ? "Working" : activeTab === "oauth" ? "Generate link" : "Import account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
