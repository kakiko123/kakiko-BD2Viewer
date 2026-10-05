@echo off
chcp 65001 >nul
rem Capture the Android crash log. Plug in the phone (USB debugging on),
rem double-click this file, then reproduce the crash on the phone.
setlocal
set ADB=%~dp0..\toolchain\android-sdk\platform-tools\adb.exe
if not exist "%ADB%" (
  echo [x] adb not found: %ADB%
  pause
  exit /b 1
)

echo == waiting for device ==
"%ADB%" wait-for-device
"%ADB%" devices

echo == clearing old logs ==
"%ADB%" logcat -c
"%ADB%" logcat -b crash -c

echo.
echo ############################################################
echo   Now REPRODUCE the crash on the phone (open app, scan).
echo   Press any key here AFTER the crash happened.
echo ############################################################
pause >nul

set OUT=%~dp0..\_scratch\android_crash.txt
echo == dumping to %OUT% ==
"%ADB%" logcat -d -b crash -b main -b system > "%OUT%" 2>&1
"%ADB%" logcat -d -b crash >> "%OUT%" 2>&1

echo.
echo == crash-related lines ==
findstr /n /i "FATAL AndroidRuntime bd2viewer OutOfMemory SIGSEGV SIGABRT signal abort Zygote" "%OUT%"

echo.
echo full log: %OUT%
pause
