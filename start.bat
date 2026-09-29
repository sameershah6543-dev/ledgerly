@echo off
title Ledgerly Accounting
cd /d "%~dp0"
if not exist node_modules ( echo Installing dependencies... & call npm install )
echo Starting Ledgerly on http://localhost:3000
start "" http://localhost:3000
node server/index.js
pause
