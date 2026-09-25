@echo off
REM ============================================================
REM  BD2 L2D Viewer - one-shot APK build
REM
REM  Steps:
REM    1) inline CSS/JS   ->  public/app.bundle.html
REM    2) sync them       ->  app/src/main/assets/web/
REM    3) gradle assembleDebug
REM    4) verify the APK: 3-way sha1 + manifest
REM
REM  This file is intentionally pure ASCII and saved as CRLF.
REM  cmd.exe reads .bat files using the current ANSI code page, so
REM  non-ASCII text here gets mis-decoded on some machines and can
REM  silently break the rest of the script. Keep it ASCII.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "ROOT=%CD%"
set "ANDROID_DIR=%ROOT%\bd2-android"
set "VIEWER_DIR=%ROOT%\bd2-local-viewer"

echo.
echo ============================================================
echo   BD2 L2D Viewer - build debug APK
echo ============================================================
echo.

REM ---- locate node -------------------------------------------
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node.js 18 or newer.
  pause
  exit /b 1
)

REM ---- locate a JDK ------------------------------------------
if not defined JAVA_HOME (
  if exist "%ROOT%\toolchain\jdk17\bin\java.exe" set "JAVA_HOME=%ROOT%\toolchain\jdk17"
)
if defined JAVA_HOME (
  set "PATH=%JAVA_HOME%\bin;%PATH%"
  echo [info] JAVA_HOME = %JAVA_HOME%
) else (
  echo [warn] JAVA_HOME not set - relying on PATH. Gradle needs JDK 17.
)

REM ---- Android SDK must be reachable -------------------------
if not defined ANDROID_HOME if exist "%ROOT%\toolchain\android-sdk" set "ANDROID_HOME=%ROOT%\toolchain\android-sdk"
if defined ANDROID_HOME (
  set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
  echo [info] ANDROID_HOME = %ANDROID_HOME%
)
if not exist "%ANDROID_DIR%\local.properties" (
  if not defined ANDROID_HOME (
    echo [ERROR] No Android SDK found.
    echo         Set ANDROID_HOME, or create bd2-android\local.properties with:
    echo             sdk.dir=C:/path/to/Android/Sdk
    pause
    exit /b 1
  )
)

REM ---- step 1 and 2: build the single-file frontend ----------
echo.
echo [1/3] bundling frontend ...
pushd "%VIEWER_DIR%"
"%NODE_EXE%" _tools\bundle.mjs
if errorlevel 1 (
  echo [ERROR] bundle.mjs failed.
  popd
  pause
  exit /b 1
)
"%NODE_EXE%" _tools\sync_assets.mjs
if errorlevel 1 (
  echo [ERROR] sync_assets.mjs failed.
  popd
  pause
  exit /b 1
)
popd

REM ---- step 3: compile ---------------------------------------
echo.
echo [2/3] gradle assembleDebug ...
pushd "%ANDROID_DIR%"
if exist "gradlew.bat" (
  call gradlew.bat --no-daemon assembleDebug
  set "RC=!ERRORLEVEL!"
) else if exist "%ROOT%\toolchain\gradle\bin\gradle.bat" (
  call "%ROOT%\toolchain\gradle\bin\gradle.bat" --no-daemon assembleDebug
  set "RC=!ERRORLEVEL!"
) else (
  echo [ERROR] Neither gradlew.bat nor a bundled Gradle was found.
  popd
  pause
  exit /b 1
)
popd
if not "!RC!"=="0" (
  echo.
  echo [ERROR] Gradle build failed. See the output above.
  pause
  exit /b 1
)

REM ---- step 4: verify ---------------------------------------
echo.
echo [3/3] verifying APK ...
set "PY_EXE="
where python >nul 2>nul && set "PY_EXE=python"
if not defined PY_EXE where py >nul 2>nul && set "PY_EXE=py"
if defined PY_EXE (
  "%PY_EXE%" "%ROOT%\tools\verify_apk.py"
) else (
  echo [skip] Python not found - skipping verify_apk.py
)

echo.
echo ============================================================
echo   Done.
echo   APK: %ROOT%\BD2Viewer-debug.apk
echo        %ANDROID_DIR%\app\build\outputs\apk\debug\app-debug.apk
echo ============================================================
echo.
pause
