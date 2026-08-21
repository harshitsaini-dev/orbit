@echo off
cd /d "%~dp0"

echo.
echo   Orbit - restarting
echo   ------------------

call "%~dp0stop.bat"

REM Windows releases a listening socket a moment after the process dies; without
REM this pause start.bat can still see the port as busy and refuse.
REM `ping` rather than `timeout`, which aborts when stdin is redirected.
ping -n 4 127.0.0.1 >nul

call "%~dp0start.bat"
exit /b %errorlevel%
