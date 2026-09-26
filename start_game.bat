@echo off
rem AURORA A1 Grand Prix - local launcher with Jev-Omni Decision Bridge
cd /d "%~dp0"
start "" http://localhost:8765/
python tools/jev_bridge.py --port 8765 %*
