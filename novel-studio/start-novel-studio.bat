@echo off
setlocal

cd /d "%~dp0"

title Novel Studio Launcher

echo [INFO] Checking runtime...
where node >nul 2>&1
if errorlevel 1 (
	echo [ERROR] Node.js not found in PATH.
	echo Install Node.js 18+ and try again.
	pause
	exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
	echo [ERROR] npm not found in PATH.
	pause
	exit /b 1
)

if not exist "node_modules" (
	echo [INFO] Installing dependencies...
	call npm.cmd install --ignore-scripts
	if errorlevel 1 (
		echo [ERROR] npm install failed.
		pause
		exit /b 1
	)
)

echo [INFO] Building project...
call npm.cmd run build
if errorlevel 1 (
	echo [ERROR] Build failed.
	pause
	exit /b 1
)

echo [INFO] Opening browser: http://127.0.0.1:4310
start "" "http://127.0.0.1:4310"

echo [INFO] Starting Novel Studio server...
call npm.cmd run start
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
	echo [ERROR] Server exited with code %EXIT_CODE%.
	pause
)

exit /b %EXIT_CODE%