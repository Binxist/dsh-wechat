// DSH 微信桥接 · 宿主半边
//
// 干四件事：
//   1. 接   —— 起一个只在 127.0.0.1 上的 HTTP 服务，收桥接推来的微信消息、收桥接心跳
//   2. 发   —— 通过桥接的控制端口（/control/send）让它用 UIA 发出去
//   3. 挂工具 —— wechat_status / wechat_get_unread / wechat_reply / wechat_send_message
//              / wechat_list_chats / wechat_persona
//   4. 托底 —— 桥接没在跑就把它拉起来（跑起来就不管，避免两份抢同一个微信窗口）
//
// 为什么不用 MCP：MCP 那头只负责「把工具塞给模型」，而我们要的更多 ——
// 消息来了要能自己开一轮（agent.followup）、要能按会话挂策略、要能在宿主里看日志。
// 这些只有原生插件拿得到。
//
// 安全默认值（都能在 ~/.dsh/wechat-plugin.json 里改）：
//   · 默认不自动回（autoReply: false）—— 消息只进队列，回不回由会话里的人决定
//   · 主动发起必须在 allowChats 里；不在名单里的会话，只有「它先找过我们」才能回
//   · allowInbound 非空时，名单外的消息连队列都进不去
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { loadHostDeps } from './hostdeps.mjs'

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

export const name = 'wechat'
export const inject = ['tools', 'agents', 'timer']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(DSH_HOME, 'wechat-plugin.json')
const LOG_PATH = join(DSH_HOME, 'wechat-plugin.log')

const DEFAULTS = {
  project: 'C:\\Users\\<你>\\whale-girl-3.4.9',
  webhookPort: 8791,
  controlPort: 8792,
  allowChats: [],
  allowInbound: [],
  denyInbound: [],
  masters: [],
  autoReply: false,
  autoReplySession: '',
  personaFile: 'mcp/persona.md',
  replyCooldownSec: 20,
  maxRepliesPerHour: 20,
  // 默认不接管桥接进程：桥接由独立常驻任务负责，插件只管收发
  manageBridge: false
}

// 网页调试台（自包含，不依赖 DSH 前端构建）。打开 http://127.0.0.1:8791/debug
const DEBUG_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>微信调试台</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:16px 20px; background:#14161a; color:#e6e8eb;
         font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif }
  h1 { font-size:16px; margin:0 0 12px; font-weight:600 }
  .pills { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap }
  .pill { padding:3px 10px; border-radius:999px; background:#22262c; border:1px solid #2f353d }
  .ok { color:#7ee787 } .bad { color:#ff7b72 } .warn { color:#e3b341 }
  section { border:1px solid #2a2f36; border-radius:10px; padding:12px; margin-bottom:14px; background:#181b20 }
  h2 { font-size:13px; margin:0 0 10px; color:#9aa4b2; font-weight:600 }
  table { width:100%; border-collapse:collapse }
  td,th { text-align:left; padding:5px 6px; border-bottom:1px solid #23272e; vertical-align:top }
  th { color:#8b95a5; font-weight:500; font-size:12px }
  .who { color:#79c0ff } .txt { color:#e6e8eb }
  input,textarea,button,select { background:#0f1115; color:#e6e8eb; border:1px solid #333a43;
         border-radius:6px; padding:6px 8px; font:inherit }
  textarea { width:100%; min-height:60px; resize:vertical }
  button { cursor:pointer } button:hover { border-color:#4b5563 }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap }
  .grow { flex:1 }
  pre { margin:0; max-height:260px; overflow:auto; background:#0f1115; border:1px solid #23272e;
        border-radius:8px; padding:10px; font:12px/1.5 Consolas,monospace; color:#a8b3c0 }
  .muted { color:#6b7480 }
  label.chk { display:flex; gap:6px; align-items:center }
</style></head>
<body>
<h1>🐋 微信调试台 <span class="muted" style="font-weight:400;font-size:12px">dsh-wechat · 127.0.0.1:8791</span></h1>
<div class="pills" id="pills"><span class="pill muted">读取中…</span></div>

<section>
  <h2>待处理消息 <button id="btnRefresh" style="float:right">刷新</button></h2>
  <table><thead><tr><th>会话</th><th>类型</th><th>发送者</th><th>内容</th><th>时间</th></tr></thead>
  <tbody id="queue"><tr><td colspan="5" class="muted">…</td></tr></tbody></table>
</section>

<section>
  <h2>发一条</h2>
  <div class="row">
    <input id="chatId" class="grow" placeholder="chat_id（wxid_xxx 或 xxx@chatroom）" list="chats">
    <datalist id="chats"></datalist>
    <label class="chk"><input type="checkbox" id="force"> 立刻发</label>
  </div>
  <textarea id="msg" placeholder="纯文本，不要 Markdown"></textarea>
  <div class="row" style="margin-top:8px">
    <button id="btnSend">发送</button>
    <span id="sendResult" class="muted"></span>
  </div>
</section>

<section>
  <h2>配置</h2>
  <div class="row">
    <label class="chk"><input type="checkbox" id="autoReply"> 自动回（收到消息自己开一轮）</label>
    <input id="session" class="grow" placeholder="autoReplySession：交给哪个会话（留空=不自动回）">
  </div>
  <div class="row">
    <label class="chk"><input type="checkbox" id="manageBridge"> 由插件拉起桥接（默认关，交给常驻任务）</label>
  </div>
  <h2 style="margin-top:12px">主动发送白名单 allowChats（一行一个）</h2>
  <textarea id="allowChats" placeholder="filehelper&#10;wxid_xxx"></textarea>
  <div class="row" style="margin-top:8px">
    <button id="btnSave">保存配置</button>
    <span id="saveResult" class="muted"></span>
  </div>
</section>

<section>
  <h2>日志（最近 60 行）</h2>
  <pre id="log">…</pre>
</section>

<script>
var $ = function (s) { return document.querySelector(s) };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] }) };

async function jget(u) { var r = await fetch(u); return r.json() }
async function jpost(u, b) {
  var r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  return r.json()
}

async function refresh() {
  try {
    var s = await jget('/api/state');
    var b = s.bridge, c = s.config;
    var pills = [
      ['桥接', b.online ? '在线' : '离线', b.online ? 'ok' : 'bad'],
      ['UIA', b.uia === true ? '正常' : (b.uia === false ? '不可用' : '未知'), b.uia === true ? 'ok' : (b.uia === false ? 'bad' : 'warn')],
      ['监听', b.listener === true ? '在跑' : (b.listener === false ? '停了' : '未知'), b.listener === true ? 'ok' : 'warn'],
      ['队列', String(s.queue.length), ''],
      ['自动回', c.autoReply ? '开' : '关', c.autoReply ? 'warn' : ''],
      ['心跳', b.ageSec == null ? '无' : (b.ageSec + 's 前'), '']
    ];
    $('#pills').innerHTML = pills.map(function (p) {
      return '<span class="pill ' + p[2] + '">' + p[0] + '：' + p[1] + '</span>'
    }).join('');

    $('#queue').innerHTML = s.queue.length ? s.queue.map(function (m) {
      return '<tr><td>' + esc(m['会话']) + '</td><td>' + esc(m['类型']) + '</td><td class="who">' +
        esc(m['发送者']) + '</td><td class="txt">' + esc(m['内容']) + '</td><td class="muted">' +
        new Date(m.at).toLocaleTimeString() + '</td></tr>'
    }).join('') : '<tr><td colspan="5" class="muted">（空）</td></tr>';

    $('#chats').innerHTML = s.chats.map(function (c) {
      return '<option value="' + esc(c.chat_id) + '">' + esc(c['名称']) + '</option>'
    }).join('');

    if (document.activeElement !== $('#allowChats')) {
      $('#allowChats').value = (c.allowChats || []).join('\\n')
    }
    $('#autoReply').checked = !!c.autoReply;
    $('#manageBridge').checked = !!c.manageBridge;
    if (document.activeElement !== $('#session')) $('#session').value = c.autoReplySession || '';

    var lg = await jget('/api/log?n=60');
    var box = $('#log');
    box.textContent = (lg.lines || []).join('\\n');
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    $('#pills').innerHTML = '<span class="pill bad">调试台连不上：' + esc(e.message) + '</span>'
  }
}

$('#btnRefresh').onclick = refresh;

$('#btnSend').onclick = async function () {
  var chat_id = $('#chatId').value.trim(), text = $('#msg').value;
  if (!chat_id || !text) { $('#sendResult').textContent = 'chat_id 和内容都要填'; return }
  $('#sendResult').textContent = '发送中…（UIA 可能要几秒）';
  try {
    var r = await jpost('/api/send', { chat_id: chat_id, text: text, force: $('#force').checked });
    $('#sendResult').textContent = (r.ok ? '✅ 已发：' : '❌ 失败：') + (r.chat_title || r.error || '');
    if (r.ok) $('#msg').value = '';
  } catch (e) { $('#sendResult').textContent = '❌ ' + e.message }
  refresh()
};

$('#btnSave').onclick = async function () {
  var allowChats = $('#allowChats').value.split('\\n').map(function (s) { return s.trim() }).filter(Boolean);
  $('#saveResult').textContent = '保存中…';
  try {
    var r = await jpost('/api/config', {
      autoReply: $('#autoReply').checked,
      autoReplySession: $('#session').value.trim(),
      manageBridge: $('#manageBridge').checked,
      allowChats: allowChats
    });
    $('#saveResult').textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  } catch (e) { $('#saveResult').textContent = '❌ ' + e.message }
  refresh()
};

refresh();
setInterval(refresh, 4000);
</script>
</body></html>`

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    appendFileSync(LOG_PATH, line + '\n', 'utf8')
  } catch {}
}

function cfg() {
  let c
  try {
    c = { ...DEFAULTS, ...JSON.parse(readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')) }
  } catch {
    c = { ...DEFAULTS }
  }
  // 环境变量覆盖端口：只为「不打扰正在跑的那份」做一次独立自检用
  if (process.env.WECHAT_PLUGIN_PORT) c.webhookPort = Number(process.env.WECHAT_PLUGIN_PORT)
  if (process.env.WECHAT_PLUGIN_CONTROL_PORT) c.controlPort = Number(process.env.WECHAT_PLUGIN_CONTROL_PORT)
  return c
}

function bridgeToken(c) {
  try {
    const j = JSON.parse(readFileSync(join(c.project, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
    return String(j?.gateway?.wechat?.inboundToken || '')
  } catch {
    return ''
  }
}

// ── 运行时状态 ────────────────────────────────────────────────────────────
const queue = []
const handled = new Set()
const seenChats = new Map()
const replyTimes = new Map()   // chatId → [时间戳]
const autoReplyAt = new Map()  // chatId → 上次自动开轮时间（防连发开多轮）
let heartbeat = null
let seq = 0
let bridgeProc = null
let server = null

function policy(c) {
  return {
    allowChats: (c.allowChats || []).map(String),
    allowInbound: (c.allowInbound || []).map(String),
    denyInbound: (c.denyInbound || []).map(String),
    masters: (c.masters || []).map(String)
  }
}

function inboundAllowed(c, chatId, userId) {
  const p = policy(c)
  if (p.denyInbound.includes(chatId) || (userId && p.denyInbound.includes(userId))) return false
  if (!p.allowInbound.length) return true
  return p.allowInbound.includes(chatId) || (userId !== '' && p.allowInbound.includes(userId))
}

function canSend(c, chatId, proactive) {
  const p = policy(c)
  if (p.allowChats.includes(chatId)) return true
  if (proactive) return false
  return seenChats.has(chatId)   // 回复：只要它找过我们就行
}

function pushMessage(c, payload) {
  const msgId = String(payload.msg_id || '')
  if (msgId && handled.has(msgId)) return null
  if (msgId) handled.add(msgId)
  const m = {
    seq: ++seq,
    chatId: String(payload.chat_id || ''),
    chatType: payload.chat_type === 'group' ? 'group' : 'private',
    chatTitle: String(payload.chat_title || ''),
    userId: String(payload.senderId || payload.user_id || ''),
    senderName: String(payload.senderName || payload.nickname || ''),
    text: String(payload.text || ''),
    atMe: Boolean(payload.at_me),
    msgId,
    at: Date.now()
  }
  if (!m.chatId) return null
  if (!inboundAllowed(c, m.chatId, m.userId)) {
    log('丢弃（入站白名单外）', m.chatTitle || m.chatId, '←', m.senderName)
    return null
  }
  seenChats.set(m.chatId, { title: m.chatTitle || seenChats.get(m.chatId)?.title || '', lastAt: m.at })
  queue.push(m)
  while (queue.length > 200) queue.shift()
  log('收到', m.chatType === 'group' ? '群' : '私聊', m.chatTitle || m.chatId, '←', m.senderName, ':', m.text.slice(0, 40))
  return m
}

// ── 桥接进程守护 ──────────────────────────────────────────────────────────
async function controlHealthy(c) {
  try {
    const r = await fetch(`http://127.0.0.1:${c.controlPort}/control/health`, { signal: AbortSignal.timeout(1200) })
    return r.ok
  } catch {
    return false
  }
}

async function ensureBridge(c) {
  if (await controlHealthy(c)) return true
  if (bridgeProc && !bridgeProc.killed) return false
  const py = join(c.project, 'runtime', 'python', 'python.exe')
  const script = join(c.project, 'examples', 'wechatauto_bridge.py')
  try {
    bridgeProc = spawn(py, [script], {
      cwd: c.project,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        WHALE_BOT_URL: `http://127.0.0.1:${c.webhookPort}/webhook/wechat`,
        WECHAT_BRIDGE_CONTROL_PORT: String(c.controlPort),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: ''
      },
      stdio: ['ignore', 'ignore', 'ignore']
    })
    bridgeProc.on('exit', (code) => log('桥接退出，code =', code))
    log('桥接不在线，已拉起')
  } catch (e) {
    log('桥接启动失败：', e?.message ?? e)
  }
  return false
}

async function sendViaBridge(c, chatId, text, force) {
  const r = await fetch(`http://127.0.0.1:${c.controlPort}/control/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: bridgeToken(c),
      chat_id: chatId,
      text,
      force: Boolean(force),
      chat_title: seenChats.get(chatId)?.title || ''
    }),
    signal: AbortSignal.timeout(180000)
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }))
  log(r.ok ? '已发送 →' : '发送失败 →', chatId, ':', String(text).slice(0, 40), r.error || '')
  return r
}

// ── 插件主体 ──────────────────────────────────────────────────────────────
export function apply(ctx) {
  const c = cfg()
  log('插件启动；project =', c.project, 'webhook =', c.webhookPort, 'control =', c.controlPort)

  // HTTP：收消息 + 心跳
  server = http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 2e6) req.destroy() })
    req.on('end', () => {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { return send(400, { ok: false, error: 'bad json' }) }
      const url = new URL(req.url, 'http://127.0.0.1')
      const cur = cfg()

      if (url.pathname === '/webhook/wechat') {
        const expect = bridgeToken(cur)
        const got = url.searchParams.get('token') || req.headers['x-bot-token'] || ''
        if (expect && got !== expect) return send(401, { ok: false, error: 'bad token' })
        const m = pushMessage(cur, body)
        if (!m) return send(200, { ok: true, action: 'ignore', reason: 'duplicate-or-filtered' })
        // 秒回「收到即可」：真正的发送由 DSH 决定，不让桥接的 120 秒超时绑住节奏
        send(200, { ok: true, action: 'ignore', reason: 'queued-for-dsh', seq: m.seq })
        if (cur.autoReply) maybeAutoReply(ctx, cur, m)
        return
      }

      if (url.pathname === '/api/bridge/heartbeat') {
        heartbeat = { ...body, at: Date.now() }
        return send(200, { ok: true })
      }

      if (url.pathname === '/health') {
        return send(200, { ok: true, queue: queue.length, heartbeatAgeSec: heartbeat ? Math.round((Date.now() - heartbeat.at) / 1000) : null })
      }

      // ── 调试台 ────────────────────────────────────────────────────────
      if (url.pathname === '/debug') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(DEBUG_HTML)
      }

      if (url.pathname === '/api/state') {
        const p = policy(cur)
        const list = [...seenChats.entries()].map(([id, v]) => ({ chat_id: id, 名称: v.title || '', 最后: v.lastAt }))
        return send(200, {
          bridge: {
            online: Boolean(heartbeat && Date.now() - heartbeat.at < 60000),
            uia: heartbeat?.uia ?? null,
            listener: heartbeat?.listener ?? null,
            ageSec: heartbeat ? Math.round((Date.now() - heartbeat.at) / 1000) : null
          },
          queue: queue.map((m) => ({ 会话: m.chatTitle || m.chatId, chat_id: m.chatId, 类型: m.chatType, 发送者: m.senderName, 内容: m.text, at我: m.atMe, at: m.at })),
          chats: list,
          config: {
            autoReply: Boolean(cur.autoReply),
            autoReplySession: cur.autoReplySession || '',
            allowChats: p.allowChats,
            allowInbound: p.allowInbound,
            denyInbound: p.denyInbound,
            masters: p.masters,
            manageBridge: Boolean(cur.manageBridge)
          }
        })
      }

      if (url.pathname === '/api/send' && req.method === 'POST') {
        const chatId = String(body.chat_id || '')
        const text = String(body.text || '')
        if (!chatId || !text) return send(400, { ok: false, error: 'chat_id 和 text 必填' })
        sendViaBridge(cur, chatId, text, body.force).then((r) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(r))
        }).catch((e) => send(500, { ok: false, error: String(e?.message ?? e) }))
        return
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        try {
          const before = cfg()
          const next = { ...before, ...body }
          delete next._说明
          writeFileSync(CFG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
          log('配置已更新：', JSON.stringify(body))
          return send(200, { ok: true })
        } catch (e) {
          return send(500, { ok: false, error: String(e?.message ?? e) })
        }
      }

      if (url.pathname === '/api/log') {
        const n = Math.max(1, Math.min(500, Number(url.searchParams.get('n') || 80)))
        try {
          const lines = readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n').slice(-n)
          return send(200, { ok: true, lines })
        } catch (e) {
          return send(200, { ok: true, lines: ['（还没有日志）'] })
        }
      }

      send(404, { ok: false })
    })
  })

  // 端口可能被上一版 MCP 或者上一次实例暂时占着：失败不致命，10 秒后重试
  const listen = () => {
    try {
      server.listen(c.webhookPort, '127.0.0.1', () => log('HTTP 就绪 http://127.0.0.1:' + c.webhookPort))
    } catch (e) {
      log('HTTP 监听异常：', e?.message ?? e)
      setTimeout(() => listen(), 10000)
    }
  }
  server.on('error', (e) => {
    log('HTTP 监听失败：', e?.message ?? e)
    setTimeout(() => listen(), 10000)
  })
  listen()

  // 桥接保活：默认**不接管**（manageBridge: false）。
  // 桥接已经有独立的常驻任务（scripts/bridge-loop.bat + 5 分钟看门狗），
  // 插件再拉一份就会有两个进程抢同一个微信窗口 —— 那比不接还糟。
  // 想让插件自己拉就把配置里的 manageBridge 改成 true。
  ctx.effect(() => ctx.interval(() => {
    if (cfg().manageBridge) ensureBridge(cfg()).catch(() => {})
  }, 15000))
  if (c.manageBridge) ensureBridge(c).catch(() => {})

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tools = [
    defineTool({
      name: 'wechat_status',
      description: '查微信桥接状态：桥接在不在线、UIA 能不能发、队列里还有几条没处理、当前的收发白名单。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }] }
      },
      async execute() {
        const cur = cfg()
        const p = policy(cur)
        const alive = await controlHealthy(cur)
        const info = {
          bridgeOnline: alive,
          heartbeatAgeSec: heartbeat ? Math.round((Date.now() - heartbeat.at) / 1000) : null,
          uia: heartbeat?.uia ?? null,
          listener: heartbeat?.listener ?? null,
          queue: queue.length,
          收: p.allowInbound.length ? '白名单' : '开放（谁都能进队列）',
          发: p.allowChats.length ? p.allowChats : '空（只能回找过我们的人）',
          主人: p.masters.length ? p.masters : '未配置',
          自动回: cur.autoReply ? '开' : '关'
        }
        return { text: JSON.stringify(info, null, 2) }
      }
    }),
    defineTool({
      name: 'wechat_get_unread',
      description: '看还没处理的微信消息（只读，不清空队列）。',
      parameters: { limit: { type: 'number', description: '最多几条，默认 10' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }] }
      },
      async execute(args) {
        const n = Math.max(1, Math.min(50, Number(args?.limit) || 10))
        const items = queue.slice(-n)
        if (!items.length) return { text: '（队列里没有未处理消息）' }
        return {
          text: JSON.stringify(items.map((m) => ({
            会话: m.chatTitle || m.chatId, chat_id: m.chatId, 类型: m.chatType,
            发送者: m.senderName, 内容: m.text, at我: m.atMe, 时间: new Date(m.at).toISOString()
          })), null, 2)
        }
      }
    }),
    defineTool({
      name: 'wechat_reply',
      description: '回一条微信消息。chat_id 用 wechat_get_unread 给的那个；发送走本机微信的界面自动化，发完会回读数据库确认。',
      parameters: {
        chat_id: { type: 'string', required: true, description: '会话 id（私聊 wxid_xxx，群 xxx@chatroom）' },
        text: { type: 'string', required: true, description: '要发的纯文本，不要 Markdown' },
        force: { type: 'boolean', description: 'true=忽略「对方在打游戏/全屏」的排队策略' }
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }] }
      },
      async execute(args) {
        const cur = cfg()
        const chatId = String(args?.chat_id || '')
        const text = String(args?.text || '')
        if (!chatId || !text) return { text: 'chat_id 和 text 必填' }
        if (!canSend(cur, chatId, false)) {
          return { text: `目标 ${chatId} 既不在 allowChats、也没给我们发过消息；要主动发起请把它加进 wechat-plugin.json 的 allowChats` }
        }
        // 频率限制：同一会话冷却 + 每小时上限（防止被一句话刷爆）
        const now = Date.now()
        const times = (replyTimes.get(chatId) || []).filter((t) => now - t < 3600000)
        if (now - (times[times.length - 1] || 0) < cur.replyCooldownSec * 1000) {
          return { text: `太急了，同一会话 ${cur.replyCooldownSec} 秒内只发一条` }
        }
        if (times.length >= cur.maxRepliesPerHour) {
          return { text: `这个会话一小时已经发了 ${times.length} 条，先停一停` }
        }
        const r = await sendViaBridge(cur, chatId, text, args?.force)
        if (r?.ok) { times.push(now); replyTimes.set(chatId, times) }
        return { text: JSON.stringify(r) }
      }
    }),
    defineTool({
      name: 'wechat_send_message',
      description: '主动给某个微信会话发消息（不是回复）。只允许发到 allowChats 白名单里的会话。',
      parameters: {
        chat_id: { type: 'string', required: true, description: '会话 id' },
        text: { type: 'string', required: true, description: '纯文本' },
        force: { type: 'boolean', description: 'true=立刻发，不等对方退出游戏/全屏' }
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }] }
      },
      async execute(args) {
        const cur = cfg()
        const chatId = String(args?.chat_id || '')
        const text = String(args?.text || '')
        if (!chatId || !text) return { text: 'chat_id 和 text 必填' }
        if (!canSend(cur, chatId, true)) {
          return { text: `目标 ${chatId} 不在 allowChats 里，不能主动发起` }
        }
        const r = await sendViaBridge(cur, chatId, text, args?.force)
        return { text: JSON.stringify(r) }
      }
    }),
    defineTool({
      name: 'wechat_list_chats',
      description: '列出这次运行期间给我们发过消息的会话（只读），用来看有哪些 chat_id 可以回。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }] }
      },
      async execute() {
        const list = [...seenChats.entries()].map(([id, v]) => ({
          chat_id: id, 名称: v.title || '(未知)', 最后消息: new Date(v.lastAt).toISOString()
        }))
        return { text: list.length ? JSON.stringify(list, null, 2) : '（还没有任何会话）' }
      }
    }),
    defineTool({
      name: 'wechat_persona',
      description: '读当前微信人设（角色卡全文，跟 QQ 那边是同一张卡）。接手微信会话前先调一次；卡里的「我绝不会」是硬约束。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }] }
      },
      async execute() {
        const cur = cfg()
        try {
          return { text: readFileSync(join(cur.project, cur.personaFile), 'utf8') }
        } catch (e) {
          return { text: `读不到人设文件：${e?.message ?? e}` }
        }
      }
    })
  ]

  // 参数表 → 完整 JSON Schema。
  // 为什么必须自己转：宿主的 defineTool（@deepseek-ai/dsh-tools）会把「参数表」
  // 转成 JSON Schema，但它打在 app.asar 里，插件树里拿不到，hostdeps 只能退回
  // 「本地等价实现」——那个实现只做校验、不做转换。于是 parameters 原样传下去，
  // 模型请求里就成了 schema type: null，整轮请求被拒（实测报错：
  // Invalid schema for function 'wechat_get_unread': ... got 'type: null'）。
  for (const t of tools) {
    const p = t.parameters
    if (!p || p.type === 'object') continue
    const properties = {}
    const required = []
    for (const [k, v] of Object.entries(p)) {
      const { required: isRequired, ...rest } = v || {}
      properties[k] = rest
      if (isRequired) required.push(k)
    }
    t.parameters = {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {})
    }
  }

  // 任何工具内部异常都收成一条文本，绝不抛回 DSH 的请求流程 ——
  // 一个插件不该有能力让整轮对话失败。
  for (const t of tools) {
    const orig = t.execute
    if (typeof orig === 'function') {
      t.execute = async (args, exec) => {
        try {
          return await orig(args, exec)
        } catch (e) {
          log('工具异常 ' + t.name + '：' + String(e?.message ?? e))
          return { text: '工具异常：' + String(e?.message ?? e) }
        }
      }
    }
  }

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
      log('工具挂上：' + tool.name)
    } catch (e) {
      log('工具挂不上 ' + tool.name + '：' + (e?.message ?? e))
    }
  }

  // 卸载时把 HTTP 和桥接一起收掉（桥接如果是外部常驻的，这里不会动它）
  ctx.effect(() => () => {
    try { server?.close() } catch {}
    try { if (bridgeProc && !bridgeProc.killed) bridgeProc.kill() } catch {}
    log('插件卸载，HTTP 已关闭')
  })
}

// ── 可选：收到消息就自己开一轮（默认关）─────────────────────────────────
// 用 agent.followup() 而不是自己拼上下文：那样才是 DSH 自己的回合 ——
// 人格、历史、工具、记忆都是会话自己的，跟用户手打一句话没区别。
function pickAgent(ctx, c) {
  // 指定了就用指定的；没指定（或指定失效）就退到「最近活跃的那个会话」，
  // 这样调试台上勾一下「自动回」就能直接生效，不用先去翻会话 id。
  if (c.autoReplySession) {
    try {
      const a = ctx.agents.get(c.autoReplySession)
      if (a) return a
    } catch {}
    log('自动回：配置的会话取不到，改用最近活跃的会话（' + c.autoReplySession + '）')
  }
  try {
    const list = (ctx.agents.list() || []).filter((a) => a && a.id)
    if (!list.length) return null
    const scored = list.map((a) => ({ a, t: Number(a.updatedAt || a.lastActivityAt || a.createdAt || 0) }))
    scored.sort((x, y) => y.t - x.t)
    return (scored[0] && scored[0].a) || list[list.length - 1]
  } catch {
    return null
  }
}

function maybeAutoReply(ctx, c, m) {
  // 群里只在被 @ 或叫名字时才接话；私聊都接
  if (m.chatType === 'group' && !m.atMe) return
  // 同一会话 8 秒内不重复开轮：对方连发三条，不要开三轮
  const last = autoReplyAt.get(m.chatId) || 0
  if (Date.now() - last < 8000) { log('自动回：同一会话 8 秒内已开过一轮，跳过'); return }
  const agent = pickAgent(ctx, c)
  if (!agent) { log('自动回：找不到可用的会话，跳过'); return }
  autoReplyAt.set(m.chatId, Date.now())
  if (!agent) { log('自动回：找不到可用的会话，跳过'); return }
  const head = m.chatType === 'group' ? `【微信·群「${m.chatTitle || m.chatId}」】` : `【微信·私聊】`
  const ask = `${head}${m.senderName}：${m.text}\n` +
    `（chat_id = ${m.chatId}。要回就用 wechat_reply 发，不想回就别回。` +
    `先 wechat_persona 看一眼人设，短句，别写小作文；不要复述你调用了什么工具。）`
  Promise.resolve(agent.followup(ask)).catch((e) => log('自动回失败：', e?.message ?? e))
  log('自动回：已交给会话', String(agent.id || c.autoReplySession || '(最近活跃)'))
}
