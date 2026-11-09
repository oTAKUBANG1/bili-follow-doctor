/**
 * 假宿主自测：不启动整个 DSH，只验 host 半端能不能挂上工具和 /api/bili-follow 路由。
 * 跑法：node test-host.mjs
 */
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('D:/project-demo/bili-follow-doctor/dsh-plugin/index.js').href)
console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))

const tools = []
const routes = []
const disposers = []
const ctx = {
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  effect: (fn, label) => {
    const d = fn()
    disposers.push(label)
    return typeof d === 'function' ? d : () => {}
  },
}

mod.apply(ctx)
await new Promise((r) => setTimeout(r, 100))

console.log('工具:', tools.map((t) => t.name).join(', '))
console.log('路由:', routes.map((r) => `${r.kind} ${r.path}`).join(', '))
if (!routes.length) { console.log('❌ 路由没挂上'); process.exit(1) }

const server = http.createServer((req, res) => routes[0].handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log('本地端口:', base)

const show = async (label, p, opt) => {
  try {
    const r = await fetch(base + p, opt)
    const j = await r.json()
    const brief = JSON.stringify(j).slice(0, 260)
    console.log(`\n[${label}] ${r.status}\n${brief}${brief.length >= 260 ? '…' : ''}`)
    return j
  } catch (e) {
    console.log(`\n[${label}] 抛错: ${e.message}`)
    return null
  }
}

await show('GET /status', '/api/bili-follow/status')
await show('GET /list?status=all', '/api/bili-follow/list?status=all&limit=2')
await show('GET /list 默认(zombie)', '/api/bili-follow/list?limit=2')
await show('GET /scan (进度快照)', '/api/bili-follow/scan')
await show('POST /stop (没在扫)', '/api/bili-follow/stop', { method: 'POST' })
await show('POST /unfollow 无 confirm', '/api/bili-follow/unfollow', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mids: [1] }),
})
await show('POST /cred 空', '/api/bili-follow/cred', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
})
await show('GET 未知路径', '/api/bili-follow/nope')

server.close()
console.log('\n✅ host 半端自测结束')
