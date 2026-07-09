# Start Sunshine
Start-Process "C:\Program Files\Sunshine\sunshine.exe" -WindowStyle Hidden

# Start Node.js Agent
Start-Process "node" -ArgumentList "C:\Agent\SunshineAgent\index.js" -WorkingDirectory "C:\Agent\SunshineAgent" -WindowStyle Hidden

# Start Moonlight Web Stream Web Server
Start-Process "C:\package(moonlight)\web-server.exe" -WorkingDirectory "C:\package(moonlight)" -WindowStyle Hidden

# Start Moonlight Web Stream Streamer
Start-Process "C:\package(moonlight)\streamer.exe" -WorkingDirectory "C:\package(moonlight)" -WindowStyle Hidden

# Start Nginx
Start-Process "C:\Users\Administrator\Downloads\nginx-1.31.2\nginx-1.31.2\nginx.exe" -WorkingDirectory "C:\Users\Administrator\Downloads\nginx-1.31.2\nginx-1.31.2" -WindowStyle Hidden

# Wait 5 seconds for services to start
Start-Sleep -Seconds 5

# Disconnect RDP while keeping the console active for Sunshine
$session = (query user $env:USERNAME | Select-String ">").Line.Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[1]
if ($session -ne "") {
    tscon.exe $session /dest:console
}
