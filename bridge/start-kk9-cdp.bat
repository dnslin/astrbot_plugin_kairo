@echo off
chcp 65001 >nul
title KK9 CDP Launcher
cls

echo ====================================================
echo 正在以 CDP 调试模式启动 KK9 客户端...
echo 调试端口: 9222
echo ====================================================

set "KK_EXE="

if exist "%LOCALAPPDATA%\Programs\KK9\KK9.exe" (
    set "KK_EXE=%LOCALAPPDATA%\Programs\KK9\KK9.exe"
    goto :LAUNCH
)

if exist "%LOCALAPPDATA%\Programs\kk\KK.exe" (
    set "KK_EXE=%LOCALAPPDATA%\Programs\kk\KK.exe"
    goto :LAUNCH
)

if exist "C:\Program Files\KK9\KK9.exe" (
    set "KK_EXE=C:\Program Files\KK9\KK9.exe"
    goto :LAUNCH
)

if exist "C:\Program Files (x86)\KK9\KK9.exe" (
    set "KK_EXE=C:\Program Files (x86)\KK9\KK9.exe"
    goto :LAUNCH
)

:LAUNCH
if "%KK_EXE%"=="" (
    echo [错误] 未在默认路径找到 KK9 客户端安装程序。
    echo 请检查路径: %LOCALAPPDATA%\Programs\KK9\KK9.exe
    echo.
    pause
    exit /b 1
)

echo 找到程序: "%KK_EXE%"
echo 正在启动命令: "%KK_EXE%" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
start "" "%KK_EXE%" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222

echo.
echo ====================================================
echo KK9 启动指令已发出！
echo 请确认 KK9 界面已正常显示且未最小化。
echo ====================================================
echo.
pause
