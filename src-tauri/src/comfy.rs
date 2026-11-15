//! settings.yaml (repo / app folder) and the ComfyUI process: start, stop, status, a small local HTTP
//! client for its API, and the separate ComfyUI window.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

pub const DEFAULT_LORA_DIR: &str = "G:/sd/sharedModels/loras";
pub const DEFAULT_PORT: u16 = 8188;
const WINDOW_LABEL: &str = "comfyui";

#[derive(Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    lora_output_dir: Option<String>,
    comfyui: Option<ComfyFile>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct ComfyFile {
    mode: Option<String>,
    root: Option<String>,
    python: Option<String>,
    distro: Option<String>,
    port: Option<u16>,
    extra_args: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ComfySetup {
    pub mode: String, // "wsl" | "windows"
    pub root: String,
    pub python: Option<String>,
    pub distro: Option<String>,
    pub port: u16,
    pub extra_args: Vec<String>,
    pub origin: String, // "settings" | "managed"
}

#[derive(Serialize, Clone)]
pub struct AppConfig {
    pub source: Option<String>,
    pub error: Option<String>,
    pub lora_output_dir: String,
    pub comfyui: Option<ComfySetup>,
    pub managed_dir: String,
    pub managed_installed: bool,
}

struct ComfyProcess {
    child: Child,
    setup: ComfySetup,
}

#[derive(Default)]
pub struct ComfyState(Mutex<Option<ComfyProcess>>);

/// settings.yaml next to the app executable wins over the one in the repository root.
fn config_candidates() -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            found.push(dir.join("settings.yaml"));
        }
    }
    if let Some(project) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        found.push(project.join("settings.yaml"));
    }
    found
}

fn local_data(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("costume-lora-studio"))
}

pub fn managed_dir(app: &AppHandle) -> PathBuf {
    local_data(app).join("comfyui").join("ComfyUI")
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let mut source = None;
    let mut error = None;
    let mut file = FileConfig::default();
    if let Some(path) = config_candidates().into_iter().find(|path| path.is_file()) {
        source = Some(slash(&path));
        match fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|text| {
            if text.trim().is_empty() {
                Ok(FileConfig::default())
            } else {
                serde_yaml::from_str::<FileConfig>(&text).map_err(|e| e.to_string())
            }
        }) {
            Ok(parsed) => file = parsed,
            Err(message) => error = Some(format!("settings.yaml could not be read: {message}")),
        }
    }
    let lora_output_dir = file
        .lora_output_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.replace('\\', "/"))
        .unwrap_or_else(|| {
            if Path::new("G:/").exists() {
                DEFAULT_LORA_DIR.to_owned()
            } else {
                slash(&local_data(app).join("loras"))
            }
        });
    let managed = managed_dir(app);
    let managed_installed = managed.join("main.py").is_file();
    let mut comfyui = None;
    if let Some(comfy) = file.comfyui.as_ref().filter(|comfy| comfy.root.as_deref().is_some_and(|root| !root.trim().is_empty())) {
        let root = comfy.root.clone().unwrap_or_default().trim().to_owned();
        let mode = comfy
            .mode
            .clone()
            .unwrap_or_else(|| if root.starts_with('/') { "wsl".into() } else { "windows".into() })
            .to_lowercase();
        if mode != "wsl" && mode != "windows" {
            error.get_or_insert_with(|| "settings.yaml: comfyui.mode must be wsl or windows".to_owned());
        } else {
            comfyui = Some(ComfySetup {
                mode,
                root: if root.starts_with('/') { root } else { root.replace('\\', "/") },
                python: comfy.python.clone().filter(|value| !value.trim().is_empty()),
                distro: comfy.distro.clone().filter(|value| !value.trim().is_empty()),
                port: comfy.port.unwrap_or(DEFAULT_PORT),
                extra_args: comfy.extra_args.clone().unwrap_or_default().split_whitespace().map(str::to_owned).collect(),
                origin: "settings".into(),
            });
        }
    } else if managed_installed {
        comfyui = Some(ComfySetup {
            mode: "windows".into(),
            root: slash(&managed),
            python: None,
            distro: None,
            port: DEFAULT_PORT,
            extra_args: Vec::new(),
            origin: "managed".into(),
        });
    }
    AppConfig { source, error, lora_output_dir, comfyui, managed_dir: slash(&managed), managed_installed }
}

/// C:/a/b -> /mnt/c/a/b (paths ComfyUI inside WSL can read).
pub fn to_wsl_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        format!("/mnt/{}{}", (bytes[0] as char).to_ascii_lowercase(), &path[2..])
    } else {
        path
    }
}

fn yaml_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// The extra model folders file passed to ComfyUI with --extra-model-paths-config.
pub fn extra_paths_yaml(folders: &BTreeMap<String, Vec<String>>, wsl: bool) -> String {
    let mut text = String::from("# Written by Costume LoRA Studio for each ComfyUI start. Do not edit.\ncostume_lora_studio:\n");
    for (kind, dirs) in folders {
        let dirs: Vec<String> = dirs
            .iter()
            .filter(|dir| !dir.trim().is_empty())
            .map(|dir| if wsl { to_wsl_path(dir) } else { dir.replace('\\', "/") })
            .collect();
        if dirs.is_empty() || !kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        if dirs.len() == 1 {
            text.push_str(&format!("  {kind}: {}\n", yaml_quote(&dirs[0])));
        } else {
            text.push_str(&format!("  {kind}: |\n"));
            for dir in dirs {
                text.push_str(&format!("    {dir}\n"));
            }
        }
    }
    text
}

fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn wsl_command(setup: &ComfySetup) -> Command {
    let mut command = Command::new("wsl.exe");
    if let Some(distro) = &setup.distro {
        command.args(["-d", distro]);
    }
    command
}

/// The command that starts ComfyUI for this setup. Arguments are passed as separate words, never through a shell string.
pub fn launch_command(setup: &ComfySetup, extra_yaml: &str) -> Command {
    let mut args: Vec<String> = vec!["--port".into(), setup.port.to_string(), "--extra-model-paths-config".into()];
    if setup.mode == "wsl" {
        args.push(to_wsl_path(extra_yaml));
        args.extend(setup.extra_args.iter().cloned());
        let script = r#"R="$1"; P="$2"; shift 2; cd "$R" || exit 1; if [ -z "$P" ]; then for c in ../venv/bin/python venv/bin/python .venv/bin/python; do if [ -x "$c" ]; then P="$c"; break; fi; done; fi; [ -n "$P" ] || P=python3; exec "$P" main.py "$@""#;
        let mut command = wsl_command(setup);
        command.args(["-e", "bash", "-lc", script, "comfyui", &setup.root, setup.python.as_deref().unwrap_or("")]);
        command.args(&args);
        command
    } else {
        args.push(extra_yaml.to_owned());
        args.extend(setup.extra_args.iter().cloned());
        let root = PathBuf::from(&setup.root);
        let python = setup.python.clone().map(PathBuf::from).unwrap_or_else(|| {
            [root.join("../python_embeded/python.exe"), root.join(".venv/Scripts/python.exe"), root.join("venv/Scripts/python.exe")]
                .into_iter()
                .find(|path| path.is_file())
                .unwrap_or_else(|| PathBuf::from("python"))
        });
        let mut command = Command::new(python);
        command.arg("-s").arg("main.py").args(&args).current_dir(root);
        command
    }
}

/// One local HTTP/1.0 request to ComfyUI (no extra crates; HTTP/1.0 keeps the answer unchunked).
pub fn http(port: u16, method: &str, path: &str, body: Option<&str>, timeout: Duration) -> Result<(u16, String), String> {
    if !path.starts_with('/') || path.contains(['\r', '\n', ' ']) {
        return Err("Invalid ComfyUI path".into());
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(800)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, content) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    Ok((status, content.to_owned()))
}

fn reachable(port: u16) -> bool {
    matches!(http(port, "GET", "/system_stats", None, Duration::from_secs(2)), Ok((200, _)))
}

fn stop_process(process: &mut ComfyProcess) {
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &process.child.id().to_string(), "/T", "/F"]);
        hide(&mut kill);
        let _ = kill.output();
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
    if process.setup.mode == "wsl" {
        // Ending wsl.exe does not always end the Linux process: stop the ComfyUI that listens on our port.
        let mut pkill = wsl_command(&process.setup);
        pkill.args(["-e", "pkill", "-f", &format!("main.py --port {} ", process.setup.port)]);
        hide(&mut pkill);
        let _ = pkill.output();
    }
}

fn status_value(app: &AppHandle, state: &State<'_, ComfyState>) -> Value {
    let config = load_config(app);
    let mut guard = state.0.lock().unwrap();
    let managed = match guard.as_mut() {
        Some(process) => matches!(process.child.try_wait(), Ok(None)),
        None => false,
    };
    if !managed {
        *guard = None;
    }
    drop(guard);
    let port = config.comfyui.as_ref().map(|setup| setup.port).unwrap_or(DEFAULT_PORT);
    json!({
        "configured": config.comfyui.is_some(),
        "started_by_app": managed,
        "reachable": reachable(port),
        "url": format!("http://127.0.0.1:{port}/"),
        "port": port,
        "log": slash(&local_data(app).join("comfyui.log")),
    })
}

#[tauri::command]
pub fn app_config(app: AppHandle) -> AppConfig {
    load_config(&app)
}

#[tauri::command]
pub async fn comfy_status(app: AppHandle, state: State<'_, ComfyState>) -> Result<Value, String> {
    Ok(status_value(&app, &state))
}

/// Starts ComfyUI (if it is not already answering) with the LoRA output folder and the given model folders added.
#[tauri::command]
pub async fn comfy_start(app: AppHandle, state: State<'_, ComfyState>, folders: BTreeMap<String, Vec<String>>) -> Result<Value, String> {
    let config = load_config(&app);
    if let Some(message) = &config.error {
        return Err(message.clone());
    }
    let setup = config.comfyui.clone().ok_or("ComfyUI is not set up. Install it from the ComfyUI tab or set comfyui.root in settings.yaml.")?;
    if reachable(setup.port) {
        return Ok(status_value(&app, &state));
    }
    if state.0.lock().unwrap().as_mut().is_some_and(|process| matches!(process.child.try_wait(), Ok(None))) {
        return Ok(status_value(&app, &state)); // still starting
    }
    if setup.mode == "windows" && !Path::new(&setup.root).join("main.py").is_file() {
        return Err(format!("ComfyUI was not found in {} (no main.py)", setup.root));
    }
    let data = local_data(&app);
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let mut folders = folders;
    folders.entry("loras".into()).or_default().insert(0, config.lora_output_dir.clone());
    let yaml_path = data.join("comfy_extra_model_paths.yaml");
    fs::write(&yaml_path, extra_paths_yaml(&folders, setup.mode == "wsl")).map_err(|e| e.to_string())?;
    let log = fs::File::create(data.join("comfyui.log")).map_err(|e| e.to_string())?;
    let mut command = launch_command(&setup, &slash(&yaml_path));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .env("PYTHONUNBUFFERED", "1");
    hide(&mut command);
    let child = command.spawn().map_err(|e| format!("Cannot start ComfyUI: {e}"))?;
    *state.0.lock().unwrap() = Some(ComfyProcess { child, setup });
    Ok(status_value(&app, &state))
}

#[tauri::command]
pub async fn comfy_stop(app: AppHandle, state: State<'_, ComfyState>) -> Result<Value, String> {
    if let Some(mut process) = state.0.lock().unwrap().take() {
        stop_process(&mut process);
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(status_value(&app, &state))
}

/// A request to the configured local ComfyUI, e.g. GET /object_info/LoraLoader.
#[tauri::command]
pub async fn comfy_http(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if method != "GET" && method != "POST" {
        return Err("Only GET and POST are allowed".into());
    }
    let port = load_config(&app).comfyui.map(|setup| setup.port).unwrap_or(DEFAULT_PORT);
    let body = body.map(|value| value.to_string());
    let (status, text) = tauri::async_runtime::spawn_blocking(move || http(port, &method, &path, body.as_deref(), Duration::from_secs(60)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({"status": status, "body": serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text))}))
}

/// Opens (or focuses) the ComfyUI window. `script` runs in the ComfyUI page, e.g. to load a workflow.
#[tauri::command]
pub async fn open_comfy_window(app: AppHandle, script: Option<String>) -> Result<(), String> {
    let port = load_config(&app).comfyui.map(|setup| setup.port).unwrap_or(DEFAULT_PORT);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Some(script) = script {
            window.eval(&script).map_err(|e| e.to_string())?;
        }
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let url = format!("http://127.0.0.1:{port}/").parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let mut builder = tauri::WebviewWindowBuilder::new(&app, WINDOW_LABEL, tauri::WebviewUrl::External(url))
        .title("ComfyUI — Costume LoRA Studio")
        .inner_size(1440.0, 920.0)
        .min_inner_size(800.0, 560.0);
    if let Some(script) = script {
        builder = builder.initialization_script(&script);
    }
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

/// Stops a ComfyUI the app started when the app quits.
pub fn shutdown(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<ComfyState>().0.lock() {
        if let Some(mut process) = guard.take() {
            stop_process(&mut process);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_become_wsl_paths() {
        assert_eq!(to_wsl_path("G:/sd/sharedModels/loras"), "/mnt/g/sd/sharedModels/loras");
        assert_eq!(to_wsl_path("C:\\Users\\a b\\x"), "/mnt/c/Users/a b/x");
        assert_eq!(to_wsl_path("/home/index/x"), "/home/index/x");
    }

    #[test]
    fn extra_paths_yaml_lists_folders_and_parses() {
        let mut folders = BTreeMap::new();
        folders.insert("loras".to_owned(), vec!["G:/sd/sharedModels/loras".to_owned()]);
        folders.insert("checkpoints".to_owned(), vec!["G:/a".to_owned(), "C:\\b c".to_owned()]);
        folders.insert("bad key".to_owned(), vec!["x".to_owned()]);
        let text = extra_paths_yaml(&folders, true);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        let section = &parsed["costume_lora_studio"];
        assert_eq!(section["loras"].as_str().unwrap(), "/mnt/g/sd/sharedModels/loras");
        assert_eq!(section["checkpoints"].as_str().unwrap(), "/mnt/g/a\n/mnt/c/b c\n");
        assert!(section.get("bad key").is_none());
    }

    #[test]
    fn settings_file_rejects_unknown_keys_and_reads_the_comfy_section() {
        let parsed: FileConfig = serde_yaml::from_str("lora_output_dir: D:/loras\ncomfyui:\n  root: /home/x/ComfyUI\n  port: 8190\n").unwrap();
        assert_eq!(parsed.lora_output_dir.as_deref(), Some("D:/loras"));
        assert_eq!(parsed.comfyui.unwrap().port, Some(8190));
        assert!(serde_yaml::from_str::<FileConfig>("lora_dir: x\n").is_err());
    }

    #[test]
    fn launch_commands_pass_the_port_and_extra_paths() {
        let setup = ComfySetup {
            mode: "wsl".into(), root: "/home/i/ComfyUI".into(), python: None, distro: Some("Ubuntu".into()), port: 8188,
            extra_args: vec!["--output-directory".into(), "/mnt/g/sd/output".into()], origin: "settings".into(),
        };
        let command = launch_command(&setup, "C:/data/extra.yaml");
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(command.get_program(), "wsl.exe");
        assert_eq!(&args[..3], ["-d", "Ubuntu", "-e"]);
        assert!(args.contains(&"/home/i/ComfyUI".to_owned()));
        let tail: Vec<&str> = args.iter().rev().take(6).rev().map(String::as_str).collect();
        assert_eq!(tail, ["--port", "8188", "--extra-model-paths-config", "/mnt/c/data/extra.yaml", "--output-directory", "/mnt/g/sd/output"]);
    }
}
