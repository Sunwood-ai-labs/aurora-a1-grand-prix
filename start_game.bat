@echo off
rem AURORA A1 Grand Prix - local launcher (needs Python 3)
cd /d "%~dp0"
start "" http://localhost:8765/
python -m http.server 8765
