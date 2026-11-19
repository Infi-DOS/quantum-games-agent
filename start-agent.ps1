<#
Starts Agent 1.0 (agent.mjs: one URL for TiqTaqToe and Cheqqers) with the parameters in .env, waits until it
is ready and shows its moves. With -Tunnel it also opens a public ngrok URL. Ctrl+C stops what this script
started, and nothing else.

  powershell -ExecutionPolicy Bypass -File start-agent.ps1             # http://127.0.0.1:<PORT in .env>/move
  powershell -ExecutionPolicy Bypass -File start-agent.ps1 -Port 9000  # another port, for this run only
  powershell -ExecutionPolicy Bypass -File start-agent.ps1 -Tunnel     # plus a public URL (the arena needs none)

An ngrok agent that is already running (another app's tunnel) is never stopped: the script prints its
tunnels and leaves the choice to you. The agent's log is in logs\agent-<date>-<time>.log.
#>
param([int]$Port = 0, [switch]$Tunnel)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logs = Join-Path $here 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$log = Join-Path $logs "agent-$stamp.log"
$agent = $null; $ngrok = $null

# The port: -Port for this run, else PORT from the shell, else from .env, else 8081.
if ($Port) { $env:PORT = "$Port" }
elseif ($env:PORT) { $Port = [int]$env:PORT }
else {
    $Port = 8081
    foreach ($line in (Get-Content (Join-Path $here '.env') -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 18 or newer is needed (https://nodejs.org).' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. Stop that program, or change PORT in .env (or use -Port)."
}

# Starts node agent.mjs with its output in $logFile (errors in $logFile.err) and waits, at most 60 s,
# until it is ready.
function Start-AgentProcess([string]$logFile) {
    $process = Start-Process node -ArgumentList 'agent.mjs' -WorkingDirectory $here -NoNewWindow -PassThru `
        -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
    $null = $process.Handle    # keeps the exit code readable after the process ends
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        if ($process.HasExited) {
            Get-Content $logFile, "$logFile.err" -ErrorAction SilentlyContinue | Select-Object -Last 20
            throw 'The agent stopped while starting.'
        }
        if (Select-String -Path $logFile -Pattern '\[agent\] ready' -Quiet) { return $process }
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'The agent did not become ready within 60 s.'
}

# Prints what was written to $file after byte $from, and returns where it ends now.
function Show-NewText([string]$file, [long]$from) {
    if (-not (Test-Path $file)) { return $from }
    $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($stream.Length -le $from) { return $from }
        [void]$stream.Seek($from, [System.IO.SeekOrigin]::Begin)
        $text = (New-Object System.IO.StreamReader($stream)).ReadToEnd()
        Write-Host -NoNewline $text
        return $stream.Position
    } finally { $stream.Dispose() }
}

try {
    Write-Host "Starting the agent on port $Port ..."
    $agent = Start-AgentProcess $log
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/health"
    Write-Host "Agent ready: $($health.version)" -ForegroundColor Green
    Write-Host "  TiqTaqToe search threads: $($health.tiqtaqtoe.searchThreadsReady), move prior $($health.tiqtaqtoe.movePrior); Cheqqers search threads: $($health.cheqqers.ready)"
    Select-String -Path $log -Pattern '^\[agent\] (parameters|the shell|\.env)' | ForEach-Object { Write-Host "  $($_.Line)" }
    Write-Host "  Local URL: http://127.0.0.1:$Port/move"

    if ($Tunnel) {
        $running = $null
        try { $running = (Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels } catch { }
        if ($running) {
            Write-Host "An ngrok agent is already running, so no tunnel was started (it is left alone):" -ForegroundColor Yellow
            $running | ForEach-Object { Write-Host "  $($_.public_url) -> $($_.config.addr)" }
            Write-Host "  Free ngrok accounts usually allow one agent. Stop that one yourself, then rerun with -Tunnel."
        } elseif (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
            Write-Host 'ngrok is not installed (https://ngrok.com/download); the agent runs locally only.' -ForegroundColor Yellow
        } else {
            $ngrok = Start-Process ngrok -ArgumentList 'http', "$Port" -PassThru -WindowStyle Hidden
            $url = $null
            for ($i = 0; $i -lt 40 -and -not $url; $i++) {
                Start-Sleep -Milliseconds 500
                try { $url = ((Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1).public_url } catch { }
            }
            if (-not $url) { throw 'ngrok did not report a public URL (is your authtoken configured? ngrok config add-authtoken <token>).' }
            $check = Invoke-RestMethod "$url/health" -Headers @{ 'ngrok-skip-browser-warning' = '1' }
            Write-Host ''
            Write-Host "  Public URL (send this to the organizer): $url/move" -ForegroundColor Green
            Write-Host "  Checked through the tunnel: $($check.status), supports $($check.supports -join ' and ')"
        }
    }
    Write-Host ''
    Write-Host "Moves appear below (log: $log). Ctrl+C stops the agent$(if ($ngrok) { ' and the tunnel' })."
    Write-Host 'If the agent stops by itself, it is started again on the same port, so the tunnel keeps working.'
    $shown = (Get-Item $log).Length; $shownErr = 0; $restarts = 0
    while ($true) {
        Start-Sleep -Milliseconds 500
        $shown = Show-NewText $log $shown
        $shownErr = Show-NewText "$log.err" $shownErr
        if ($agent.HasExited) {
            $restarts++
            Write-Host "[start-agent] the agent stopped (exit code $($agent.ExitCode)); starting it again ($restarts)..." -ForegroundColor Yellow
            $log = Join-Path $logs "agent-$(Get-Date -Format 'yyyyMMdd-HHmmss')-restart$restarts.log"
            try {
                $agent = Start-AgentProcess $log
                $shown = (Get-Item $log).Length; $shownErr = 0
                Write-Host "[start-agent] the agent is ready again (log: $log)" -ForegroundColor Green
            } catch {
                Write-Host "[start-agent] could not start it: $($_.Exception.Message) Trying again in 5 s." -ForegroundColor Red
                Start-Sleep -Seconds 5
            }
        }
    }
} finally {
    if ($ngrok -and -not $ngrok.HasExited) { Stop-Process -Id $ngrok.Id -Force -ErrorAction SilentlyContinue }
    if ($agent -and -not $agent.HasExited) { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue }
    Write-Host 'Stopped.'
}
