@echo off
REM  build-cws.cmd
REM  Step 2 of 2: packs dist\extension\ into the Chrome Web Store upload package
REM  dist\cws\rum_data_collector-<version>.zip (+ .files.txt with SHA-256).
REM  Requires step 1 (build-extension.cmd). dist\extension\ is not modified.
REM  The ZIP has no update_url and no settings.json.
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node.exe not found in PATH.
  echo Install Node.js or add it to PATH.
  exit /b 1
)

if not exist "node_modules\fflate\package.json" (
  echo ERROR: node_modules\fflate not found.
  echo Run build-extension.cmd first ^(it runs npm ci^).
  exit /b 1
)

if not exist "dist\extension\manifest.json" (
  echo ERROR: dist\extension\manifest.json not found.
  echo Run build-extension.cmd first to build the extension.
  exit /b 3
)

echo [1/1] Packing Chrome Web Store ZIP...
call node package-cws.mjs
if errorlevel 1 exit /b %errorlevel%

echo.
echo Chrome Web Store package is ready in:
echo   %~dp0dist\cws

endlocal
