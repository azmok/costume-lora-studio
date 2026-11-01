@echo off
rem Costume LoRA Studio - one-command launcher. Installs missing tools automatically.
cd /d "%~dp0"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"

rem ---- uv ----
where uv >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing uv...
  winget install -e --id astral-sh.uv --accept-package-agreements --accept-source-agreements
  call :refreshpath
)
where uv >nul 2>nul || goto :fail_uv

rem ---- Rust ----
where cargo >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing Rust...
  winget install -e --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
  call :refreshpath
)
where cargo >nul 2>nul || goto :fail_rust

rem ---- Node.js + pnpm (via fnm) ----
where pnpm >nul 2>nul
if not errorlevel 1 goto :have_pnpm
where fnm >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing fnm...
  winget install -e --id Schniz.fnm --accept-package-agreements --accept-source-agreements
  call :refreshpath
)
where fnm >nul 2>nul || goto :fail_node
for /f "tokens=*" %%i in ('fnm env --shell cmd') do %%i
where node >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing Node.js 24...
  call fnm install 24 || goto :fail_node
)
call fnm use 24 >nul 2>nul
for /f "tokens=*" %%i in ('fnm env --shell cmd') do %%i
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing pnpm...
  call corepack enable
  call corepack prepare pnpm@10.30.3 --activate || goto :fail_node
)
where pnpm >nul 2>nul || goto :fail_node
:have_pnpm

if not exist node_modules (
  echo [setup] pnpm install...
  call pnpm install || goto :fail_pnpm
)

if not exist ".venv\Lib\site-packages\torch" (
  echo [setup] uv sync - AI dependencies, first time only...
  uv sync --python 3.12 --extra inference || echo [WARN] uv sync failed. The app opens, but AI caption/mask needs it.
)

echo [start] Launching Costume LoRA Studio...
call pnpm dev
if errorlevel 1 goto :fail_dev
exit /b 0

:refreshpath
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%PATH%;%%P"
exit /b 0

:fail_uv
echo [ERROR] Could not install uv. Install it from https://docs.astral.sh/uv/ and run again.
goto :end
:fail_rust
echo [ERROR] Could not install Rust. Install it from https://rustup.rs/ and run again.
goto :end
:fail_node
echo [ERROR] Could not install Node.js / pnpm. Install them from https://nodejs.org/ and https://pnpm.io/ and run again.
goto :end
:fail_pnpm
echo [ERROR] pnpm install failed. See the messages above.
goto :end
:fail_dev
echo [ERROR] The app stopped with an error. If this is the first run, C++ Build Tools may be missing:
echo         https://visualstudio.microsoft.com/visual-cpp-build-tools/
:end
pause
exit /b 1
