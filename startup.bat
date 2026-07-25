@echo off
title Cloud Gaming Startup

echo [0/6] Cleaning up previous orphaned processes...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
taskkill /F /IM web-server.exe /T >nul 2>&1
timeout /t 2 /nobreak > nul

echo [0.5/6] Wiping stale Moonlight data to prevent ghost hosts...
del /F /Q "C:\package(moonlight)\data.json" >nul 2>&1

echo [1/6] Sunshine is now fully managed by its own official Windows Service.
echo        (Do not attempt to launch it here in Session 0 or it will crash!)
timeout /t 2 /nobreak > nul


echo [2/6] Starting Streamer...
cd /d "C:\package(moonlight)"
start /B streamer.exe

echo [3/6] Starting Agent and Web Server...
cd /d "C:\Agent\SunshineAgent"
start /B node index.js > C:\Agent\agent.log 2>&1

echo [4/6] Waiting a few seconds for services to initialize...
timeout /t 5 /nobreak > nul

echo All services launched!
