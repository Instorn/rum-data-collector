@echo off
REM  build-extension.cmd
REM  Step 1 of 2: installs dependencies from package-lock.json and builds
REM  dist\extension\ (unpacked extension). Then run build-cws.cmd.
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node.exe not found in PATH.
  echo Install Node.js or add it to PATH.
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd not found in PATH.
  echo Usually it is installed with Node.js in C:\Program Files\nodejs.
  exit /b 1
)

echo [1/2] Installing dependencies from package-lock.json...
call npm.cmd ci --loglevel=error
if errorlevel 1 exit /b %errorlevel%

echo [2/2] Building extension...
call npm.cmd run build
if errorlevel 1 exit /b %errorlevel%

echo.
echo Extension is built:
echo   %~dp0dist\extension
echo.
echo Next: build-cws.cmd packs it into the Chrome Web Store ZIP.

endlocal
