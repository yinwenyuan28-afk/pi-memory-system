@echo off
rem ============================================================================
rem  Memory viewer one-click launcher (Windows).
rem
rem  Runs scripts/l1-admin/viewer.mts: sync latest pages -> start write-back
rem  bridge -> open the browser.
rem
rem  NOTE: this .bat is deliberately ASCII-only. cmd parses a .bat with the OEM
rem  code page BEFORE `chcp` takes effect, so non-ASCII text inside a .bat can
rem  render as mojibake on a cp936 console. The node script prints the Chinese
rem  messages; with `chcp 65001` below they display correctly.
rem
rem  Stop it by closing this window (closing the console kills the child
rem  processes) or by pressing Ctrl+C.
rem ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [NG] node not found in PATH.
  echo      Install Node.js ^>= 22.13 first, then run this again.
  echo.
  pause
  exit /b 1
)

node --experimental-strip-types scripts\l1-admin\viewer.mts %*
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo [NG] launcher exited with code %RC%. See the message above.
  echo.
  pause
)
exit /b %RC%
