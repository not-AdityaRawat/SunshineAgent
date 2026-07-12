@echo off
title Cloud Gaming Startup

echo [0/6] Cleaning up previous orphaned processes...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
taskkill /F /IM web-server.exe /T >nul 2>&1
taskkill /F /IM sunshine.exe /T >nul 2>&1
timeout /t 2 /nobreak > nul

echo [1/6] Initializing Sunshine Database...
del /q "C:\Program Files\Sunshine\config\sunshine_state.json" >nul 2>&1
cd /d "C:\Program Files\Sunshine"
start "" "sunshine.exe"
timeout /t 3 /nobreak > nul
taskkill /F /IM sunshine.exe /T >nul 2>&1
timeout /t 1 /nobreak > nul

echo [1.5/6] Setting Sunshine Web UI credentials...
cmd /c "sunshine.exe" --creds admin 20216401523

echo [1.5/6] Starting Sunshine Background Service...
start /B "" "sunshine.exe"
timeout /t 3 /nobreak > nul


echo [2/6] Starting Streamer...
cd /d "C:\package(moonlight)"
start /B streamer.exe

echo [3/6] Starting Agent and Web Server...
cd /d "C:\Agent\SunshineAgent"
start /B node index.js > C:\Agent\agent.log 2>&1

echo [4/6] Waiting a few seconds for services to initialize...
timeout /t 5 /nobreak > nul

echo [5/6] Authenticating Ngrok...
"C:\Agent\ngrok.exe" config add-authtoken 3GK20QdTW8L53v71M3GKz3uyFsq_2AS5Bochuvh17XStC9Dw8

echo [6/6] Starting Ngrok Tunnel...
start "Ngrok" /B "C:\Agent\ngrok.exe" http --domain=juiciness-subsidy-operating.ngrok-free.dev 8080 > C:\Agent\ngrok.log 2>&1

echo All services launched!
