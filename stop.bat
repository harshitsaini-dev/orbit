@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   Orbit - stopping local development servers
echo   ------------------------------------------

set "STOPPED=0"

call :kill_port 8787 API
call :kill_port 5173 "web app"

REM Close the console windows start.bat opened, if they are still around.
taskkill /f /fi "WINDOWTITLE eq Orbit API*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq Orbit Web*" >nul 2>&1

echo.
if "!STOPPED!"=="0" (
  echo   Nothing was running.
) else (
  echo   Done.
)
echo.
endlocal
exit /b 0

REM ---------------------------------------------------------------------------
REM Kills whatever holds the port, and its children - npm spawns node, so
REM killing only the parent would leave the port bound.
:kill_port
set "PORT=%~1"
set "LABEL=%~2"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
  if not "%%p"=="0" (
    taskkill /f /t /pid %%p >nul 2>&1
    if not errorlevel 1 (
      echo   Stopped %LABEL% on port %PORT% ^(pid %%p^)
      set "STOPPED=1"
    )
  )
)
exit /b 0
