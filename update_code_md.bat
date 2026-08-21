@echo off
rem =====================================================================
rem  update_code_md.bat
rem  Regenerate project_code.md from the source files in this folder.
rem  Runs consolidate_code.py with default settings (scan current dir,
rem  write project_code.md next to this script).
rem =====================================================================
setlocal
cd /d "%~dp0"

if not exist "consolidate_code.py" (
    echo ERROR: consolidate_code.py not found in "%~dp0"
    pause
    exit /b 1
)

rem Prefer `python`; fall back to `py -3` when not on PATH.
set "PYCMD=python"
where python >nul 2>nul
if errorlevel 1 set "PYCMD=py -3"

echo Scanning current folder and writing project_code.md ...
%PYCMD% consolidate_code.py
if errorlevel 1 (
    echo.
    echo ERROR: Failed to generate markdown. Is Python installed and on PATH?
) else (
    echo.
    echo Markdown updated: project_code.md
)

pause
endlocal