@echo off
chcp 65001 >nul 2>nul
rem 调试台现在由 DSH 的 dsh-wechat 插件提供（原来的 8787 那套 bot 已经不用了）
start "" "http://127.0.0.1:8791/debug"
