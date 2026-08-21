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

if not exist "logs\" mkdir "logs"

REM --- launch, hidden -------------------------------------------------------
REM Started through PowerShell rather than `start`, which always opens a window.
REM The API runs without watch mode: `tsx watch` wants an interactive console
REM and exits within seconds once hidden with its output redirected, which
REM looked exactly like the server crashing by itself. restart.bat is how a code
REM change gets picked up.
REM Output goes to logs\ instead: a background process with nowhere to write is
REM one you cannot debug when it misbehaves.
echo   Starting API      ^(http://localhost:8787^)
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run start:server > logs\api.log 2>&1' -WindowStyle Hidden -WorkingDirectory '%CD%'"

echo   Starting web app  ^(http://localhost:5173^)
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm run dev:web > logs\web.log 2>&1' -WindowStyle Hidden -WorkingDirectory '%CD%'"

REM --- wait until they actually answer --------------------------------------
echo   Waiting for them to come up...
set "READY=0"
for /l %%i in (1,1,30) do (
  if "!READY!"=="0" (
    ping -n 2 127.0.0.1 >nul
    call :is_port_busy 8787
    set "API=!BUSY!"
    call :is_port_busy 5173
    if "!API!"=="1" if "!BUSY!"=="1" set "READY=1"
  )
)

echo.
if "!READY!"=="1" (
  echo   Running in the background. Open http://localhost:5173
) else (
  echo   [X] They did not come up in time. Check logs\api.log and logs\web.log.
)
echo   Logs: logs\api.log and logs\web.log
echo   Run stop.bat to shut them down.
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
endlocal
exit /b 1

:fail
echo.
echo   Startup failed. Nothing was started.
echo.
endlocal
exit /b 1
