# Start Sunshine
Start-Process "C:\Program Files\Sunshine\sunshine.exe" -WindowStyle Hidden

# Start Node.js Agent
Start-Process "node" -ArgumentList "C:\SunshineAgent-main\index.js" -WorkingDirectory "C:\SunshineAgent-main" -WindowStyle Hidden

# Start Moonlight Web Stream Web Server (Update path as needed)
Start-Process "C:\moonlight-web-stream\web-server.exe" -WorkingDirectory "C:\moonlight-web-stream" -WindowStyle Hidden

# Start Moonlight Web Stream Streamer (Update path as needed)
Start-Process "C:\moonlight-web-stream\Streamer.exe" -WorkingDirectory "C:\moonlight-web-stream" -WindowStyle Hidden

# Wait 5 seconds for services to start
Start-Sleep -Seconds 5

# Disconnect RDP while keeping the console active for Sunshine
$session = (query user $env:USERNAME | Select-String ">").Line.Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[1]
if ($session -ne "") {
    tscon.exe $session /dest:console
}
