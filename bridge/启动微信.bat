@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title 微信桥接 - 鲸鲸

rem 一个窗口搞定：调试台 + 桥接。跟 QQ 那边「启动微信桥接.bat」一个用法。
rem 调试台由 DSH 插件 dsh-wechat 提供（127.0.0.1:8791），所以 DSH 要开着。

netstat -ano | findstr /c:"127.0.0.1:8791" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [x] 没找到微信调试台：127.0.0.1:8791 没在监听。
  echo       它由 DSH 的 dsh-wechat 插件提供，请先打开 DeepSeek Harness，
  echo       再双击这个文件。
  echo.
  pause
  exit /b 1
)

echo   ============================================
echo     微信桥接
echo   ============================================
echo.
echo   调试台： http://127.0.0.1:8791/debug
echo.
start "" http://127.0.0.1:8791/debug

rem 桥接已经在跑就不重复起（两个桥接抢同一个微信窗口，会互相踩）
netstat -ano | findstr /c:"127.0.0.1:8792" >nul 2>&1
if not errorlevel 1 (
  echo   [i] 桥接已经在跑了（8792 在监听），不重复启动。
  echo       要重启就先关掉那个 python.exe（wechatauto_bridge.py）。
  echo.
  pause
  exit /b 0
)

echo   正在启动桥接…（第一次会先连数据库、预热 UIA，约 10 秒）
echo   需要：微信 4.x 已登录。日志会在这个窗口里刷。
echo.
call "%~dp0scripts\bridge-loop.bat"
set "CODE=%ERRORLEVEL%"
echo.
echo   桥接已退出（code %CODE%）。
pause >nul
exit /b %CODE%
