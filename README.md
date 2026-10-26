# dsh-wechat

把**个人微信**接进 DeepSeek Harness 的插件。收发都走工具，桥接进程自己托底。

## 安装

这个包不含桥接本体（Python 那套），需要另外准备；缺了它插件能加载、但收发不通。

1. **放插件**：解压到 `%USERPROFILE%\.dsh\plugins\dsh-wechat`
2. **挂进 profile**：编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`
   - `dependencies` 加一行：`"dsh-wechat": "link:C:/Users/<你>/.dsh/plugins/dsh-wechat"`
   - `dsh.profile.bundles` 数组里加一项：`"dsh-wechat"`
3. **建链接**：在 `profiles\desktop\node_modules` 里建一个指向插件目录的 junction
   （`mklink /J dsh-wechat C:\Users\<你>\.dsh\plugins\dsh-wechat`），或让 pnpm install 处理
4. **重启 DSH**（插件不会热重载）
5. **配桥接路径**：编辑 `%USERPROFILE%\.dsh\wechat-plugin.json`，把 `project` 指到你放桥接项目的目录
6. **起桥接**：项目里的 `启动微信.bat`（或直接 `runtime\python\python.exe examples\wechatauto_bridge.py`）

验证：`http://127.0.0.1:8791/debug` 打开能看到状态；`wechat_status` 返回 `bridgeOnline: true`。

> 桥接项目必须在**纯英文路径**下、且与 DSH **同一个盘符习惯**（实测 D 盘上的可执行文件
> 会被 DSH 沙箱限制成看不到微信进程，C 盘用户目录下正常）。

## 它做什么

```
微信客户端（本机登录着）
      ↕  UIA 自动化 / 只读解密数据库
桥接进程（Python，examples/wechatauto_bridge.py）
      ↕  HTTP：8791 推消息 / 8792 发消息
dsh-wechat 插件（宿主半边，本包）
      ↕  ctx.tools.register
DSH 会话（wechat_status / wechat_get_unread / wechat_reply / wechat_send_message）
```

- **收**：桥接把消息 POST 到插件，插件立刻回「收到」，消息进本地队列 —— 不让桥接的 120 秒
  超时绑住模型思考时间。
- **发**：模型调 `wechat_reply`，插件转给桥接的控制端口，由桥接用 UIA 发，发完回读数据库校验。
- **托底**：插件每 15 秒探一次桥接的控制端口，掉线就拉起来；也可以让桥接由
  计划任务常驻（那时插件探测到在线就不会多拉一份）。

## 配置

`~/.dsh/wechat-plugin.json`（首次不用建，缺省值就是下面这套）：

```json
{
  "project": "C:\\Users\\<你>\\whale-girl-3.4.9",
  "webhookPort": 8791,
  "controlPort": 8792,
  "allowChats": ["filehelper"],
  "allowInbound": [],
  "denyInbound": [],
  "masters": [],
  "autoReply": false,
  "autoReplySession": "",
  "personaFile": "mcp/persona.md",
  "replyCooldownSec": 20,
  "maxRepliesPerHour": 20
}
```

| 字段 | 说明 |
|---|---|
| `project` | 桥接项目目录（`runtime/python` 和 `examples/wechatauto_bridge.py` 在那儿） |
| `allowChats` | 允许**主动发起**的会话；不在名单里的，只有「它先找过我们」才能回 |
| `allowInbound` | 非空时只收名单内的会话；空 = 谁都能进队列 |
| `denyInbound` | 永远丢弃，优先于 allow |
| `masters` | 非空时只有这些人能下指令；空 = 不区分 |
| `autoReply` | 收到消息自动开一轮（默认**关**） |
| `autoReplySession` | 自动回交给哪个会话（`ctx.agents.get(id)` 的 id） |
| `personaFile` | 角色卡路径，相对 `project` |
| 冷却/上限 | 同一会话 20 秒一条、每小时 20 条，防刷屏 |

## 角色卡

`wechat_persona` 读的是 `project/mcp/persona.md`，内容来自 qq-bridge 的
`roles/易知鱼.md`（QQ 那边当前用的那张卡）。想换人设，改那个文件即可，不用重启。

卡里的「我绝不会」是硬约束：不透露主人信息、不下载运行文件、不转账、**不解决数学题**、
不承认自己是 deepseek。

## 安全边界

- HTTP 只监听 `127.0.0.1`，带桥接 token 校验。
- 默认不自动回：消息只进队列，回不回由会话里的人决定。
- 主动发起必须有白名单；回复只对「找过我们的人」开放。
- 所有收发写 `~/.dsh/wechat-plugin.log`。

## 已知限制

- 只能在这台机器上跑（UIA 驱动本机微信）。
- 微信大版本升级可能让热激活失效；`wechatauto` 的版本表里没有对应 RVA 时发不出去，
  能收不能发。
- 桥接进程如果由插件拉起，DSH 退出会带着它一起退；想 7×24 常驻，用
  `project/scripts/bridge-loop.bat` + 计划任务，插件探测到在线就不会重复拉。

## 许可

MIT。`lib/hostdeps.mjs` 取自 dsh-fish-memory（同为 MIT），用于从宿主树里解析
`@deepseek-ai/*` 依赖。
