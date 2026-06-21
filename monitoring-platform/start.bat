@echo off
echo ================================================================
echo   Monitoring Platform — Demarrage
echo ================================================================
echo.

echo [1/2] Demarrage du backend FastAPI (port 8000)...
start "Backend - FastAPI" cmd /k "cd /d %~dp0backend && pip install -r requirements.txt -q && python -m uvicorn main:app --reload --port 8000"

timeout /t 3 /nobreak >nul

echo [2/2] Demarrage du frontend React (port 5173)...
start "Frontend - React" cmd /k "cd /d %~dp0frontend && npm install && npm run dev"

echo.
echo ================================================================
echo   Frontend : http://localhost:5173
echo   Backend  : http://localhost:8000
echo   API docs : http://localhost:8000/docs
echo ================================================================
echo.
pause
