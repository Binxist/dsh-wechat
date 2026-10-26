// 用假的 cordis ctx 跑一遍 apply()：确认工具能注册、能执行，HTTP 能起。
import { apply } from 'file:///C:/Users/<你>/.dsh/plugins/dsh-wechat/lib/index.js'

const registered = []
const timers = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    }
  },
  agents: { get: () => null, list: () => [] },
  effect(fn) {
    try { fn() } catch (e) { console.log('effect 里抛错：', e?.message ?? e) }
    return () => {}
  },
  interval(fn, ms) {
    const t = setInterval(fn, ms)
    timers.push(t)
    return () => clearInterval(t)
  }
}

apply(ctx)
await new Promise((r) => setTimeout(r, 1500))

console.log('注册到的工具：', registered.map((t) => t.name).join(', ') || '(无)')

for (const t of registered) {
  if (t.name === 'wechat_status') {
    try {
      const v = await t.execute({}, {})
      console.log('\nwechat_status 返回：\n' + v.text)
    } catch (e) {
      console.log('wechat_status 执行失败：', e?.message ?? e)
    }
  }
  if (t.name === 'wechat_persona') {
    try {
      const v = await t.execute({}, {})
      console.log('\nwechat_persona 前 80 字：' + String(v.text).slice(0, 80).replace(/\n/g, ' '))
    } catch (e) {
      console.log('wechat_persona 执行失败：', e?.message ?? e)
    }
  }
  if (t.name === 'wechat_get_unread') {
    try {
      const v = await t.execute({ limit: 3 }, {})
      console.log('\nwechat_get_unread：' + v.text.slice(0, 120))
    } catch (e) {
      console.log('wechat_get_unread 执行失败：', e?.message ?? e)
    }
  }
}

try { process.exit(0) } catch {}
