@echo off
chcp 65001 >nul
setlocal
set "NODE="
set "ELEC="

rem 找一样能跑 JS 的东西，按顺序试：
rem   1) PATH 里的 node
rem   2) 常见的 Node.js 安装位置
rem   3) dsh 自己带的 Electron —— 桌面版内置了 Node，机器上没单独装 Node 也能用
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"

if not defined NODE call :probe "%DSH_EXE%"
if not defined NODE call :probe "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not defined NODE call :probe "%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe"
if not defined NODE call :probe "D:\DeepSeekHarness\DeepSeek Harness.exe"

if not defined NODE (
  echo.
  echo [!] 没找到 Node.js，也没自动找到 dsh 自带的那个。
  echo.
  echo     两条路，任选一条：
  echo       1. 去 https://nodejs.org 装个 Node.js，然后重新双击本脚本；
  echo       2. 或者告诉它 dsh 装在哪（在下面这行填好你的真实路径，再回车执行一次）：
  echo.
  echo          set "DSH_EXE=C:\某目录\DeepSeek Harness.exe"
  echo.
  pause
  exit /b 1
)

rem 借用 dsh 的 Electron 时，得让它以 node 模式跑
if defined ELEC set "ELECTRON_RUN_AS_NODE=1"
"%NODE%" "%~dp0install.mjs" %*
set "RC=%ERRORLEVEL%"
if defined ELEC set "ELECTRON_RUN_AS_NODE="
echo.
pause
exit /b %RC%

:probe
if not "%~1"=="" if exist "%~1" (
  set "NODE=%~1"
  set "ELEC=1"
)
goto :eof
