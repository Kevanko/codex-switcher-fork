use std::fs;
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use hmac::{digest::CtOutput, Hmac, Mac};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use tokio::runtime::Runtime;

use crate::commands::{
    add_account_from_auth_json_text, add_account_from_file,
    add_claude_account_from_credentials_text, add_claude_account_from_file, cancel_login,
    check_codex_processes, complete_login, complete_reauth_login, delete_account,
    export_accounts_full_encrypted_bytes, export_accounts_slim_text, get_active_account_info,
    get_masked_account_ids, get_usage, import_accounts_full_encrypted_bytes,
    import_accounts_slim_text, list_accounts, refresh_account_metadata, refresh_all_accounts_usage,
    rename_account, set_masked_account_ids, start_login, switch_account, warmup_account,
    warmup_all_accounts,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountIdArgs {
    #[serde(alias = "account_id")]
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameAccountArgs {
    #[serde(alias = "account_id")]
    account_id: String,
    #[serde(alias = "new_name")]
    new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginArgs {
    #[serde(alias = "account_name")]
    account_name: String,
}

#[derive(Debug, Deserialize)]
struct ImportSlimArgs {
    payload: String,
}

#[derive(Debug, Deserialize)]
struct MaskedIdsArgs {
    ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct UploadAuthJsonArgs {
    name: String,
    contents: String,
}

#[derive(Debug, Deserialize)]
struct UploadClaudeCredentialsArgs {
    name: String,
    contents: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadEncryptedArgs {
    #[serde(alias = "contents_base64")]
    contents_base64: String,
}

#[derive(Debug, Deserialize)]
struct FileImportArgs {
    path: String,
    name: String,
}

pub fn run_lan_server(host: &str, port: u16) -> anyhow::Result<()> {
    let bind_host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let listener = TcpListener::bind((bind_host, port))
        .with_context(|| format!("Failed to bind HTTP server on {host}:{port}"))?;
    let address = listener
        .local_addr()
        .context("Failed to read web server address")?;
    let token = if !address.ip().is_loopback() {
        Some(match std::env::var("CODEX_WEB_TOKEN") {
            Ok(token) if !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_graphic()) => {
                (token, false)
            }
            Ok(_) => anyhow::bail!(
                "CODEX_WEB_TOKEN must contain nonempty printable ASCII without spaces"
            ),
            Err(std::env::VarError::NotPresent) => {
                (URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()), true)
            }
            Err(error) => return Err(error).context("Invalid CODEX_WEB_TOKEN"),
        })
    } else {
        None
    };
    let server = Server::from_listener(listener, None)
        .map_err(|err| anyhow::anyhow!("Failed to start HTTP server on {address}: {err}"))?;
    let runtime = Runtime::new().context("Failed to start async runtime")?;
    let dist_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist");

    println!("Codex Switcher web server listening on http://{address}");
    println!("Serving static files from {}", dist_dir.display());
    let token = token.map(|(token, generated)| {
        if generated {
            println!("Codex Switcher web access token: {token}");
        }
        token_tag(&token)
    });

    for request in server.incoming_requests() {
        if let Err(error) = handle_request(request, &runtime, &dist_dir, token.as_ref()) {
            eprintln!("[web] request failed: {error:#}");
        }
    }

    Ok(())
}

type TokenTag = CtOutput<Hmac<Sha256>>;

fn token_tag(token: &str) -> TokenTag {
    // CtOutput compares fixed-length tags in constant time, regardless of token length.
    let mut mac =
        Hmac::<Sha256>::new_from_slice(b"codex-web access token").expect("HMAC accepts any key");
    mac.update(token.as_bytes());
    mac.finalize()
}

fn authorized(expected: &TokenTag, authorization: Option<&str>, query: &str) -> bool {
    let bearer = authorization
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
        .map(|(_, token)| token);
    bearer.is_some_and(|token| token_tag(token) == *expected)
        || url::form_urlencoded::parse(query.as_bytes())
            .any(|(name, token)| name == "token" && token_tag(&token) == *expected)
}

fn loopback_request_allowed(host: Option<&str>, origin: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let local_origin = format!("http://{host}");
    let Ok(url) = url::Url::parse(&local_origin) else {
        return false;
    };
    let is_local = match url.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    is_local && origin.is_none_or(|value| value.eq_ignore_ascii_case(&local_origin))
}

fn network_command_allowed(command: &str) -> bool {
    // Commands that expose credentials or one-time codes stay loopback-only.
    matches!(
        command,
        "list_accounts"
            | "list_zcode_accounts"
            | "capture_zcode_account"
            | "get_active_account_info"
            | "add_account_from_auth_json_text"
            | "add_claude_account_from_credentials_text"
            | "get_usage"
            | "refresh_account_metadata"
            | "refresh_all_accounts_usage"
            | "warmup_account"
            | "warmup_all_accounts"
            | "switch_account"
            | "delete_account"
            | "rename_account"
            | "start_login"
            | "complete_login"
            | "complete_reauth_login"
            | "cancel_login"
            | "remove_account_and_session"
            | "check_mail_login"
            | "import_account_json"
            | "import_accounts_slim_text"
            | "import_accounts_full_encrypted_bytes"
            | "get_masked_account_ids"
            | "set_masked_account_ids"
            | "check_codex_processes"
    )
}

fn handle_request(
    mut request: Request,
    runtime: &Runtime,
    dist_dir: &Path,
    token: Option<&TokenTag>,
) -> anyhow::Result<()> {
    let method = request.method().clone();
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let request_header = |name| {
        request
            .headers()
            .iter()
            .find(|header| header.field.equiv(name))
            .map(|header| header.value.as_str())
    };
    if let Some(expected) = token {
        if !authorized(expected, request_header("Authorization"), query) {
            return respond_json(
                request,
                StatusCode(401),
                &json!({ "error": "Unauthorized" }),
            );
        }
    } else if !loopback_request_allowed(request_header("Host"), request_header("Origin")) {
        return respond_json(
            request,
            StatusCode(403),
            &json!({ "error": "Forbidden origin" }),
        );
    }

    if method == Method::Get && path == "/api/health" {
        respond_json(request, StatusCode(200), &json!({ "ok": true }))?;
        return Ok(());
    }

    if let (Method::Post, Some(command)) = (&method, path.strip_prefix("/api/invoke/")) {
        if token.is_some() && !network_command_allowed(command) {
            return respond_json(
                request,
                StatusCode(403),
                &json!({ "error": "Command unavailable in network mode" }),
            );
        }
        let payload = parse_request_json(&mut request)?;
        let result = runtime.block_on(invoke_web_command(command, payload));
        match result {
            Ok(value) => respond_json(request, StatusCode(200), &value)?,
            Err(error) => respond_json(request, StatusCode(400), &json!({ "error": error }))?,
        }
        return Ok(());
    }

    if method == Method::Get {
        serve_static(request, dist_dir, path)?;
        return Ok(());
    }

    respond_text(
        request,
        StatusCode(405),
        "Method Not Allowed",
        "text/plain; charset=utf-8",
    )?;
    Ok(())
}

async fn invoke_web_command(command: &str, payload: Value) -> Result<Value, String> {
    match command {
        "list_accounts" => to_json(list_accounts().await?),
        // ZCode snapshots, so the local bridge can restore a Z.ai sign-in too.
        "list_zcode_accounts" => to_json(crate::commands::list_zcode_accounts().await?),
        "capture_zcode_account" => {
            let name = payload
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            to_json(crate::commands::capture_zcode_account(name).await?)
        }
        "get_active_account_info" => to_json(get_active_account_info().await?),
        "add_account_from_file" => {
            let args: FileImportArgs = parse_args(payload)?;
            to_json(add_account_from_file(args.path, args.name).await?)
        }
        "add_claude_account_from_file" => {
            let args: FileImportArgs = parse_args(payload)?;
            to_json(add_claude_account_from_file(args.path, args.name).await?)
        }
        "add_account_from_auth_json_text" => {
            let args: UploadAuthJsonArgs = parse_args(payload)?;
            to_json(add_account_from_auth_json_text(args.name, args.contents).await?)
        }
        "add_claude_account_from_credentials_text" => {
            let args: UploadClaudeCredentialsArgs = parse_args(payload)?;
            to_json(add_claude_account_from_credentials_text(args.name, args.contents).await?)
        }
        "get_usage" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(get_usage(args.account_id, None).await?)
        }
        "refresh_account_metadata" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(refresh_account_metadata(args.account_id).await?)
        }
        "refresh_all_accounts_usage" => to_json(refresh_all_accounts_usage().await?),
        "warmup_account" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(warmup_account(args.account_id).await?)
        }
        "warmup_all_accounts" => to_json(warmup_all_accounts().await?),
        "switch_account" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(switch_account(args.account_id).await?)
        }
        "delete_account" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(delete_account(args.account_id).await?)
        }
        "rename_account" => {
            let args: RenameAccountArgs = parse_args(payload)?;
            to_json(rename_account(args.account_id, args.new_name).await?)
        }
        "start_login" => {
            let args: LoginArgs = parse_args(payload)?;
            to_json(start_login(args.account_name).await?)
        }
        "complete_login" => to_json(complete_login().await?),
        "complete_reauth_login" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(complete_reauth_login(args.account_id).await?)
        }
        "cancel_login" => to_json(cancel_login().await?),
        "export_account_json" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(crate::commands::export_account_json(args.account_id, None).await?)
        }
        "remove_account_and_session" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(crate::commands::remove_account_and_session(args.account_id).await?)
        }
        "set_account_mail" => {
            let g = |k: &str| payload.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            to_json(crate::commands::set_account_mail(g("accountId"), g("address"), g("password")).await?)
        }
        "check_mail_login" => {
            let g = |k: &str| payload.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            to_json(crate::commands::check_mail_login(g("address"), g("password")).await?)
        }
        "fetch_login_code" => {
            let id = payload.get("accountId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            to_json(crate::commands::fetch_login_code(id, payload.get("since").and_then(|v| v.as_i64())).await?)
        }
        "fetch_login_code_with" => {
            let g = |k: &str| payload.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            to_json(crate::commands::fetch_login_code_with(g("address"), g("password"), payload.get("since").and_then(|v| v.as_i64())).await?)
        }
        "import_account_json" => {
            let contents = payload.get("contents").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
            to_json(crate::commands::import_account_json(contents, name).await?)
        }
        "export_accounts_slim_text" => to_json(export_accounts_slim_text().await?),
        "import_accounts_slim_text" => {
            let args: ImportSlimArgs = parse_args(payload)?;
            to_json(import_accounts_slim_text(args.payload).await?)
        }
        "export_accounts_full_encrypted_bytes" => {
            let encoded = STANDARD.encode(export_accounts_full_encrypted_bytes().await?);
            to_json(encoded)
        }
        "import_accounts_full_encrypted_bytes" => {
            let args: UploadEncryptedArgs = parse_args(payload)?;
            let bytes = STANDARD
                .decode(args.contents_base64)
                .map_err(|error| format!("Failed to decode uploaded backup: {error}"))?;
            to_json(import_accounts_full_encrypted_bytes(bytes).await?)
        }
        "get_masked_account_ids" => to_json(get_masked_account_ids().await?),
        "set_masked_account_ids" => {
            let args: MaskedIdsArgs = parse_args(payload)?;
            to_json(set_masked_account_ids(args.ids).await?)
        }
        "check_codex_processes" => to_json(check_codex_processes().await?),
        _ => Err(format!("Unsupported web command: {command}")),
    }
}

fn parse_request_json(request: &mut Request) -> anyhow::Result<Value> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .context("Failed to read request body")?;

    if body.trim().is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_str(&body).context("Failed to parse request JSON")
}

fn parse_args<T>(value: Value) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value).map_err(|error| format!("Invalid command payload: {error}"))
}

fn to_json<T>(value: T) -> Result<Value, String>
where
    T: serde::Serialize,
{
    serde_json::to_value(value).map_err(|error| format!("Failed to serialize response: {error}"))
}

fn serve_static(request: Request, dist_dir: &Path, url: &str) -> anyhow::Result<()> {
    let requested = if url == "/" {
        PathBuf::from("index.html")
    } else {
        sanitize_path(url)?
    };
    let candidate = dist_dir.join(&requested);

    if candidate.is_file() {
        return serve_file(request, candidate);
    }

    if requested.extension().is_some() {
        respond_text(
            request,
            StatusCode(404),
            "Not Found",
            "text/plain; charset=utf-8",
        )?;
        return Ok(());
    }

    serve_file(request, dist_dir.join("index.html"))
}

fn sanitize_path(url: &str) -> anyhow::Result<PathBuf> {
    let raw = url.trim_start_matches('/');
    let candidate = Path::new(raw);

    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => anyhow::bail!("Invalid request path"),
        }
    }

    Ok(candidate.to_path_buf())
}

fn serve_file(request: Request, path: PathBuf) -> anyhow::Result<()> {
    let data = fs::read(&path).with_context(|| format!("Failed to read {}", path.display()))?;
    let mime = mime_type_for_path(&path);
    let response = Response::from_data(data)
        .with_header(header("Content-Type", mime)?)
        .with_header(header("Referrer-Policy", "no-referrer")?)
        .with_header(header("Cache-Control", "no-cache")?);
    request.respond(response)?;
    Ok(())
}

fn respond_json(request: Request, status: StatusCode, payload: &Value) -> anyhow::Result<()> {
    let response = Response::from_string(serde_json::to_string(payload)?)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json; charset=utf-8")?)
        .with_header(header("Cache-Control", "no-store")?);
    request.respond(response)?;
    Ok(())
}

fn respond_text(
    request: Request,
    status: StatusCode,
    body: &str,
    content_type: &str,
) -> anyhow::Result<()> {
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", content_type)?);
    request.respond(response)?;
    Ok(())
}

fn header(name: &str, value: &str) -> anyhow::Result<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).map_err(|_| {
        anyhow::anyhow!("Failed to create header {name}: invalid header value `{value}`")
    })
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpeg" | "jpg" => "image/jpeg",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{authorized, loopback_request_allowed, network_command_allowed, token_tag};

    #[test]
    fn accepts_only_the_matching_bearer_or_query_token() {
        let expected = token_tag("test+token");
        assert!(authorized(&expected, Some("Bearer test+token"), ""));
        assert!(authorized(&expected, None, "other=1&token=test%2Btoken"));
        assert!(!authorized(&expected, None, ""));
        assert!(!authorized(
            &expected,
            Some("Bearer test+wrong"),
            "token=test"
        ));
        assert!(!authorized(
            &expected,
            Some("Basic test+token"),
            "other=test%2Btoken"
        ));
    }

    #[test]
    fn network_mode_blocks_secret_commands() {
        for command in [
            "export_account_json",
            "export_accounts_slim_text",
            "export_accounts_full_encrypted_bytes",
            "export_accounts_full_encrypted_file",
            "get_gateway_key_secret",
            "get_claude_token_secret",
            "set_account_mail",
            "fetch_login_code",
            "fetch_login_code_with",
            "get_totp_code",
            "set_totp_secret",
        ] {
            assert!(!network_command_allowed(command), "{command}");
        }
        for command in ["list_accounts", "switch_account", "delete_account"] {
            assert!(network_command_allowed(command), "{command}");
        }
    }

    #[test]
    fn loopback_requires_a_local_host_and_matching_browser_origin() {
        assert!(loopback_request_allowed(
            Some("localhost:3210"),
            Some("http://localhost:3210")
        ));
        assert!(loopback_request_allowed(Some("127.0.0.1:3210"), None));
        assert!(loopback_request_allowed(Some("[::1]:3210"), None));
        assert!(!loopback_request_allowed(Some("example.test:3210"), None));
        assert!(!loopback_request_allowed(
            Some("localhost:3210"),
            Some("https://example.test")
        ));
    }
}
