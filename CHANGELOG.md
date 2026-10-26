# 更新记录

## 0.1.0 — 2026-10-26

首个可用版本：把个人微信接进 DSH，收发都走工具。

**核心**

- 宿主半边：HTTP 接入（`127.0.0.1:8791` 收桥接推送 + 心跳）、桥接控制转发（`8792`）
- 六个工具：`wechat_status` / `wechat_get_unread` / `wechat_reply` / `wechat_send_message` / `wechat_list_chats` / `wechat_persona`
- 网页调试台：`http://127.0.0.1:8791/debug`（状态、队列、发消息、改配置、看日志）
- 可选自动回：`autoReply` + `agent.followup()`，群里只在被 @ 时接话

**踩过的坑（都已修）**

- 工具参数没转成 JSON Schema → 模型请求被拒：`Invalid schema for function ... got 'type: null'`
  （宿主的 `defineTool` 打在 `app.asar` 里拿不到，本地等价实现只校验不转换，所以自己补了转换）
- `output` 必须写成 `{ schema, render }`，`render` 放外层会注册失败
- 插件默认不接管桥接进程（`manageBridge: false`），避免与常驻桥接抢同一个微信窗口
- 工具内部异常一律兜住，不往外抛 —— 插件不该有能力让整轮对话失败

**已知限制**

- 只能驱动本机已登录的微信（UIA），不能远程
- 微信大版本升级可能让热激活失效：能收不能发
- 桥接若由 `启动微信.bat` 拉起，关掉那个窗口就停
