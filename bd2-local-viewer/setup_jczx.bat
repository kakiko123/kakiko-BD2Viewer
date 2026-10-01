@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Create repo-local .venv-jczx next to bd2-local-viewer (or under it) and install UnityPy.
REM After this, the viewer auto-discovers the venv — NO BD2_JCZX_PYTHON needed.
REM Internet required once for pip install.

set "REPO=%~dp0.."
set "VENV=%REPO%\.venv-jczx"
set "REQ=%~dp0_tools\requirements-jczx.txt"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY where python3 >nul 2>nul && set "PY=python3"

if not defined PY (
  echo.
  echo   [ERROR] Python not found on PATH.
  echo   Install Python 3.10+ from https://www.python.org/downloads/
  echo   and check "Add python.exe to PATH", then re-run this script.
  echo.
  pause
  exit /b 1
)

echo.
echo   JCZX setup: creating "%VENV%"
echo   Using: %PY%
echo.

if not exist "%VENV%\Scripts\python.exe" (
  %PY% -m venv "%VENV%"
  if errorlevel 1 (
    echo   [ERROR] python -m venv failed.
    pause
    exit /b 1
  )
) else (
  echo   venv already exists, installing / upgrading deps...
)

"%VENV%\Scripts\python.exe" -m pip install --upgrade pip
"%VENV%\Scripts\python.exe" -m pip install -r "%REQ%"
if errorlevel 1 (
  echo.
  echo   [ERROR] pip install failed. Check network / proxy, then retry.
  echo.
  pause
  exit /b 1
)

"%VENV%\Scripts\python.exe" -c "import UnityPy; print('UnityPy', getattr(UnityPy,'__version__','ok'))"
if errorlevel 1 (
  echo   [ERROR] UnityPy import still failed.
  pause
  exit /b 1
)

echo.
echo   Done. Start the viewer with start.bat — JCZX mode needs no env var.
echo   Optional override only: set BD2_JCZX_PYTHON=%VENV%\Scripts\python.exe
echo.
pause
exit /b 0
