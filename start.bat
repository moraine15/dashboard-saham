@echo off
rem Start the dashboard on Windows. The first run creates .venv and installs the requirements.
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1

if exist ".venv\Scripts\python.exe" goto :install
rem "python" when it is on PATH, otherwise the py launcher that python.org installs.
set "PY="
python -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul && set "PY=python"
if not defined PY (
  py -3 -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul && set "PY=py -3"
)
if not defined PY goto :nopython
echo Creating the Python environment in .venv ...
%PY% -m venv .venv || goto :fail

:install
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail
".venv\Scripts\python.exe" app.py
rem Keep the window open after an error so the message can be read.
if errorlevel 1 pause
goto :eof

:nopython
echo Python 3.11 or newer is required: https://www.python.org/downloads/
pause
exit /b 1

:fail
echo Setup failed. Check the internet connection, then run start.bat again.
pause
exit /b 1
