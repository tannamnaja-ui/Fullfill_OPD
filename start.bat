@echo off
chcp 65001 >nul
title ตรวจสอบความสมบูรณ์ข้อมูล OPD (port 3006)
cd /d "%~dp0"
if not exist node_modules ( echo [ติดตั้ง dependencies] & call npm install )
echo เปิดใช้งานที่ http://localhost:3006
node server\index.js
pause
