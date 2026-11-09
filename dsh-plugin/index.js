/**
 * dsh-bili-follow-doctor —— 主机半端
 * ============================================================================
 * 给 DeepSeek Harness 用的「B站关注体检」插件：扫关注 → 查最近投稿/动态 → 出名单 →
 * 经确认后逐个取关。所有请求都走本机网络，凭证只存在插件自己的家目录里。
 *
 * 工具：
 *   bili_follow_login / bili_follow_login_poll   扫码登录（凭证落地到 ~/.dsh/bili-follow/cred.json）
 *   bili_follow_scan     分批扫描（可反复调用直到 remaining=0）
 *   bili_follow_list     按状态列名单
 *   bili_follow_report   导出 CSV + Markdown
 *   bili_follow_unfollow 取关（必须显式 confirm:true）
 *   bili_follow_status   总览
 *
 * 设计取舍：
 *   - 最近投稿走 app 通道（appkey 签名、独立限速池），不用 web 的 wbi 接口 —— 后者约 60~80 次
 *     就会被 HTTP 412 封掉，全量扫必死（2026-11-06 实测）。
 *   - 注销判定：关注列表昵称含「已注销」→ 直接算；否则看 card 接口 -404。
 *   - 扫描结果落 cache.json，中断可续；宿主工具调用有超时，所以必须分批。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const name = 'bili-follow-doctor'
// webServer 用来挂设置页的接口（/api/bili-follow/*）；老版本宿主没有就退化成只有工具可用
export const inject = ['tools', 'webServer']

const HOME = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-follow')
const CACHE_FILE = join(HOME, 'cache.json')
const CRED_FILE = join(HOME, 'cred.json')
const OUT_DIR = join(HOME, 'out')
const FALLBACK_CRED = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty', 'bili_credential.json')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_APP = 'Mozilla/5.0 BiliDroid/7.70.0 (bbcallen@gmail.com) os/android'
const APPKEY = '1d8b6e7d45233436'
const APPSEC = '560c52ccd288fed045859ed18bffd973'
const TWO_YEARS = 730 * 86400
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,
  39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,
  63,57,62,11,36,20,34,44,52]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Math.floor(Date.now() / 1000)
const md5 = (s) => createHash('md5').update(s).digest('hex')
const ensureDir = (d) => { try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ } }

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 凭证：插件自己的家目录优先，其次复用「刷B站」插件登录过的那份 */
function loadCred() {
  const envPath = process.env.BFD_CREDENTIAL
  for (const p of [envPath, CRED_FILE, FALLBACK_CRED]) {
    if (!p || !existsSync(p)) continue
    const raw = readJson(p, null)
    if (!raw) continue
    const c = {
      sessdata: raw.sessdata || raw.SESSDATA || '',
      bili_jct: raw.bili_jct || raw.biliJct || '',
      buvid3: raw.buvid3 || raw.buvid3 || '',
      dedeuserid: String(raw.dedeuserid || raw.DedeUserID || ''),
    }
    if (c.sessdata) return c
  }
  return null
}

function cookieHeader(c) {
  return Object.entries({ SESSDATA: c.sessdata, bili_jct: c.bili_jct, buvid3: c.buvid3, DedeUserID: c.dedeuserid })
    .filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 统一的 web 请求（带 cookie，遇 412 退避一次） */
async function webGet(cookie, path, params = {}, tries = 3) {
  const url = 'https://api.bilibili.com' + path + '?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))).toString()
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA, Cookie: cookie, Referer: 'https://space.bilibili.com/',
          Accept: 'application/json, text/plain, */*',
        },
      })
      if (r.status === 412 || r.status === 429) { await sleep(15000 * (i + 1)); lastErr = new Error('HTTP ' + r.status); continue }
      return await r.json()
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)) }
  }
  throw lastErr || new Error('请求失败')
}

/** app 通道：最近一条投稿时间（0=没有投稿） */
async function appLastVideo(mid, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const p = {
      vmid: mid, pn: 1, ps: 1, order: 'pubdate',
      mobi_app: 'android', platform: 'android', build: 7700000,
      appkey: APPKEY, ts: nowSec(),
    }
    const q = Object.keys(p).sort().map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&')
    const sign = md5(q + APPSEC)
    const url = 'https://app.bilibili.com/x/v2/space/archive?' + q + '&sign=' + sign
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA_APP } })
      if (r.status === 412 || r.status === 429) { await sleep(20000 * (i + 1)); continue }
      const j = await r.json()
      if (j.code === 0) {
        const items = j.data?.item || []
        return { ok: true, ts: items.length ? Number(items[0].ctime) || 0 : 0 }
      }
      return { ok: false, err: `app code ${j.code} ${j.message || ''}` }
    } catch (e) {
      if (i === tries - 1) return { ok: false, err: String(e.message || e) }
      await sleep(2000)
    }
  }
  return { ok: false, err: 'app 通道重试耗尽' }
}

/** wbi 签名（动态接口要用） */
let wbiCache = { key: null, at: 0 }
async function wbiKey(cookie) {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600_000) return wbiCache.key
  const j = await webGet(cookie, '/x/web-interface/nav', {})
  const img = (j?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0]
  const sub = (j?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0]
  if (!img || !sub) throw new Error('拿不到 wbi key（登录态可能已失效）')
  const raw = img + sub
  wbiCache = { key: MIXIN.map((i) => raw[i]).join('').slice(0, 32), at: Date.now() }
  return wbiCache.key
}

async function lastDynamic(cookie, mid, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const key = await wbiKey(cookie)
      const p = {
        host_mid: mid, timezone_offset: '-480', platform: 'web',
        features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote', wts: String(nowSec()),
      }
      const q = Object.keys(p).sort().map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&')
      const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?' + q + '&w_rid=' + md5(q + key)
      const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie, Referer: `https://space.bilibili.com/${mid}` } })
      const j = await r.json()
      if (j.code === 0) {
        const items = j.data?.items || []
        return { ok: true, ts: items.length ? Number(items[0].modules?.module_author?.pub_ts) || 0 : 0 }
      }
      if (j.code === -412 || r.status === 412) { wbiCache.key = null; await sleep(20000); continue }
      return { ok: false, err: `dyn code ${j.code}` }
    } catch (e) {
      if (i === tries - 1) return { ok: false, err: String(e.message || e) }
      await sleep(3000)
    }
  }
  return { ok: false, err: '动态接口重试耗尽' }
}

// 直播：B站 不开放「上次开播时间」（离线时 live_time 恒为 0000），
// 用「直播间有自定义标题/分区」判断播没播过，播过的一律保留
async function liveInfo(mid) {
  const none = { room: 0, live: false, streamed: false, title: '' }
  try {
    const a = await fetch('https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=' + mid,
      { headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' } })
    const d = (await a.json())?.data || {}
    const roomid = d.roomid || 0
    if (!roomid) return none
    const b = await fetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + roomid,
      { headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' } })
    const e = (await b.json())?.data || {}
    const title = (e.title || '').trim()
    const area = (e.area_name || '').trim()
    const streamed = !(title.startsWith('用户') && title.endsWith('的直播间')) || !!area
    return { room: roomid, live: e.live_status === 1, streamed, title }
  } catch {
    return none
  }
}

async function fetchFollowings(cookie, selfMid, onPage) {
  const out = []
  for (let pn = 1; pn <= 100; pn++) {
    const j = await webGet(cookie, '/x/relation/followings',
      { vmid: selfMid, pn, ps: 50, order: 'desc', order_type: 'attention' })
    if (j.code !== 0) throw new Error(`读取关注列表失败：code ${j.code} ${j.message || ''}`)
    const list = j.data?.list || []
    out.push(...list)
    onPage?.(out.length, j.data?.total || 0)
    if (list.length < 50 || out.length >= (j.data?.total || 0)) break
    await sleep(800)
  }
  return out
}

async function cardInfo(cookie, mid) {
  const j = await webGet(cookie, '/x/web-interface/card', { mid }, 2)
  if (j.code === 0 && j.data) return { ok: true, name: j.data.card?.name, fans: j.data.follower }
  if (j.code === -404) return { ok: false, deleted: true }
  return { ok: false, err: `card code ${j.code}` }
}

// ---------------------------------------------------------------- 缓存
function loadCache() { return readJson(CACHE_FILE, { rows: {}, updatedAt: 0 }) }
function saveCache(cache) {
  ensureDir(HOME)
  cache.updatedAt = nowSec()
  writeFileSync(CACHE_FILE, JSON.stringify(cache))
}

function statusOf(r, staleDays = 730) {
  const win = Math.max(30, Number(staleDays) || 730) * 86400
  if (r.deleted) return 'deleted'
  if (r.mutual) return 'mutual'
  if (r.liveNow) return 'live'
  if (r.liveStreamed) return 'streamed'
  if (r.videoTs === 0 && r.dynTs === 0) return 'empty'
  if (r.videoTs === null && r.dynTs === null) return 'error'
  const vStale = r.videoTs === 0 || (r.videoTs && nowSec() - r.videoTs > win)
  const dStale = !r.dynTs || nowSec() - r.dynTs > win
  if (vStale && dStale) return 'zombie'
  if (vStale && !dStale) return 'dynonly'
  return 'alive'
}
const staleDaysOf = (v) => Math.max(30, Number(v) || 730)

// ---------------------------------------------------------------- 可复用的动作
// 工具（会话里调）和 HTTP 接口（设置页调）共用同一套实现，避免两边逻辑漂移。

/** 扫一批。c = 凭证对象。args 同工具参数。 */
async function scanBatch(c, args = {}) {
  const cookie = cookieHeader(c)
  const limit = Math.max(1, Math.min(Number(args.limit) || 40, 100))
  const interval = Math.max(300, Math.min(Number(args.intervalMs) || 900, 5000))
  const cache = args.refresh ? { rows: {}, updatedAt: 0 } : loadCache()

  const fw = await fetchFollowings(cookie, c.dedeuserid)
  const pending = fw.filter((u) => {
    const r = cache.rows[String(u.mid)]
    return !r || !r.checked
  })
  const batch = pending.slice(0, limit)
  const started = Date.now()
  let deleted = 0

  for (const [i, u] of batch.entries()) {
    const mid = String(u.mid)
    const rec = { mid, name: u.uname || '', sign: (u.sign || '').slice(0, 40) }
    rec.mutual = Number(u.attribute) === 6 // attribute=6 就是互相关注
    if ((u.uname || '').includes('已注销')) {
      rec.deleted = true
      deleted += 1
    } else {
      const card = await cardInfo(cookie, mid).catch(() => ({ ok: false }))
      if (card.deleted) { rec.deleted = true; deleted += 1 }
      else if (card.ok) { rec.name = card.name || rec.name; rec.fans = card.fans }
      if (!rec.deleted) {
        const v = await appLastVideo(mid)
        rec.videoTs = v.ok ? v.ts : null
        if (!v.ok) rec.err = v.err
        const d = await lastDynamic(cookie, mid)
        rec.dynTs = d.ok ? d.ts : null
        if (!d.ok && !rec.err) rec.err = d.err

        // 视频和动态都停了才查直播：主播不能误删
        const win = staleDaysOf(args.staleDays) * 86400
        const vStale = rec.videoTs === 0 || (rec.videoTs && nowSec() - rec.videoTs > win)
        const dStale = !rec.dynTs || nowSec() - rec.dynTs > win
        if (vStale && dStale) {
          const li = await liveInfo(mid)
          rec.liveNow = li.live
          rec.liveStreamed = li.streamed
          rec.liveRoom = li.room
          rec.liveTitle = li.title
          await sleep(300)
        }
      }
      await sleep(interval)
    }
    rec.checked = true
    rec.at = nowSec()
    cache.rows[mid] = rec
    if (i % 5 === 4) saveCache(cache)
    if (i < batch.length - 1) await sleep(200)
  }
  saveCache(cache)

  const rows = Object.values(cache.rows).filter((r) => r.checked)
  const sd = staleDaysOf(args.staleDays)
  const counts = countByStatus(rows, sd)
  return {
    ok: true,
    scannedThisCall: batch.length,
    scannedTotal: rows.length,
    followingTotal: fw.length,
    remaining: Math.max(0, pending.length - batch.length),
    deletedThisCall: deleted,
    counts,
    ms: Date.now() - started,
  }
}

function countByStatus(rows, staleDays = 730) {
  const counts = {}
  for (const r of rows) {
    const st = statusOf(r, staleDays)
    counts[st] = (counts[st] || 0) + 1
  }
  return counts
}

const STATUS_RANK = { deleted: 0, zombie: 1, empty: 2, mutual: 3, streamed: 4, live: 5, dynonly: 6, error: 7, alive: 8 }

/** 按状态列名单（工具和设置页共用） */
function listRows(args = {}) {
  const cache = loadCache()
  const want = String(args.status || 'zombie')
  const sd = staleDaysOf(args.staleDays)
  let rows = Object.values(cache.rows).filter((r) => r.checked)
  if (want !== 'all') rows = rows.filter((r) => statusOf(r, sd) === want)
  rows.sort((a, b) => (STATUS_RANK[statusOf(a, sd)] - STATUS_RANK[statusOf(b, sd)])
    || ((nowSec() - (b.videoTs || nowSec())) - (nowSec() - (a.videoTs || nowSec()))))
  const offset = Math.max(0, Number(args.offset) || 0)
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 500))
  return {
    ok: true,
    total: rows.length,
    offset,
    count: Math.min(limit, Math.max(0, rows.length - offset)),
    rows: rows.slice(offset, offset + limit).map((r) => ({
      mid: r.mid, name: r.name, status: statusOf(r, sd), statusText: STATUS_LABEL[statusOf(r, sd)],
      lastVideo: fmtDate(r.videoTs), lastDynamic: fmtDate(r.dynTs),
      videoTs: r.videoTs, dynTs: r.dynTs,
      fans: r.fans ?? null, url: `https://space.bilibili.com/${r.mid}`,
      err: r.err || undefined,
    })),
  }
}

/** 出 CSV + Markdown */
function writeReport(args = {}) {
  const cache = loadCache()
  const rows = Object.values(cache.rows).filter((r) => r.checked)
  if (!rows.length) return { ok: false, err: '还没有扫描结果，先调用 bili_follow_scan' }
  ensureDir(OUT_DIR)
  const sd = staleDaysOf(args.staleDays)
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')
  rows.sort((a, b) => STATUS_RANK[statusOf(a, sd)] - STATUS_RANK[statusOf(b, sd)])
  const counts = countByStatus(rows, sd)

  const csvPath = join(OUT_DIR, `follow_${stamp}.csv`)
  const mdPath = join(OUT_DIR, `follow_${stamp}.md`)
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`
  const lines = [['状态', 'UID', '昵称', '最近投稿', '最近动态', '粉丝数', '主页'].join(',')]
  for (const r of rows) {
    lines.push([
      STATUS_LABEL[statusOf(r, sd)], r.mid, esc(r.name), fmtDate(r.videoTs) || '-',
      fmtDate(r.dynTs) || '-', r.fans ?? '', `https://space.bilibili.com/${r.mid}`,
    ].join(','))
  }
  writeFileSync(csvPath, '\ufeff' + lines.join('\n'))

  const md = [`# B站关注体检 ${new Date().toLocaleString('zh-CN')}`, '',
    `共 ${rows.length} 个关注：` + Object.entries(counts).map(([k, v]) => `${STATUS_LABEL[k]} ${v}`).join('，'), '']
  for (const key of ['deleted', 'zombie', 'empty', 'mutual', 'streamed', 'live', 'dynonly', 'error']) {
    const sub = rows.filter((r) => statusOf(r, sd) === key)
    md.push(`## ${STATUS_LABEL[key]}（${sub.length}）`, '')
    if (!sub.length) { md.push('无', ''); continue }
    md.push('| # | UID | 昵称 | 最近投稿 | 最近动态 | 粉丝 | 主页 |', '|---|---|---|---|---|---|---|')
    sub.forEach((r, i) => md.push(`| ${i + 1} | ${r.mid} | ${r.name} | ${fmtDate(r.videoTs) || '-'} | `
      + `${fmtDate(r.dynTs) || '-'} | ${r.fans ?? '-'} | https://space.bilibili.com/${r.mid} |`))
    md.push('')
  }
  writeFileSync(mdPath, md.join('\n'))
  return { ok: true, total: rows.length, counts, csv: csvPath, md: mdPath }
}

/** 取关（工具和设置页共用）。主播/互关默认保护。 */
async function doUnfollow(c, args = {}) {
  const mids = (args.mids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  if (!args.confirm) return { ok: false, err: '拒绝执行：需要 confirm:true（取关不可撤销，必须使用者当场确认）' }
  if (!mids.length) return { ok: false, err: 'mids 为空' }
  if (mids.length > 50) return { ok: false, err: '一次最多 50 个，请分批' }
  if (!c.bili_jct) return { ok: false, err: '凭证里没有 bili_jct（csrf），无法取关' }
  const cache = loadCache()
  // 主播保护：正在直播 / 播过的账号默认跳过
  const skippedLive = []
  const skippedMutual = []
  const targets = mids.filter((mid) => {
    const r = cache.rows[String(mid)]
    if (!r) return true
    if (!args.allowMutual && statusOf(r) === 'mutual') { skippedMutual.push(mid); return false }
    if (!args.allowLive && statusOf(r) === 'live') { skippedLive.push(mid); return false }
    if (!args.allowLive && statusOf(r) === 'streamed') { skippedLive.push(mid); return false }
    return true
  })
  if (!targets.length) {
    return { ok: false, err: `这 ${mids.length} 个都是正在直播/播过的账号，已全部跳过（确需删除请传 allowLive:true）` }
  }
  const results = []
  for (const [i, mid] of targets.entries()) {
    const r = await fetch('https://api.bilibili.com/x/relation/modify', {
      method: 'POST',
      headers: {
        'User-Agent': UA, Cookie: cookieHeader(c), Referer: 'https://space.bilibili.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ fid: String(mid), act: '2', re_src: '11', csrf: c.bili_jct }).toString(),
    }).then((x) => x.json()).catch((e) => ({ code: -1, message: String(e.message || e) }))
    const ok = r.code === 0
    const name = cache.rows[String(mid)]?.name
    if (ok) delete cache.rows[String(mid)]
    results.push({ mid, name, ok, code: r.code, message: r.message })
    if (i < targets.length - 1) await sleep(Math.max(500, Number(args.intervalMs) || 1500))
  }
  saveCache(cache)
  const okCount = results.filter((r) => r.ok).length
  return { ok: true, okCount, failCount: results.length - okCount, skippedLive, skippedMutual, results }
}

/** 总览（设置页顶部的卡片） */
function statusSummary() {
  const cache = loadCache()
  const rows = Object.values(cache.rows).filter((r) => r.checked)
  const c = loadCred()
  return {
    ok: true,
    credential: c ? { mid: c.dedeuserid, ready: true, hasCsrf: Boolean(c.bili_jct) } : { ready: false },
    scanned: rows.length,
    counts: countByStatus(rows),
    cacheUpdatedAt: cache.updatedAt ? new Date(cache.updatedAt * 1000).toLocaleString('zh-CN') : null,
    home: HOME,
  }
}

const STATUS_LABEL = {
  deleted: '已注销', zombie: '僵尸号', dynonly: '只发动态',
  empty: '零内容', error: '查询失败', alive: '正常',
  live: '正在直播', streamed: '播过（保留）', mutual: '互关（保留）',
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------- 工具
const localDefineTool = (options) => options
const TEXT_OUTPUT = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
}

export function apply(ctx) {
  let defineTool = localDefineTool
  // 宿主有就用宿主的（做参数校验/JSONSchema 规整），没有也能跑
  import('@deepseek-ai/dsh-tools')
    .then((m) => { if (m?.defineTool) defineTool = m.defineTool })
    .catch(() => { /* 用本地等价实现 */ })

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const value = await spec.execute(args)
      // 宿主只吃无损 JSON
      return JSON.parse(JSON.stringify(value ?? null))
    },
  }))

  const needCred = () => {
    const c = loadCred()
    if (!c) {
      throw new Error('还没有 B站 登录凭证。先调用 bili_follow_login 生成二维码，扫码后再调用 bili_follow_login_poll。'
        + '（也支持把 sessdata/bili_jct/buvid3/dedeuserid 写进 ~/.dsh/bili-follow/cred.json）')
    }
    return c
  }

  tool({
    name: 'bili_follow_login',
    description: '开始 B站 扫码登录，返回一个二维码页面地址。给使用者自己用手机 B站 App 扫（不经过第三方）。',
    parameters: {},
    async execute() {
      const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      })
      const j = await r.json()
      if (j.code !== 0) return { ok: false, err: `生成二维码失败 code ${j.code} ${j.message || ''}` }
      return {
        ok: true,
        url: j.data.url,
        qrcodeKey: j.data.qrcode_key,
        hint: '打开 url 用 B站 App 扫码，扫完回来调用 bili_follow_login_poll（qrcodeKey 传下面这个值）。二维码约 180 秒过期。',
      }
    },
  })

  tool({
    name: 'bili_follow_login_poll',
    description: '查扫码结果：成功后自动把凭证写到 ~/.dsh/bili-follow/cred.json。',
    parameters: {
      qrcodeKey: { type: 'string', description: 'bili_follow_login 返回的 qrcodeKey' },
    },
    async execute(args) {
      const key = String(args.qrcodeKey || '')
      if (!key) return { ok: false, err: '缺少 qrcodeKey' }
      const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key), {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      })
      const j = await r.json()
      // 86101 未扫码 / 86090 已扫待确认 / 86038 已过期 / 0 成功
      if (j.code !== 0) return { ok: false, status: 'waiting', err: `code ${j.code} ${j.message || ''}` }
      const d = j.data || {}
      if (d.code === 86101) return { ok: false, status: 'waiting', hint: '还没扫' }
      if (d.code === 86090) return { ok: false, status: 'scanned', hint: '已扫码，手机上点确认' }
      if (d.code === 86038) return { ok: false, status: 'expired', hint: '二维码过期，重新调用 bili_follow_login' }
      if (d.code !== 0) return { ok: false, status: 'unknown', err: String(d.code) }

      const url = new URL(d.url)
      const g = (k) => url.searchParams.get(k) || ''
      const cred = {
        sessdata: decodeURIComponent(g('SESSDATA')),
        bili_jct: g('bili_jct'),
        buvid3: g('buvid3') || '',
        dedeuserid: g('DedeUserID'),
      }
      ensureDir(HOME)
      writeFileSync(CRED_FILE, JSON.stringify(cred))
      return { ok: true, status: 'ok', mid: cred.dedeuserid, saved: CRED_FILE }
    },
  })

  tool({
    name: 'bili_follow_scan',
    description: '分批扫描关注列表：每个 UP 查最近一条投稿 + 最近一条动态，结果落缓存。'
      + '宿主工具有超时，所以按批调用：一次扫 limit 个（默认 40），反复调用直到 remaining 为 0。',
    parameters: {
      limit: { type: 'number', description: '这一批最多扫几个（默认 40，别超过 100）' },
      intervalMs: { type: 'number', description: '每个 UP 之间的间隔毫秒（默认 900，太小会被限流）' },
      refresh: { type: 'boolean', description: 'true = 丢掉旧缓存重扫' },
      staleDays: { type: 'number', description: '多少天没更新算僵尸（默认 730，比如传 365 就是一年）' },
    },
    async execute(args) {
      const r = await scanBatch(needCred(), args)
      return { ...r, next: r.remaining > 0 ? '继续调用 bili_follow_scan' : '可以出报表了：bili_follow_report' }
    },
  })

  tool({
    name: 'bili_follow_list',
    description: '按状态列名单。status: zombie=僵尸号(投稿和动态都超两年) / deleted=已注销 / empty=零内容 / '
      + 'dynonly=只发动态 / alive=正常 / all=全部。',
    parameters: {
      status: { type: 'string', enum: ['zombie', 'deleted', 'empty', 'dynonly', 'alive', 'error', 'all'], description: '筛选状态，默认 zombie' },
      limit: { type: 'number', description: '返回多少条，默认 50' },
      offset: { type: 'number', description: '跳过多少条，默认 0' },
      staleDays: { type: 'number', description: '多少天没更新算僵尸（默认 730）' },
    },
    async execute(args) {
      return listRows(args)
    },
  })

  tool({
    name: 'bili_follow_report',
    description: '导出 CSV + Markdown 名单到插件家目录的 out/ 下，返回文件路径与各状态数量。',
    parameters: {
      staleDays: { type: 'number', description: '多少天没更新算僵尸（默认 730）' },
    },
    async execute(args = {}) {
      return writeReport(args)
    },
  })

  tool({
    name: 'bili_follow_unfollow',
    description: '取关指定 UID（会真的改账号状态，调用方必须先把名单给使用者看过）。'
      + '必须传 confirm:true；一次最多 50 个。正在直播/播过的账号默认会被跳过（主播保护）。',
    parameters: {
      mids: { type: 'array', items: { type: 'number' }, description: '要取关的 UID 列表' },
      confirm: { type: 'boolean', description: '必须为 true，表示使用者已经确认这份名单' },
      allowLive: { type: 'boolean', description: 'true = 连正在直播/播过的账号也删（默认 false，防误删主播）' },
      allowMutual: { type: 'boolean', description: 'true = 连互相关注的账号也删（默认 false，那是认识的人）' },
      intervalMs: { type: 'number', description: '每个取关之间的间隔，默认 1500' },
    },
    async execute(args) {
      return doUnfollow(needCred(), args)
    },
  })

  tool({
    name: 'bili_follow_status',
    description: '关注体检的总览：缓存了多少、各状态数量、凭证是否就绪、缓存更新时间。',
    parameters: {},
    async execute() {
      return statusSummary()
    },
  })

  /* ─────────────── HTTP（设置页用） ───────────────
   * 设置页（client.js）跟这里说话。所有写入型动作（取关/存凭证）仍然要显式确认参数，
   * 网页上点一次按钮 = 一次明确的用户动作，跟会话里点头等价。
   * 扫描不能挂在 HTTP 请求里等（879 个要十几分钟），所以起后台任务、前端轮询进度。
   */
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    // 超过 1MB 先 settle 再掐断，否则 Promise 永远不返回、请求挂死
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  let job = null
  const jobView = () => (job ? {
    running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt,
    scanned: job.scanned, total: job.total, batches: job.batches,
    last: job.last, error: job.error || null,
  } : null)

  async function scanLoop(c, args) {
    job = { running: true, startedAt: Date.now(), scanned: 0, total: 0, batches: 0, last: null, stop: false, error: null }
    try {
      while (!job.stop) {
        const r = await scanBatch(c, { ...args, limit: args.limit || 40 })
        job.scanned = r.scannedTotal
        job.total = r.followingTotal
        job.batches += 1
        job.last = { scannedThisCall: r.scannedThisCall, remaining: r.remaining, counts: r.counts }
        if (!r.remaining) break
      }
    } catch (e) {
      job.error = String(e?.message || e)
    } finally {
      job.running = false
      job.finishedAt = Date.now()
    }
  }

  const handle = async (req, res, url) => {
    const p = url.pathname

    if (req.method === 'GET' && p === '/api/bili-follow/status') {
      return sendJson(res, 200, { ...statusSummary(), job: jobView() })
    }

    if (req.method === 'GET' && p === '/api/bili-follow/list') {
      return sendJson(res, 200, listRows({
        status: url.searchParams.get('status') || 'zombie',
        limit: Number(url.searchParams.get('limit')) || 50,
        offset: Number(url.searchParams.get('offset')) || 0,
        staleDays: Number(url.searchParams.get('staleDays')) || 730,
      }))
    }

    if (req.method === 'GET' && p === '/api/bili-follow/scan') {
      return sendJson(res, 200, { ok: true, job: jobView() })
    }

    if (req.method === 'POST' && p === '/api/bili-follow/scan') {
      if (job?.running) return sendJson(res, 200, { ok: false, error: '已经在扫了' })
      const body = await readBody(req)
      let c
      try { c = needCred() } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message || e) }) }
      scanLoop(c, body) // 不 await：立刻把控制权还给浏览器
      return sendJson(res, 200, { ok: true, started: true })
    }

    if (req.method === 'POST' && p === '/api/bili-follow/stop') {
      if (!job?.running) return sendJson(res, 200, { ok: true, running: false })
      job.stop = true
      return sendJson(res, 200, { ok: true, stopping: true })
    }

    if (req.method === 'POST' && p === '/api/bili-follow/report') {
      const body = await readBody(req)
      return sendJson(res, 200, writeReport(body))
    }

    if (req.method === 'POST' && p === '/api/bili-follow/unfollow') {
      const body = await readBody(req)
      let c
      try { c = needCred() } catch (e) { return sendJson(res, 200, { ok: false, err: String(e?.message || e) }) }
      return sendJson(res, 200, await doUnfollow(c, body))
    }

    // 手动贴凭证（从浏览器 F12 抄 cookie）。脚本类工具在这台机器上更省事的做法是复用「刷B站」的登录。
    if (req.method === 'POST' && p === '/api/bili-follow/cred') {
      const body = await readBody(req)
      const pick = (k) => String(body[k] || '').trim()
      const cred = { sessdata: pick('sessdata'), bili_jct: pick('bili_jct'), buvid3: pick('buvid3'), dedeuserid: pick('dedeuserid') }
      if (!cred.sessdata) return sendJson(res, 200, { ok: false, error: '缺少 sessdata' })
      ensureDir(HOME)
      writeFileSync(CRED_FILE, JSON.stringify(cred))
      return sendJson(res, 200, { ok: true, saved: CRED_FILE })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${p}` })
  }

  try {
    if (!ctx.webServer?.register) throw new Error('宿主没有 webServer 服务（版本太老？）')
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-follow',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) }
        catch (e) { try { sendJson(res, 500, { ok: false, error: e?.message ?? String(e) }) } catch { /* 响应已发出 */ } }
      },
    }), 'bili-follow-doctor: /api/bili-follow 路由')
  } catch (e) {
    console.warn('[bili-follow-doctor] HTTP 路由没挂上，设置页不可用：', e?.message ?? e)
  }
}
