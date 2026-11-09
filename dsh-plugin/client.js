/**
 * dsh-bili-follow-doctor —— 浏览器半端（设置页）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<必须等于 package.json 的 name>',
 *       factory: (require) => ({ inject: ['slots'], apply(ctx) { ... } }),
 *     })
 *
 * 一页两个页签：关注体检 / 收藏夹体检，共用同一套凭证和接口前缀
 * （/api/bili-follow 和 /api/bili-follow/fav/*）。
 *
 * 设计取舍：
 *   - 扫描是后台任务 + 轮询进度，不在 HTTP 请求里等。
 *   - 取关、清空收藏夹都必须点两次（勾选/看清单 → 弹确认框）。
 *   - 收藏夹清理走 B站 官方的「清空失效内容」接口，一次清一个夹。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-follow-doctor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const API = '/api/bili-follow'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（没登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = (p) => fetch(API + p, { credentials: 'same-origin' }).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(asJson)

    const STATUS = [
      ['zombie', '僵尸号'],
      ['deleted', '已注销'],
      ['empty', '零内容'],
      ['dynonly', '只发动态'],
      ['streamed', '播过的主播'],
      ['live', '正在直播'],
      ['mutual', '互关'],
      ['alive', '正常'],
      ['error', '查询失败'],
    ]
    const fmtNum = (n) => {
      if (n === null || n === undefined) return '-'
      if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
      if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
      return String(n)
    }
    const PAGE = 100

    const CSS = `
[data-fd-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 12px;max-width:960px;}
[data-fd-sec]{display:flex;flex-direction:column;gap:9px;}
[data-fd-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fd-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-fd-grow]{flex:1;min-width:0;}
[data-fd-label]{font-size:13px;}
[data-fd-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fd-msg]{font-size:11.5px;line-height:17px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fd-msg][data-warn]{color:#f59e0b;}
[data-fd-msg][data-good]{color:#22c55e;}
[data-fd-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;}
[data-fd-input]:focus{outline:none;border-color:#fb7299;}
[data-fd-num]{width:74px;text-align:center;}
[data-fd-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-fd-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-fd-btn][data-primary]{background:#fb7299;border-color:#fb7299;color:#fff;}
[data-fd-btn][data-primary]:hover{filter:brightness(1.06);}
[data-fd-btn][data-danger]{border-color:#5a2a30;color:#e5646e;}
[data-fd-btn][data-danger]:hover{background:rgba(229,100,110,.12);}
[data-fd-btn][disabled]{opacity:.45;cursor:default;}
[data-fd-tabs]{display:flex;gap:4px;padding:3px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));}
[data-fd-tab]{flex:1;padding:7px 10px;border:0;border-radius:8px;background:transparent;font:inherit;
  font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary,inherit);}
[data-fd-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-fd-tab][data-on]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);
  font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
[data-fd-cards]{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;}
[data-fd-card]{display:flex;flex-direction:column;gap:1px;padding:9px 11px;border-radius:10px;cursor:pointer;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));text-align:left;font:inherit;color:inherit;}
[data-fd-card]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-fd-card][data-on]{border-color:#fb7299;background:rgba(251,114,153,.10);}
[data-fd-card b]{font-size:17px;font-weight:600;line-height:22px;}
[data-fd-card i]{font-style:normal;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fd-bar]{height:5px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));}
[data-fd-bar] div{height:100%;background:linear-gradient(90deg,#fb7299,#7aa2f7);transition:width .25s;}
[data-fd-table]{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;}
[data-fd-table] th{font-weight:500;text-align:left;padding:6px 5px;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);border-bottom:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-fd-table] td{padding:5px;border-bottom:1px solid var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-fd-table] tr:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07));}
[data-fd-table] a{color:inherit;text-decoration:none;}
[data-fd-table] a:hover{text-decoration:underline;color:#fb7299;}
[data-fd-tag]{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;white-space:nowrap;}
[data-fd-tag][data-s=deleted]{background:rgba(229,100,110,.14);color:#e5646e;}
[data-fd-tag][data-s=zombie]{background:rgba(240,163,94,.14);color:#f0a35e;}
[data-fd-tag][data-s=dynonly]{background:rgba(122,162,247,.14);color:#7aa2f7;}
[data-fd-tag][data-s=empty]{background:rgba(139,152,169,.14);color:#8b98a9;}
[data-fd-tag][data-s=alive]{background:rgba(94,201,122,.14);color:#5ec97a;}
[data-fd-tag][data-s=live]{background:rgba(162,89,255,.14);color:#b98cff;}
[data-fd-tag][data-s=streamed]{background:rgba(162,89,255,.10);color:#9d7cd8;}
[data-fd-tag][data-s=mutual]{background:rgba(77,201,192,.14);color:#4dc9c0;}
[data-fd-tag][data-s=error]{background:rgba(139,152,169,.14);color:#8b98a9;}
[data-fd-scroll]{max-height:min(46vh,420px);overflow:auto;}
[data-fd-chips]{display:flex;gap:5px;flex-wrap:wrap;}
[data-fd-chip]{cursor:pointer;white-space:nowrap;font:inherit;font-size:11.5px;padding:3px 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));background:transparent;
  color:var(--dsw-alias-label-secondary,inherit);}
[data-fd-chip]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
[data-fd-chip][data-on]{color:#fb7299;border-color:#fb7299;background:rgba(251,114,153,.10);}
[data-fd-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-fd-form]{display:grid;grid-template-columns:112px 1fr;gap:6px 8px;align-items:center;max-width:520px;}
[data-fd-form] label{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fd-folder]{display:flex;align-items:center;gap:9px;padding:7px 4px;
  border-bottom:1px solid var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));}
[data-fd-folder]:last-child{border-bottom:0;}
[data-fd-folder-n]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}
[data-fd-folder-d]{font-size:11.5px;color:#e5646e;flex:none;font-variant-numeric:tabular-nums;}
`

    function Card({ label, n, on, onClick }) {
      return h('button', { 'data-fd-card': '', 'data-on': on ? '' : undefined, onClick },
        h('b', {}, String(n ?? 0)),
        h('i', {}, label))
    }

    function Panel() {
      const [tab, setTab] = useState('follow')
      const [st, setSt] = useState(null)
      const [fav, setFav] = useState(null)
      const [err, setErr] = useState('')
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState('')
      const [filter, setFilter] = useState('zombie')
      const [rows, setRows] = useState([])
      const [total, setTotal] = useState(0)
      const [page, setPage] = useState(0)
      const [picked, setPicked] = useState([])
      const [staleDays, setStaleDays] = useState(730)
      const [report, setReport] = useState(null)
      const [form, setForm] = useState({ sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' })

      const loadRows = useCallback(async () => {
        try {
          const r = await jget(`/list?status=${filter}&limit=${PAGE}&offset=${page * PAGE}&staleDays=${staleDays}`)
          setRows(r.rows || [])
          setTotal(r.total || 0)
        } catch (e) { setErr(String(e?.message || e)) }
      }, [filter, page, staleDays])

      const loadRowsRef = useRef(loadRows)
      useEffect(() => { loadRowsRef.current = loadRows }, [loadRows])
      useEffect(() => { loadRows() }, [loadRows])

      // 轮询：关注进度 + 收藏夹进度
      const lastScanned = useRef(-1)
      const lastFavDone = useRef(-1)
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const s = await jget('/status')
            const f = await jget('/fav')
            if (!alive) return
            setSt(s)
            setFav(f)
            setErr('')
            const n = s.job?.scanned ?? -1
            if (n !== lastScanned.current) {
              lastScanned.current = n
              if (n >= 0) loadRowsRef.current()
            }
            const d = f.job?.done ?? -1
            if (d !== lastFavDone.current) {
              lastFavDone.current = d
              if (d >= 0) setPage(0)
            }
          } catch (e) {
            if (alive) setErr(String(e?.message || e))
          }
          if (alive) timer = setTimeout(tick, 3000)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      const job = st?.job
      const scanning = Boolean(job?.running)
      const counts = st?.counts || {}
      const cred = st?.credential || {}
      const pct = job?.total ? Math.min(100, (job.scanned / job.total) * 100) : 0

      const favJob = fav?.job
      const favScanning = Boolean(favJob?.running)
      const favFoldersList = favJob?.folders?.length ? favJob.folders : (fav?.cached?.folders || [])
      const favTotalDead = favFoldersList.reduce((s, f) => s + (f.dead || 0), 0)

      const onScan = async () => {
        setBusy('scan'); setNote(null)
        try {
          const r = await jpost('/scan', { limit: 40, staleDays })
          if (!r.ok) setNote({ text: r.error || '启动失败', warn: true })
          else setNote({ text: '开始扫描（后台跑，可以离开这一页）' })
        } catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
        finally { setBusy('') }
      }

      const onStop = async () => {
        try { await jpost('/stop'); setNote({ text: '正在停（这一批跑完就停）' }) }
        catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
      }

      const onReport = async () => {
        setBusy('report')
        try {
          const r = await jpost('/report', { staleDays })
          if (r.ok) setReport(r)
          else setNote({ text: r.err || '导出失败', warn: true })
        } catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
        finally { setBusy('') }
      }

      const onSaveCred = async () => {
        setBusy('cred')
        try {
          const r = await jpost('/cred', form)
          if (r.ok) { setNote({ text: '凭证已保存' }); setForm({ sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' }) }
          else setNote({ text: r.error || '保存失败', warn: true })
        } catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
        finally { setBusy('') }
      }

      const onUnfollow = async () => {
        if (!picked.length) return
        const names = rows.filter((r) => picked.includes(r.mid)).map((r) => r.name)
        const preview = names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 个` : '')
        if (!window.confirm(`确定取关这 ${picked.length} 个？\n\n${preview}\n\n`
          + 'B站没有批量撤销，取关后要一个个手动加回来。')) return
        setBusy('unfollow')
        try {
          const r = await jpost('/unfollow', { mids: picked, confirm: true })
          if (r.ok) {
            const extra = [
              r.skippedLive?.length ? `跳过主播 ${r.skippedLive.length}` : '',
              r.skippedMutual?.length ? `跳过互关 ${r.skippedMutual.length}` : '',
            ].filter(Boolean).join('，')
            setNote({ text: `取关完成：成功 ${r.okCount} 个，失败 ${r.failCount} 个${extra ? '，' + extra : ''}` })
            setPicked([])
            loadRowsRef.current()
          } else setNote({ text: r.err || '取关失败', warn: true })
        } catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
        finally { setBusy('') }
      }

      const onFavScan = async () => {
        setBusy('favscan'); setNote(null)
        try {
          const r = await jpost('/fav/scan', {})
          if (!r.ok) setNote({ text: r.error || '启动失败', warn: true })
          else setNote({ text: '开始扫描收藏夹（后台跑，可以离开这一页）' })
        } catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
        finally { setBusy('') }
      }

      const onFavStop = async () => {
        try { await jpost('/fav/stop'); setNote({ text: '正在停…' }) }
        catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
      }

      const onFavClean = async (f) => {
        if (!f.dead) return
        if (!window.confirm(`清空「${f.title}」里的 ${f.dead} 个失效视频？\n\n`
          + 'B站 没有批量恢复，删了要一个个手动加回来。')) return
        setBusy('favclean-' + f.id)
        try {
          const r = await jpost('/fav/clean', { mediaId: f.id })
          if (r.code === 0) setNote({ text: `✅ 「${f.title}」已清理` })
          else setNote({ text: `❌ 「${f.title}」清理失败：code ${r.code} ${r.message || ''}`, warn: true })
        } catch (e) { setNote({ text: String(e?.message || e), warn: true }) }
        finally { setBusy('') }
      }

      const toggle = (mid) => setPicked((p) => (p.includes(mid) ? p.filter((x) => x !== mid) : [...p, mid]))
      const allPicked = rows.length > 0 && rows.every((r) => picked.includes(r.mid))

      /* ── 凭证 ── */
      const credBlock = cred.ready
        ? h('div', { 'data-fd-row': '' },
          h('span', { 'data-fd-tag': '', 'data-s': 'alive' }, '已登录'),
          h('span', { 'data-fd-note': '' }, `UID ${cred.mid || '?'}`),
          cred.hasCsrf ? null : h('span', { 'data-fd-note': '' }, '· 凭证里没有 bili_jct，取关/清理会失败'))
        : h('div', { 'data-fd-sec': '' },
          h('div', { 'data-fd-note': '' }, '没有 B站 登录凭证。装过「刷B站」的话本插件会直接复用它的登录；否则从浏览器 F12 → Application → Cookies 里抄下面四项。'),
          h('div', { 'data-fd-form': '' },
            h('label', {}, 'SESSDATA'),
            h('input', { 'data-fd-input': '', value: form.sessdata,
              onChange: (e) => setForm({ ...form, sessdata: e.target.value }) }),
            h('label', {}, 'bili_jct'),
            h('input', { 'data-fd-input': '', value: form.bili_jct,
              onChange: (e) => setForm({ ...form, bili_jct: e.target.value }) }),
            h('label', {}, 'buvid3'),
            h('input', { 'data-fd-input': '', value: form.buvid3,
              onChange: (e) => setForm({ ...form, buvid3: e.target.value }) }),
            h('label', {}, 'DedeUserID'),
            h('input', { 'data-fd-input': '', value: form.dedeuserid,
              onChange: (e) => setForm({ ...form, dedeuserid: e.target.value }) })),
          h('div', { 'data-fd-row': '' },
            h('button', { 'data-fd-btn': '', 'data-primary': '', disabled: busy === 'cred', onClick: onSaveCred }, '保存凭证')))

      /* ── 关注体检 ── */
      const chips = h('div', { 'data-fd-chips': '' },
        [['all', '全部']].concat(STATUS).map(([k, label]) =>
          h('button', {
            key: k, 'data-fd-chip': '', 'data-on': filter === k ? '' : undefined,
            onClick: () => { setFilter(k); setPage(0); setPicked([]) },
          }, `${label}${k === 'all' ? '' : ' ' + (counts[k] || 0)}`)))

      const table = h('div', { 'data-fd-scroll': '' },
        h('table', { 'data-fd-table': '' },
          h('thead', {}, h('tr', {},
            h('th', { style: { width: '30px' } },
              h('input', {
                type: 'checkbox', checked: allPicked,
                onChange: (e) => setPicked(e.target.checked ? rows.map((r) => r.mid) : []),
              })),
            h('th', {}, '昵称'), h('th', { style: { width: '84px' } }, '状态'),
            h('th', { style: { width: '96px' } }, '最近投稿'), h('th', { style: { width: '96px' } }, '最近动态'),
            h('th', { style: { width: '58px' } }, '粉丝'))),
          h('tbody', {}, rows.length
            ? rows.map((r) => h('tr', { key: r.mid },
              h('td', {}, h('input', {
                type: 'checkbox', checked: picked.includes(r.mid), onChange: () => toggle(r.mid),
              })),
              h('td', { title: r.name }, h('a', {
                href: r.url, target: '_blank', rel: 'noreferrer',
              }, r.name || r.mid)),
              h('td', {}, h('span', { 'data-fd-tag': '', 'data-s': r.status }, r.statusText || r.status)),
              h('td', {}, r.lastVideo || '-'),
              h('td', {}, r.lastDynamic || '-'),
              h('td', {}, fmtNum(r.fans))))
            : h('tr', {}, h('td', { colSpan: 6, 'data-fd-note': '', style: { padding: '14px 5px' } },
              '这个分类下没有记录。先点上面的「开始扫描」。')))))

      const followPane = [
        h('div', { 'data-fd-sec': '', key: 'overview' },
          h('div', { 'data-fd-h': '' }, '总览'),
          h('div', { 'data-fd-row': '' },
            h('div', { 'data-fd-grow': '' },
              h('div', { 'data-fd-label': '' }, `已扫 ${st?.scanned ?? 0} 个关注`),
              h('div', { 'data-fd-note': '' },
                st?.cacheUpdatedAt ? `缓存更新于 ${st.cacheUpdatedAt}` : '还没有扫描记录'))),
          h('div', { 'data-fd-cards': '' },
            STATUS.map(([k, label]) => h(Card, {
              key: k, label, n: counts[k], on: filter === k,
              onClick: () => { setFilter(k); setPage(0); setPicked([]) },
            })))),

        h('div', { 'data-fd-sec': '', key: 'scan' },
          h('div', { 'data-fd-h': '' }, '开始扫描'),
          h('div', { 'data-fd-row': '' },
            h('span', { 'data-fd-note': '' }, '多久没动静算僵尸'),
            h('input', {
              'data-fd-input': '', 'data-fd-num': '', type: 'number', min: 30, step: 1, value: staleDays,
              onChange: (e) => setStaleDays(Math.max(30, Math.round(Number(e.target.value) || 730))),
            }),
            h('span', { 'data-fd-note': '' }, '天'),
            [365, 730, 1095].map((d) => h('button', {
              key: d, 'data-fd-chip': '', 'data-on': staleDays === d ? '' : undefined,
              onClick: () => setStaleDays(d),
            }, d === 365 ? '1 年' : d === 730 ? '2 年' : '3 年'))),
          h('div', { 'data-fd-row': '' },
            h('button', {
              'data-fd-btn': '', 'data-primary': '', disabled: scanning || busy === 'scan' || !cred.ready, onClick: onScan,
            }, scanning ? '正在扫描…' : '开始扫描'),
            h('button', { 'data-fd-btn': '', disabled: !scanning, onClick: onStop }, '停止'),
            h('button', { 'data-fd-btn': '', disabled: busy === 'report', onClick: onReport }, '导出 CSV + Markdown'),
            h('span', { 'data-fd-note': '', 'data-fd-grow': '' }, scanning
              ? `已扫 ${job.scanned}${job.total ? '/' + job.total : ''} 个 · 第 ${job.batches} 批`
              : st?.scanned ? '扫完了。名单在下面，按状态筛。' : '还没扫过。'))),
        scanning || job?.scanned ? h('div', { 'data-fd-bar': '', key: 'bar' }, h('div', { style: { width: pct + '%' } })) : null,
        job?.error ? h('div', { 'data-fd-msg': '', 'data-warn': '', key: 'joberr' }, '扫描中断：' + job.error) : null,
        report ? h('div', { 'data-fd-msg': '', 'data-good': '', key: 'rep' },
          '报表已生成：', h('br'), `CSV  ${report.csv}`, h('br'), `MD   ${report.md}`) : null,

        h('div', { 'data-fd-sec': '', key: 'list' },
          h('div', { 'data-fd-row': '' },
            h('div', { 'data-fd-h': '', 'data-fd-grow': '' }, `名单（${total}）`),
            h('button', {
              'data-fd-btn': '', 'data-danger': '', disabled: !picked.length || busy === 'unfollow', onClick: onUnfollow,
            }, picked.length ? `取关选中的 ${picked.length} 个` : '取关选中的')),
          chips,
          table,
          total > PAGE ? h('div', { 'data-fd-row': '' },
            h('button', { 'data-fd-btn': '', disabled: page === 0, onClick: () => setPage(page - 1) }, '上一页'),
            h('span', { 'data-fd-note': '' }, `${page + 1} / ${Math.max(1, Math.ceil(total / PAGE))}`),
            h('button', { 'data-fd-btn': '', disabled: (page + 1) * PAGE >= total,
              onClick: () => setPage(page + 1) }, '下一页')) : null),
      ]

      /* ── 收藏夹体检 ── */
      const favPane = [
        h('div', { 'data-fd-sec': '', key: 'favhead' },
          h('div', { 'data-fd-h': '' }, '收藏夹'),
          h('div', { 'data-fd-note': '' },
            '扫出收藏夹里已失效的视频（UP 删了 / 设私密 / 被下架）。清理走 B站 官方的「清空失效内容」接口，一次清一个收藏夹。'),
          h('div', { 'data-fd-row': '' },
            h('button', {
              'data-fd-btn': '', 'data-primary': '', disabled: favScanning || busy === 'favscan' || !cred.ready, onClick: onFavScan,
            }, favScanning ? '正在扫描…' : '扫描收藏夹'),
            h('button', { 'data-fd-btn': '', disabled: !favScanning, onClick: onFavStop }, '停止'),
            h('span', { 'data-fd-note': '', 'data-fd-grow': '' }, favScanning
              ? `已扫 ${favJob.done}/${favJob.total} 个收藏夹`
              : favFoldersList.length
                ? `${favFoldersList.length} 个收藏夹 · ${favTotalDead} 个失效`
                : '还没扫过。'))),
        favScanning ? h('div', { 'data-fd-bar': '', key: 'favbar' },
          h('div', { style: { width: (favJob.total ? (favJob.done / favJob.total) * 100 : 0) + '%' } })) : null,
        favJob?.error ? h('div', { 'data-fd-msg': '', 'data-warn': '', key: 'faverr' }, '扫描中断：' + favJob.error) : null,

        h('div', { 'data-fd-sec': '', key: 'favlist' },
          h('div', { 'data-fd-h': '' }, favFoldersList.length ? `收藏夹（${favFoldersList.length}）` : ''),
          favFoldersList.length
            ? h('div', { 'data-fd-scroll': '' },
              favFoldersList.map((f) => h('div', { 'data-fd-folder': '', key: f.id },
                h('span', { 'data-fd-folder-n': '', title: f.title }, f.title),
                h('span', { 'data-fd-folder-d': '' }, `${f.dead || 0} / ${f.scanned || f.count || 0}`),
                h('button', {
                  'data-fd-btn': '', 'data-danger': '',
                  disabled: !f.dead || busy === 'favclean-' + f.id,
                  onClick: () => onFavClean(f),
                }, f.dead ? `清理 ${f.dead}` : '干净'))))
            : h('div', { 'data-fd-note': '', style: { padding: '12px 2px' } }, '点上面的「扫描收藏夹」开始。')),
      ]

      return h('div', { 'data-fd-page': '' },
        // 标题
        h('div', { 'data-fd-sec': '' },
          h('div', { 'data-fd-label': '', style: { fontSize: '15px', fontWeight: 600 } }, '🐟 B站体检'),
          h('div', { 'data-fd-note': '' },
            '两个体检合在一页：关注列表查「人还在不在」，收藏夹查「视频还在不在」。'
            + '取关和清理都要你确认过才动，主播/互关默认跳过。')),

        // 页签
        h('div', { 'data-fd-tabs': '' },
          [['follow', '关注体检'], ['fav', '收藏夹体检']].map(([k, label]) =>
            h('button', {
              key: k, 'data-fd-tab': '', 'data-on': tab === k ? '' : undefined,
              onClick: () => setTab(k),
            }, label))),

        // 凭证（两个页签共用）
        h('div', { 'data-fd-sec': '' }, h('div', { 'data-fd-h': '' }, '账号'), credBlock),

        note ? h('div', { 'data-fd-msg': '', 'data-warn': note.warn ? '' : undefined,
          'data-good': note.warn ? undefined : '' }, note.text) : null,
        err ? h('div', { 'data-fd-msg': '', 'data-warn': '' }, '接口出错：' + err) : null,

        // 内容
        ...(tab === 'follow' ? followPane : favPane),

        // 尾巴
        h('div', { 'data-fd-kv': '' },
          `家目录：${st?.home || '-'}`, h('br'),
          '数据只存在这台机器上。扫描走的都是本机到 B站 的请求，不经过任何第三方服务器。')
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-follow-doctor')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'bili-follow-doctor: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-follow-doctor', order: 32, label: 'B站体检' },
          () => h(Panel),
        ))
      },
    }
  },
})
