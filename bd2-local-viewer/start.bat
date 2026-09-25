@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:/Program Files/nodejs/node.exe" set "NODE_EXE=C:/Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting BD2 Local L2D Viewer...
echo   A browser window will open automatically.
echo   Keep this window open while you use the viewer. Press Ctrl+C to stop.
echo.

"%NODE_EXE%" "%~dp0server.mjs" --open

echo.
echo   Server stopped.
pause
