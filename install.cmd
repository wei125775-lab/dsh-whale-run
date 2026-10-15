@echo off
setlocal
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE (
  echo [!] 找不到 node，请手动装一个或把 node 放进 PATH。
  pause
  exit /b 1
)
"%NODE%" "%~dp0install.mjs" %*
echo.
pause
