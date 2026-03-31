#!/usr/bin/env powershell
# Quick Start: Camera Waste Detection Feature
# This script sets up and tests the waste detection system

Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Smart Drainage Camera Waste Detection - Quick Start           ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Step 1: Verify environment
Write-Host "📋 Step 1: Verifying environment..." -ForegroundColor Yellow
Write-Host ""

$projectRoot = "C:\Users\22303096\Project\Demo"
$venvPath = "C:\Users\22303096\Project\.venv"
$pythonExe = "$venvPath\Scripts\python.exe"

if (-not (Test-Path $venvPath)) {
    Write-Host "❌ Virtual environment not found at $venvPath" -ForegroundColor Red
    Write-Host "   Please create it first with: python -m venv C:\Users\22303096\Project\.venv" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Virtual environment found" -ForegroundColor Green
Write-Host ""

# Step 2: Install dependencies
Write-Host "📦 Step 2: Installing dependencies..." -ForegroundColor Yellow

$backendReqs = "$projectRoot\backend\requirements.txt"
if (Test-Path $backendReqs) {
    Write-Host "   Installing backend packages..." -ForegroundColor Cyan
    & $pythonExe -m pip install -q -r $backendReqs
    Write-Host "✅ Backend dependencies installed" -ForegroundColor Green
}

$edgeReqs = "$projectRoot\edge\requirements.txt"
if (Test-Path $edgeReqs) {
    Write-Host "   Installing edge packages..." -ForegroundColor Cyan
    & $pythonExe -m pip install -q -r $edgeReqs
    Write-Host "✅ Edge dependencies installed" -ForegroundColor Green
}

Write-Host ""

# Step 3: Check configuration
Write-Host "⚙️  Step 3: Checking configuration..." -ForegroundColor Yellow

$envFile = "$projectRoot\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "   .env file not found. Creating from template..." -ForegroundColor Cyan
    $exampleEnv = "$projectRoot\.env.example"
    if (Test-Path $exampleEnv) {
        Copy-Item $exampleEnv $envFile
        Write-Host "✅ Created .env from template" -ForegroundColor Green
        Write-Host "   📝 Edit .env with your MQTT broker details" -ForegroundColor Yellow
    }
} else {
    Write-Host "✅ .env file exists" -ForegroundColor Green
}

Write-Host ""

# Step 4: Provide run instructions
Write-Host "🚀 Step 4: Ready to run!" -ForegroundColor Yellow
Write-Host ""
Write-Host "   Run these commands in separate PowerShell terminals:" -ForegroundColor Cyan
Write-Host ""

Write-Host "   Terminal 1 - Start Backend:" -ForegroundColor Green
Write-Host "   ────────────────────────────" -ForegroundColor Green
Write-Host "   cd $projectRoot" -ForegroundColor DarkGray
Write-Host "   $pythonExe -m uvicorn backend.app.main:app --app-dir . --host 127.0.0.1 --port 8000 --reload" -ForegroundColor DarkGray
Write-Host ""

Write-Host "   Terminal 2 - Start Dashboard:" -ForegroundColor Green
Write-Host "   ────────────────────────────" -ForegroundColor Green
Write-Host "   cd $projectRoot" -ForegroundColor DarkGray
Write-Host "   npm run dev" -ForegroundColor DarkGray
Write-Host ""

Write-Host "   Terminal 3 (Optional) - Run Edge Runtime:" -ForegroundColor Green
Write-Host "   ────────────────────────────" -ForegroundColor Green
Write-Host "   cd $projectRoot" -ForegroundColor DarkGray
Write-Host "   $pythonExe edge\layer2_edge_runtime.py" -ForegroundColor DarkGray
Write-Host ""

# Step 5: Test commands
Write-Host "🧪 Step 5: Test the feature" -ForegroundColor Yellow
Write-Host ""

Write-Host "   Option A - Run Demo Simulation:" -ForegroundColor Green
Write-Host "   ────────────────────────────" -ForegroundColor Green
Write-Host "   (No MQTT broker needed)" -ForegroundColor DarkGray
Write-Host "   $pythonExe scripts\test_mqtt_publish.py" -ForegroundColor DarkGray
Write-Host ""

Write-Host "   Option B - Test Waste Detection:" -ForegroundColor Green
Write-Host "   ────────────────────────────" -ForegroundColor Green
Write-Host "   (Requires MQTT)" -ForegroundColor DarkGray
Write-Host "   $pythonExe scripts\test_waste_detection.py" -ForegroundColor DarkGray
Write-Host ""

Write-Host "   Option C - View Dashboard:" -ForegroundColor Green
Write-Host "   ────────────────────────────" -ForegroundColor Green
Write-Host "   Open http://localhost:5173 in your browser" -ForegroundColor DarkGray
Write-Host ""

# Summary
Write-Host "📋 Quick Reference:" -ForegroundColor Cyan
Write-Host ""
Write-Host "   Camera Feed Component      → src/components/CameraFeed.jsx" -ForegroundColor DarkGray
Write-Host "   Backend Camera Endpoint    → backend/app/main.py (/api/v1/camera-stream)" -ForegroundColor DarkGray
Write-Host "   Waste Detection Thread     → edge/layer2_edge_runtime.py (WasteDetectionThread)" -ForegroundColor DarkGray
Write-Host "   Test Script                → scripts/test_waste_detection.py" -ForegroundColor DarkGray
Write-Host "   Documentation              → CAMERA_WASTE_DETECTION.md" -ForegroundColor DarkGray
Write-Host ""

Write-Host "✨ Setup complete! The camera waste detection feature is ready to use." -ForegroundColor Green
Write-Host ""
