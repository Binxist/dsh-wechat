// 独立跑一份插件实例（假 ctx），只为了不重启 DSH 也能验证 HTTP/调试台。
// 用法：设 WECHAT_PLUGIN_PORT=8795 后 node debugtest.mjs
import { apply } from '../lib/index.js'

const ctx = {
  tools: { register: () => () => {} },
  agents: { get: () => null, list: () => [] },
  effect(fn) { try { fn() } catch (e) { console.error('effect:', e?.message ?? e) } return () => {} },
  interval(fn, ms) { const t = setInterval(fn, ms); return () => clearInterval(t) }
}

apply(ctx)
console.log('测试实例已启动，端口由 WECHAT_PLUGIN_PORT 决定')
setInterval(() => {}, 1 << 30)
