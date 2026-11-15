#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    python_path: String,
    training_python: String,
    engine_dir: String,
    models_dir: String,
    tokenizer_dir: String,
}

struct Running {
    id: String,
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct Session {
    running: Option<Running>,
    snapshot: Value,
    logs: Vec<Value>,
}

#[derive(Default)]
struct JobState(Mutex<Session>);

fn resource_root(app: &AppHandle) -> PathBuf {
    let resources = app.path().resource_dir().unwrap_or_default();
    if resources
        .join("bundle/backend/desktop_backend.py")
        .is_file()
    {
        resources.join("bundle")
    } else {
        resources
    }
}

fn defaults(app: &AppHandle) -> Settings {
    let resources = resource_root(app);
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let python = |name: &str| {
        let bundled = resources.join(format!("runtime/{name}/python.exe"));
        if bundled.is_file() {
            bundled.to_string_lossy().into_owned()
        } else {
            let local = project.join(if name == "training" {
                ".training-env/.venv/Scripts/python.exe"
            } else {
                ".venv/Scripts/python.exe"
            });
            if local.is_file() {
                local.to_string_lossy().into_owned()
            } else {
                "python".to_owned()
            }
        }
    };
    let engine = resources.join("engine/sd-scripts");
    Settings {
        python_path: python("inference"),
        training_python: python("training"),
        engine_dir: if engine.is_dir() {
            engine
        } else {
            project.join("vendor/sd-scripts")
        }
        .to_string_lossy()
        .into_owned(),
        models_dir: if resources.join("bundle-manifest.json").is_file() {
            app.path()
                .document_dir()
                .unwrap_or_default()
                .join("CostumeLoRA/models")
        } else {
            project.join("models")
        }
        .to_string_lossy()
        .into_owned(),
        tokenizer_dir: if resources.join("bundle-manifest.json").is_file() {
            app.path()
                .document_dir()
                .unwrap_or_default()
                .join("CostumeLoRA/models/tokenizers")
        } else {
            project.join("models/tokenizers")
        }
        .to_string_lossy()
        .into_owned(),
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if path.is_file() {
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    } else {
        Ok(defaults(&app))
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    fs::write(
        path,
        serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn choose_path(app: AppHandle, directory: bool) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let selected = if directory {
            dialog.blocking_pick_folder()
        } else {
            dialog.blocking_pick_file()
        };
        selected
            .map(|path| {
                path.into_path()
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                    .map_err(|error| error.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

fn event(app: &AppHandle, job_id: &str, data: Value) {
    let data = json!({"jobId": job_id, "data": data});
    if let Ok(mut session) = app.state::<JobState>().0.lock() {
        session.logs.push(data.clone());
        if session.logs.len() > 500 {
            session.logs.remove(0);
        }
    }
    let _ = app.emit("job-event", data);
}

fn read_stream(
    app: AppHandle,
    job_id: String,
    mut stream: impl Read + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    for byte in &buffer[..count] {
                        if *byte == b'\n' || *byte == b'\r' || pending.len() >= 16384 {
                            if !pending.is_empty() {
                                let line = String::from_utf8_lossy(&pending).into_owned();
                                let data = serde_json::from_str(&line)
                                    .unwrap_or_else(|_| json!({"message": line}));
                                event(&app, &job_id, data);
                                pending.clear();
                            }
                        }
                        if *byte != b'\n' && *byte != b'\r' {
                            pending.push(*byte);
                        }
                    }
                }
            }
        }
        if !pending.is_empty() {
            event(
                &app,
                &job_id,
                json!({"message": String::from_utf8_lossy(&pending)}),
            );
        }
    })
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

#[tauri::command]
fn start_job(
    app: AppHandle,
    state: State<'_, JobState>,
    kind: String,
    payload: Value,
) -> Result<String, String> {
    if ![
        "mask",
        "mask_image",
        "caption",
        "dataset",
        "train",
        "validate",
        "download",
    ]
    .contains(&kind.as_str())
        || !payload.is_object()
    {
        return Err("Invalid job".into());
    }
    let mut session = state.0.lock().map_err(|error| error.to_string())?;
    if session.running.is_some() {
        return Err("Another job is running".into());
    }
    let settings = load_settings(app.clone())?;
    let python = if kind == "train" || kind == "validate" {
        &settings.training_python
    } else {
        &settings.python_path
    };
    if python.trim().is_empty() {
        return Err("Set the Python path in Environment settings".into());
    }
    let root = resource_root(&app);
    let mut backend = root.join("backend/desktop_backend.py");
    if !backend.is_file() {
        backend = Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop_backend.py");
    }
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    let jobs = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("jobs");
    fs::create_dir_all(&jobs).map_err(|error| error.to_string())?;
    let request_path = jobs.join(format!("{id}.json"));
    let mut payload = payload;
    for (key, value) in [
        ("engine_dir", &settings.engine_dir),
        ("models_dir", &settings.models_dir),
        ("tokenizer_dir", &settings.tokenizer_dir),
    ] {
        payload[key] = Value::String(value.clone());
    }
    fs::write(
        &request_path,
        serde_json::to_vec(&json!({"kind": kind, "payload": payload}))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut command = Command::new(python);
    command
        .args(["-u"])
        .arg(&backend)
        .arg("--request")
        .arg(&request_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .current_dir(backend.parent().unwrap());
    hide(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Python: {error}"))?;
    let stdout = read_stream(app.clone(), id.clone(), child.stdout.take().unwrap());
    let stderr = read_stream(app.clone(), id.clone(), child.stderr.take().unwrap());
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    session.logs.clear();
    session.snapshot = json!({"jobId": id, "kind": kind, "status": "running"});
    session.running = Some(Running {
        id: id.clone(),
        child: child.clone(),
        cancelled: cancelled.clone(),
    });
    drop(session);
    let job_id = id.clone();
    thread::spawn(move || {
        let outcome = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(error) => break Err(error),
            }
            thread::sleep(Duration::from_millis(150));
        };
        let _ = stdout.join();
        let _ = stderr.join();
        let status = if cancelled.load(Ordering::SeqCst) {
            "cancelled"
        } else if outcome.as_ref().is_ok_and(|status| status.success()) {
            "succeeded"
        } else {
            "failed"
        };
        if let Ok(mut session) = app.state::<JobState>().0.lock() {
            session.running = None;
            session.snapshot = json!({"jobId": job_id, "kind": kind, "status": status});
        }
        event(
            &app,
            &job_id,
            json!({"status": status, "message": match status {
                "succeeded" => "Job finished",
                "cancelled" => "Job cancelled",
                _ => "Job failed. Check the log.",
            }}),
        );
    });
    Ok(id)
}

#[tauri::command]
fn cancel_job(state: State<'_, JobState>, job_id: String) -> Result<(), String> {
    let session = state.0.lock().map_err(|error| error.to_string())?;
    let running = session.running.as_ref().ok_or("No job is running")?;
    if running.id != job_id {
        return Err("Does not match the running job".into());
    }
    let mut child = running.child.lock().map_err(|error| error.to_string())?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("The job has already finished".into());
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        hide(&mut command);
        if !command
            .output()
            .map_err(|error| error.to_string())?
            .status
            .success()
        {
            return Err("Could not cancel the job".into());
        }
    }
    #[cfg(not(windows))]
    child.kill().map_err(|error| error.to_string())?;
    running.cancelled.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn job_status(state: State<'_, JobState>) -> Result<Value, String> {
    let session = state.0.lock().map_err(|error| error.to_string())?;
    Ok(json!({"snapshot": session.snapshot, "logs": session.logs}))
}

#[derive(Serialize)]
struct ImageEntry {
    relative: String,
    image: String,
    mask: Option<String>,
}

fn collect_images(
    root: &Path,
    directory: &Path,
    masks: &Path,
    entries: &mut Vec<ImageEntry>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_symlink()
        {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_images(root, &path, masks, entries)?;
        } else if image_mime(&path).is_some() && entries.len() < 5000 {
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
            let mask = masks.join(relative).with_extension("png");
            entries.push(ImageEntry {
                relative: relative.to_string_lossy().into_owned(),
                image: path.to_string_lossy().into_owned(),
                mask: if mask.is_file() {
                    Some(mask.to_string_lossy().into_owned())
                } else {
                    None
                },
            });
        }
    }
    Ok(())
}

#[tauri::command]
async fn scan_images(root: String, mask_root: String) -> Result<Vec<ImageEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if root.trim().is_empty() || !Path::new(&root).is_dir() {
            return Err("Choose the source images folder".into());
        }
        let mut entries = Vec::new();
        collect_images(
            Path::new(&root),
            Path::new(&root),
            Path::new(&mask_root),
            &mut entries,
        )?;
        entries.sort_by(|left, right| left.relative.cmp(&right.relative));
        Ok(entries)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

#[tauri::command]
async fn preview_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        let mime = image_mime(path).ok_or("Unsupported preview format")?;
        if fs::metadata(path).map_err(|error| error.to_string())?.len() > 24 * 1024 * 1024 {
            return Err("Preview supports images up to 24 MB".into());
        }
        let data = fs::read(path).map_err(|error| error.to_string())?;
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(data)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
struct ToolFileRequest {
    root: String,
    image: String,
    output_dir: String,
    content: String,
}

fn tool_image(root: &str, image: &str) -> Result<(PathBuf, PathBuf), String> {
    if root.trim().is_empty() || image.trim().is_empty() {
        return Err("Choose a source images folder and an image".into());
    }
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let image = fs::canonicalize(image).map_err(|error| error.to_string())?;
    if !image.starts_with(&root) || !image.is_file() || image_mime(&image).is_none() {
        return Err("Choose an image inside the source images folder".into());
    }
    Ok((root, image))
}

fn tool_output(request: &ToolFileRequest, extension: &str) -> Result<PathBuf, String> {
    let (root, image) = tool_image(&request.root, &request.image)?;
    // Captions default to a sidecar .txt next to the image when no folder is given.
    if extension == "txt" && request.output_dir.trim().is_empty() {
        return Ok(image.with_extension("txt"));
    }
    let requested = Path::new(&request.output_dir);
    if request.output_dir.trim().is_empty() || !requested.is_absolute() {
        return Err("Specify the output folder as an absolute path".into());
    }
    fs::create_dir_all(requested).map_err(|error| error.to_string())?;
    let output = fs::canonicalize(requested).map_err(|error| error.to_string())?;
    if extension == "txt" && output == root {
        return Ok(image.with_extension("txt"));
    }
    if output.starts_with(&root) || root.starts_with(&output) {
        return Err("Keep the source images and the output in separate folders".into());
    }
    let path = output
        .join(image.strip_prefix(&root).unwrap())
        .with_extension(extension);
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let parent = fs::canonicalize(path.parent().unwrap()).map_err(|error| error.to_string())?;
    if !parent.starts_with(&output) || path.is_symlink() {
        return Err("The output path points outside the chosen folder".into());
    }
    Ok(path)
}

fn write_tool_file(path: &Path, data: &[u8]) -> Result<(), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = path.with_extension(format!("{stamp}.tmp"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|error| error.to_string())
}

fn binary_mask_png(content: &str) -> Result<Vec<u8>, String> {
    let encoded = content
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid PNG mask format")?;
    if encoded.len() > 32 * 1024 * 1024 {
        return Err("The mask is too large".into());
    }
    let data = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    let mut decoder = png::Decoder::new(Cursor::new(data));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || u64::from(info.width) * u64::from(info.height) > 16_777_216
    {
        return Err("Edited masks are limited to 16.77 megapixels".into());
    }
    let mut buffer = vec![0; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut buffer)
        .map_err(|error| error.to_string())?;
    let channels = frame.color_type.samples();
    let mut pixels = Vec::with_capacity(frame.width as usize * frame.height as usize);
    for pixel in buffer[..frame.buffer_size()].chunks_exact(channels) {
        let (luminance, alpha) = match frame.color_type {
            png::ColorType::Grayscale => (u16::from(pixel[0]), 255),
            png::ColorType::GrayscaleAlpha => (u16::from(pixel[0]), pixel[1]),
            png::ColorType::Rgb => (
                (u16::from(pixel[0]) + u16::from(pixel[1]) + u16::from(pixel[2])) / 3,
                255,
            ),
            png::ColorType::Rgba => (
                (u16::from(pixel[0]) + u16::from(pixel[1]) + u16::from(pixel[2])) / 3,
                pixel[3],
            ),
            _ => return Err("Invalid mask color format".into()),
        };
        pixels.push(if luminance >= 128 && alpha >= 128 {
            255
        } else {
            0
        });
    }
    let mut result = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut result, frame.width, frame.height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&pixels)
            .map_err(|error| error.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
async fn save_tool_mask(request: ToolFileRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let png = binary_mask_png(&request.content)?;
        let path = tool_output(&request, "png")?;
        write_tool_file(&path, &png)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_tool_caption(request: ToolFileRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = request.content.trim();
        if text.is_empty() || text.contains('\0') || text.len() > 64_000 {
            return Err("The caption must be non-empty UTF-8 text".into());
        }
        let path = tool_output(&request, "txt")?;
        write_tool_file(&path, format!("{text}\n").as_bytes())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_tool_caption(
    root: String,
    image: String,
    caption_dir: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, image) = tool_image(&root, &image)?;
        let path = if caption_dir.trim().is_empty() {
            image.with_extension("txt")
        } else {
            Path::new(&caption_dir)
                .join(image.strip_prefix(&root).unwrap())
                .with_extension("txt")
        };
        if !path.exists() {
            return Ok(String::new());
        }
        if fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len()
            > 64_000
        {
            return Err("The caption is too long".into());
        }
        fs::read_to_string(path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba_fixture() -> String {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[
                    255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 0, 180, 180, 180, 255,
                ])
                .unwrap();
        }
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    #[test]
    fn painted_masks_export_as_binary_grayscale_without_alpha() {
        let bytes = binary_mask_png(&rgba_fixture()).unwrap();
        let mut reader = png::Decoder::new(Cursor::new(bytes)).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut pixels).unwrap();
        assert_eq!(frame.color_type, png::ColorType::Grayscale);
        assert_eq!(frame.bit_depth, png::BitDepth::Eight);
        assert_eq!(&pixels[..frame.buffer_size()], &[255, 0, 0, 255]);
    }

    #[test]
    fn malformed_mask_and_empty_source_are_rejected() {
        assert!(binary_mask_png("not an image").is_err());
        assert!(tool_image("", "").is_err());
    }

    #[test]
    fn edits_replace_only_output_files_and_preserve_source() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temporary = std::env::temp_dir().join(format!("costume-tools-{stamp}"));
        let raw = temporary.join("raw");
        fs::create_dir_all(&raw).unwrap();
        let source = raw.join("sample.png");
        fs::write(&source, b"source is unchanged").unwrap();
        let request = ToolFileRequest {
            root: raw.to_string_lossy().into_owned(),
            image: source.to_string_lossy().into_owned(),
            output_dir: temporary.join("masks").to_string_lossy().into_owned(),
            content: String::new(),
        };
        let output = tool_output(&request, "png").unwrap();
        write_tool_file(&output, b"first").unwrap();
        write_tool_file(&output, b"second").unwrap();
        assert_eq!(fs::read(output).unwrap(), b"second");
        assert_eq!(fs::read(source).unwrap(), b"source is unchanged");
        assert!(temporary.starts_with(std::env::temp_dir()) && temporary != std::env::temp_dir());
        fs::remove_dir_all(temporary).unwrap();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(JobState::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            choose_path,
            start_job,
            cancel_job,
            job_status,
            scan_images,
            preview_image,
            save_tool_mask,
            save_tool_caption,
            load_tool_caption
        ])
        .build(tauri::generate_context!())
        .expect("Failed to initialize Tauri")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Ok(session) = app.state::<JobState>().0.lock() {
                    if session.running.is_some() {
                        api.prevent_exit();
                        let _ = app.emit(
                            "close-blocked",
                            "Stop the running job before quitting the app",
                        );
                    }
                }
            }
        });
}
