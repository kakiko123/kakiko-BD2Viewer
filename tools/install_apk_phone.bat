@echo off
chcp 65001 >nul
rem Install the APK straight over USB (needs USB debugging on).
rem This bypasses file-manager transfer and vendor install blockers,
rem and prints the exact INSTALL_FAILED_* code if it still fails.
setlocal
set ADB=%~dp0..\toolchain\android-sdk\platform-tools\adb.exe
set APK=%~dp0..\BD2Viewer-1.08-debug.apk
if not exist "%ADB%" (
  echo [x] adb not found: %ADB%
  pause
  exit /b 1
)
if not exist "%APK%" (
  echo [x] apk not found: %APK%
  pause
  exit /b 1
)

echo == waiting for device ==
"%ADB%" wait-for-device
"%ADB%" devices

echo.
echo == device info ==
"%ADB%" shell getprop ro.build.version.release
"%ADB%" shell getprop ro.build.version.sdk
echo -- free space on /data (KB) --
"%ADB%" shell df -k /data

echo.
echo == uninstall old copy (safe: does NOT touch your asset folders) ==
"%ADB%" uninstall com.kkk.bd2viewer

echo.
echo == install ==
"%ADB%" install -r -t "%APK%"

echo.
echo Done. If it failed, the line above starting with Failure/INSTALL_FAILED_* is the exact reason.
pause
