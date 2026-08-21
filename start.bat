@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   Orbit - starting local development servers
echo   ------------------------------------------

REM --- refuse to start twice: a stale server would serve stale code ---------
call :is_port_busy 8787
if "!BUSY!"=="1" (
  set "TAKEN=8787"
  goto :busy
)
call :is_port_busy 5173
if "!BUSY!"=="1" (
  set "TAKEN=5173"
  goto :busy
)

REM --- prerequisites --------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js was not found on PATH. Install Node 20 or newer.
  goto :fail
)

if not exist "node_modules\" (
  echo   Installing dependencies ^(first run, this takes a minute^)...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist ".env" (
  echo   Creating .env from .env.example
  copy /y ".env.example" ".env" >nul
  echo.
  echo   [i] .env has no secrets yet. See docs\05-owner-setup.md.
  echo       Local mode runs fine without them.
  echo.
)

if not exist "orbit.db" (
  echo   Creating the local database...
  call npm run db:migrate
  if errorlevel 1 goto :fail
)

REM --- launch ---------------------------------------------------------------
echo   Starting API      ^(http://localhost:8787^)
start "Orbit API" cmd /k "npm run dev:server"

echo   Starting web app  ^(http://localhost:5173^)
start "Orbit Web" cmd /k "npm run dev:web"

echo.
echo   Two windows opened. Closing them, or running stop.bat, shuts Orbit down.
echo   Open http://localhost:5173 once the web window says "ready".
echo.
endlocal
exit /b 0

REM ---------------------------------------------------------------------------
:is_port_busy
set "BUSY=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do set "BUSY=1"
exit /b 0

:busy
echo   [X] Port !TAKEN! is already in use, so Orbit was not started.
echo       Something is still running - use restart.bat, or stop.bat first.
echo.
pause
endlocal
exit /b 1

:fail
echo.
echo   Startup failed. Nothing was started.
echo.
pause
endlocal
exit /b 1
