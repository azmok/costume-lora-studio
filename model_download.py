"""Downloads base-model files (Hugging Face / Civitai) with aria2c. Used by the "download" job of desktop_backend."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ARIA2_ZIP = "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip"
USER_AGENT = "costume-lora-studio/1.0"
HF_HOSTS = ("huggingface.co",)
CIVITAI_HOSTS = ("civitai.com", "www.civitai.com")
MARGIN_BYTES = 1 << 30
FAMILY_IDS = ("sd15", "sdxl", "sd3", "flux", "lumina", "hunyuan", "anima")


class DownloadError(ValueError):
    pass


def host_of(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def check_url(url) -> str:
    if not isinstance(url, str) or not url.strip() or len(url) > 2000 or "\x00" in url:
        raise DownloadError("Enter a download URL")
    url = url.strip()
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise DownloadError("Only https:// download links are supported")
    return url


def safe_name(name: str) -> str:
    """A plain .safetensors file name: no folders, no odd characters."""
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", Path(str(name)).name).strip(" .")
    if not base or base.startswith("-"):
        raise DownloadError("The file name is not usable")
    if not base.lower().endswith(".safetensors"):
        raise DownloadError(f"Only .safetensors files are downloaded (got {base})")
    return base[:180]


def auth_headers(url: str, hf_token: str, civitai_key: str) -> dict:
    host = host_of(url)
    token = hf_token if host in HF_HOSTS else civitai_key if host in CIVITAI_HOSTS else ""
    headers = {"User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = "Bearer " + token
    return headers


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def resolve_url(url: str, hf_token: str = "", civitai_key: str = "", timeout: int = 30):
    """Follows the redirects by hand so the access token is only ever sent to Hugging Face / Civitai and never to
    the CDN they redirect to. Returns (final_url, size_in_bytes_or_None)."""
    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _ in range(6):
        headers = {**auth_headers(current, hf_token, civitai_key), "Range": "bytes=0-0"}
        try:
            with opener.open(urllib.request.Request(current, headers=headers), timeout=timeout) as response:
                total = response.headers.get("Content-Range", "")
                match = re.search(r"/(\d+)$", total)
                length = response.headers.get("Content-Length")
                size = int(match.group(1)) if match else int(length) if length and length.isdigit() else None
                return current, size
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308) and error.headers.get("Location"):
                current = check_url(urllib.parse.urljoin(current, error.headers["Location"]))
                continue
            if error.code in (401, 403):
                raise DownloadError(
                    f"Access denied by {host_of(current)} ({error.code}). For gated models, accept the license on the model page and set your access token in Environment."
                ) from error
            if error.code == 404:
                raise DownloadError(f"File not found: {url}") from error
            if error.code == 416:  # an empty file answers the range request with 416
                return current, 0
            raise DownloadError(f"Download server answered {error.code} for {host_of(current)}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise DownloadError(f"Could not reach {host_of(current)}: {getattr(error, 'reason', error)}") from error
    raise DownloadError("Too many redirects")


def http_json(url: str, civitai_key: str = "", timeout: int = 30) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if civitai_key and host_of(url) in CIVITAI_HOSTS:
        headers["Authorization"] = "Bearer " + civitai_key
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            data = json.loads(response.read(8_000_000).decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise DownloadError(f"Civitai answered {error.code} for {url}") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise DownloadError(f"Could not read Civitai information: {error}") from error
    if not isinstance(data, dict):
        raise DownloadError("Unexpected answer from Civitai")
    return data


def parse_civitai(url: str):
    """(model_id, version_id) from a Civitai page or download link; either may be None."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)
    version = (query.get("modelVersionId") or [None])[0]
    found = re.search(r"/models/(\d+)", parts.path)
    if "/api/download/models/" in parts.path and found:
        return None, found.group(1)
    return (found.group(1) if found else None), (version if version and version.isdigit() else None)


def pick_file(version: dict) -> dict:
    files = [item for item in version.get("files", []) if isinstance(item, dict) and str(item.get("name", "")).lower().endswith(".safetensors")]
    files = [item for item in files if item.get("type", "Model") in ("Model", "Pruned Model")] or files
    if not files:
        raise DownloadError("This Civitai version has no .safetensors file")
    files.sort(key=lambda item: not item.get("primary", False))
    return files[0]


def civitai_item(url: str, civitai_key: str = "") -> dict:
    """Name, direct download link and base model of a Civitai model page / download link."""
    model_id, version_id = parse_civitai(url)
    if version_id is None and model_id is None:
        raise DownloadError("Paste a Civitai model page or download link")
    if version_id is None:
        model = http_json(f"https://civitai.com/api/v1/models/{model_id}", civitai_key)
        versions = model.get("modelVersions") or []
        if not versions:
            raise DownloadError("This Civitai model has no versions")
        version = versions[0]
    else:
        version = http_json(f"https://civitai.com/api/v1/model-versions/{version_id}", civitai_key)
    chosen = pick_file(version)
    link = chosen.get("downloadUrl") or f"https://civitai.com/api/download/models/{version.get('id', version_id)}"
    return {"url": check_url(link), "name": safe_name(chosen["name"]), "base_model": str(version.get("baseModel") or "")}


def aria2_path(tools_dir: Path, progress=None) -> str:
    found = shutil.which("aria2c")
    if found:
        return found
    exe = tools_dir / "aria2c.exe"
    if exe.is_file():
        return str(exe)
    if os.name != "nt":
        raise DownloadError("aria2c was not found. Install it first (for example: sudo apt install aria2 / brew install aria2).")
    if progress:
        progress("Downloading aria2c (a small download tool, one time only)…")
    tools_dir.mkdir(parents=True, exist_ok=True)
    archive = tools_dir / "aria2.zip"
    try:
        with urllib.request.urlopen(urllib.request.Request(ARIA2_ZIP, headers={"User-Agent": USER_AGENT}), timeout=60) as response, archive.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        with zipfile.ZipFile(archive) as bundle:
            member = next((name for name in bundle.namelist() if name.endswith("/aria2c.exe") or name == "aria2c.exe"), None)
            if member is None:
                raise DownloadError("The aria2 package does not contain aria2c.exe")
            exe.write_bytes(bundle.read(member))
    except (urllib.error.URLError, OSError, zipfile.BadZipFile) as error:
        raise DownloadError(f"Could not get aria2c: {error}. Install aria2 yourself and add aria2c to PATH.") from error
    finally:
        archive.unlink(missing_ok=True)
    return str(exe)


_UNITS = {"B": 1, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40}
_READOUT = re.compile(r"\[#\w+ ([\d.]+)([KMGT]?i?B)/([\d.]+)([KMGT]?i?B)\((\d+)%\)(?: CN:\d+)?(?: SD:\d+)?(?: DL:([\d.]+[KMGT]?i?B))?(?: ETA:(\w+))?\]")


def eta_clock(text: str) -> str:
    """aria2 prints 1h2m3s; the progress bar expects 1:02:03."""
    total = 0
    for amount, unit in re.findall(r"(\d+)([dhms])", text or ""):
        total += int(amount) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    if not text:
        return "?"
    return f"{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}" if total >= 3600 else f"{total // 60:02d}:{total % 60:02d}"


def parse_readout(line: str):
    """(done_bytes, total_bytes, percent, speed_text, eta_clock) from an aria2 console readout, else None."""
    match = _READOUT.search(line)
    if not match:
        return None
    done = float(match.group(1)) * _UNITS.get(match.group(2), 1)
    total = float(match.group(3)) * _UNITS.get(match.group(4), 1)
    return done, total, int(match.group(5)), (match.group(6) or "") + ("/s" if match.group(6) else ""), eta_clock(match.group(7))


def human(size: float) -> str:
    for unit, factor in (("G", 1 << 30), ("M", 1 << 20), ("K", 1 << 10)):
        if size >= factor:
            return f"{size / factor:.2f}{unit}"
    return f"{int(size)}B"


def progress_line(name: str, done: float, total: float, percent: int, speed: str, eta: str, elapsed: float) -> str:
    """Shaped like a tqdm line so the job bar reads it the same way as other downloads."""
    fill = "█" * (percent // 10) + " " * (10 - percent // 10)
    clock = f"{int(elapsed) // 60:02d}:{int(elapsed) % 60:02d}"
    return f"{name}: {percent:3d}%|{fill}| {human(done)}/{human(total)} [{clock}<{eta}, {speed or '?'}]"


def run_aria2(exe: str, url: str, destination: Path, expected: int | None, emit) -> None:
    command = [exe, "-x16", "-s16", "-k1M", "-c", "--file-allocation=none", "--auto-file-renaming=false", "--allow-overwrite=true",
               "--console-log-level=warn", "--summary-interval=0", "--download-result=hide", "--max-tries=5", "--retry-wait=3",
               "-d", str(destination.parent), "-o", destination.name, url]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    started = last = time.monotonic()
    tail = []
    buffer = b""
    try:
        while True:
            chunk = process.stdout.read1(4096) if hasattr(process.stdout, "read1") else process.stdout.read(4096)
            if not chunk:
                break
            buffer += chunk
            *lines, buffer = re.split(rb"[\r\n]+", buffer)
            for raw in lines:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                parsed = parse_readout(line)
                if parsed:
                    if time.monotonic() - last >= 1:
                        last = time.monotonic()
                        emit(progress_line(destination.name, *parsed, time.monotonic() - started))
                else:
                    tail = (tail + [line])[-4:]
    finally:
        code = process.wait()
    if code:
        raise DownloadError("aria2c failed (" + str(code) + "): " + " / ".join(tail))
    actual = destination.stat().st_size if destination.is_file() else -1
    if expected and actual != expected:
        raise DownloadError(f"The downloaded file is incomplete: {destination.name} ({actual} of {expected} bytes). Run the download again to resume.")


def download_items(payload: dict, emit) -> None:
    family = payload.get("model_family")
    if family not in FAMILY_IDS:
        raise DownloadError("model_family: choose a model type")
    items = payload.get("items")
    if not isinstance(items, list) or not items or len(items) > 12 or not all(isinstance(item, dict) for item in items):
        raise DownloadError("items: nothing to download")
    models = Path(str(payload.get("models_dir") or "")).expanduser()
    if not str(payload.get("models_dir") or "").strip():
        raise DownloadError("Set the Models folder in Environment first")
    destination_dir = (models / "base_models" / family).resolve()
    hf_token = str(payload.get("hf_token") or "").strip()
    civitai_key = str(payload.get("civitai_key") or "").strip()
    emit("Checking the download links…", phase="check")
    plan = []
    for item in items:
        url = check_url(item.get("url"))
        base_model = ""
        name = item.get("name")
        if host_of(url) in CIVITAI_HOSTS:
            info = civitai_item(url, civitai_key)
            url, name, base_model = info["url"], info["name"], info["base_model"]
        if not name:
            name = Path(urllib.parse.urlsplit(url).path).name
        name = safe_name(name)
        final, size = resolve_url(url, hf_token, civitai_key)
        target = (destination_dir / name).resolve()
        if target.parent != destination_dir:
            raise DownloadError("The file name is not usable")
        plan.append({"key": item.get("key"), "final": final, "size": size, "target": target, "base_model": base_model})
    needed = sum((entry["size"] or 0) for entry in plan if not (entry["target"].is_file() and entry["size"] and entry["target"].stat().st_size == entry["size"]))
    destination_dir.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(destination_dir).free
    if needed + MARGIN_BYTES > free:
        raise DownloadError(f"Not enough disk space: {needed / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free in {destination_dir}")
    exe = aria2_path(models / "_tools", lambda message: emit(message, phase="download"))
    files, bases = {}, []
    for number, entry in enumerate(plan, 1):
        target = entry["target"]
        if target.is_file() and entry["size"] and target.stat().st_size == entry["size"]:
            emit(f"Already downloaded: {target.name}")
        else:
            emit(f"Downloading {number} / {len(plan)}: {target.name}", phase="download")
            run_aria2(exe, entry["final"], target, entry["size"], emit)
        if entry["key"]:
            files[entry["key"]] = target.as_posix()
        if entry["base_model"]:
            bases.append(entry["base_model"])
    emit(f"Downloaded {len(plan)} file{'s' if len(plan) != 1 else ''} to {destination_dir}", type="downloaded", files=files, base_model=bases[0] if bases else "")
