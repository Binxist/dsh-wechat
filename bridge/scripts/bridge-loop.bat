@echo off
chcp 65001 >nul 2>nul
rem 微信桥接常驻守护：登录自启 + 每 5 分钟看门狗（计划任务 WeChatBridge）。
rem 跟 DSH 完全解耦 —— DSH 关掉、重启都不影响它，它自己守着微信。
rem 幂等：控制端口 8792 已经在监听就直接退出，所以被反复拉起也不会出现两份。
rem 崩溃/微信更新把进程弄挂时，5 秒后自动重来（最多连续 20 次，防刷日志）。
cd /d "%~dp0.."
set "PY=%~dp0..\runtime\python\python.exe"
set "LOG=%~dp0..\data\bridge-console.log"

rem ── 幂等检查：已经在跑就什么也别做 ──────────────────────────────
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":8792 " >nul 2>&1
if not errorlevel 1 (
  echo [bridge-loop] %DATE% %TIME% 检测到 8792 已在监听，跳过 >> "%LOG%"
  exit /b 0
)

rem 桥接要把消息推给谁、控制端口开哪个：跟 mcp/server.js 里的默认值保持一致
set "WHALE_BOT_URL=http://127.0.0.1:8791/webhook/wechat"
set "WECHAT_BRIDGE_CONTROL_PORT=8792"
set "PYTHONIOENCODING=utf-8"
rem 代理会让语音/识别连不上，模型和国内站点都不需要
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="

set /a RESTARTS=0
:loop
echo [bridge-loop] start %DATE% %TIME% >> "%LOG%"
"%PY%" "%~dp0..\examples\wechatauto_bridge.py" >> "%LOG%" 2>&1
set CODE=%ERRORLEVEL%
echo [bridge-loop] exit code %CODE% at %DATE% %TIME% >> "%LOG%"
if "%CODE%"=="0" (
  echo [bridge-loop] 正常退出（有人手动停的？），不再自动拉起 >> "%LOG%"
  exit /b 0
)
set /a RESTARTS+=1
if %RESTARTS% GEQ 20 (
  echo [bridge-loop] 连续失败 %RESTARTS% 次，停止重试，等人来看 >> "%LOG%"
  exit /b 1
)
timeout /t 5 /nobreak >nul
goto loop
