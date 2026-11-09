// ==UserScript==
// @name         B站体检 · Follow & Fav Doctor
// @namespace    https://github.com/mituan/bili-follow-doctor
// @version      1.4.0
// @description  两个体检合在一个面板：① 关注列表——标出已注销和长期不更新的僵尸 UP，播过直播的保留；② 收藏夹——找出已失效的视频，一键清理。纯本地运行，不经过任何服务器。
// @author       米团
// @match        *://space.bilibili.com/*
// @match        *://www.bilibili.com/*
// @match        *://t.bilibili.com/*
// @match        *://live.bilibili.com/*
// @match        *://search.bilibili.com/*
// @match        *://bilibili.com/*
// @updateURL    https://cdn.jsdelivr.net/gh/oTAKUBANG1/bili-follow-doctor@main/bili-follow-doctor.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/oTAKUBANG1/bili-follow-doctor@main/bili-follow-doctor.user.js
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      app.bilibili.com
// @connect      api.bilibili.com
// @connect      api.live.bilibili.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* eslint-disable no-console */
(() => {
  "use strict";

  const VERSION = "1.4.0";
  const CACHE_KEY = "bfd.cache.v2";
  const CONFIG_KEY = "bfd.config.v1";
  const TWO_YEARS = 730 * 86400;

  // ---------------------------------------------------------------- 小工具
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Math.floor(Date.now() / 1000);
  const fmtDate = (ts) => {
    if (!ts) return "-";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const days = (ts) => (ts ? Math.floor((now() - ts) / 86400) : "");
  const num = (n) => {
    if (n === null || n === undefined || n === "") return "-";
    if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
    return String(n);
  };
  const getCookie = (k) => {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + k + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  };

  // ---------------------------------------------------------------- md5（wbi 签名要用）
  const md5 = (() => {
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
    return (str) => {
      const utf8 = unescape(encodeURIComponent(str));
      const words = [];
      for (let i = 0; i < utf8.length; i++) words[i >> 2] |= utf8.charCodeAt(i) << (8 * (i % 4));
      const bitLen = utf8.length * 8;
      words[bitLen >> 5] |= 0x80 << (bitLen % 32);
      words[(((bitLen + 64) >>> 9) << 4) + 14] = bitLen;
      let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      for (let i = 0; i < words.length; i += 16) {
        let A = a0, B = b0, C = c0, D = d0;
        for (let j = 0; j < 64; j++) {
          let F, g;
          if (j < 16) { F = (B & C) | (~B & D); g = j; }
          else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
          else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * j) % 16; }
          F = (F + A + K[j] + (words[i + g] | 0)) | 0;
          A = D; D = C; C = B;
          B = (B + ((F << S[j]) | (F >>> (32 - S[j])))) | 0;
        }
        a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
      }
      return [a0, b0, c0, d0].map((w) => {
        let s = "";
        for (let i = 0; i < 4; i++) s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
        return s;
      }).join("");
    };
  })();

  // ---------------------------------------------------------------- 网络层
  const request = (url, opts = {}) => new Promise((resolve, reject) => {
    const { method = "GET", headers = {}, body = null } = opts;
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method, url, headers, data: body, timeout: 25000,
        onload: (r) => {
          try { resolve({ status: r.status, json: JSON.parse(r.responseText) }); }
          catch { resolve({ status: r.status, json: null, text: r.responseText }); }
        },
        ontimeout: () => reject(new Error("timeout")),
        onerror: () => reject(new Error("network")),
      });
      return;
    }
    fetch(url, { method, headers, body, credentials: "include" })
      .then(async (r) => resolve({ status: r.status, json: await r.json().catch(() => null) }))
      .catch(reject);
  });

  // 节流：所有 B站 请求排队，间隔 ≥ interval，遇到 412 整队降温
  class Throttle {
    constructor(interval = 1200) {
      this.interval = interval;
      this.last = 0;
      this.cooldownUntil = 0;
      this.onCooldown = null;
    }
    async wait() {
      while (Date.now() < this.cooldownUntil) {
        if (this.onCooldown) this.onCooldown(Math.ceil((this.cooldownUntil - Date.now()) / 1000));
        await sleep(1000);
      }
      const gap = this.last + this.interval - Date.now();
      if (gap > 0) await sleep(gap);
    }
    hit() { this.last = Date.now(); }
    cool(sec) {
      this.cooldownUntil = Date.now() + sec * 1000;
      if (this.onCooldown) this.onCooldown(sec);
    }
  }

  const api = {
    cookieNum: 0,
    async web(path, params = {}, tries = 4) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
      const url = "https://api.bilibili.com" + path + "?" + q;
      for (let i = 0; i < tries; i++) {
        await app.throttleWeb.wait();
        let r;
        try { r = await request(url, { headers: { Referer: location.href } }); }
        catch (e) { if (i === tries - 1) throw e; await sleep(2000); continue; }
        app.throttleWeb.hit();
        if (r.status === 412 || r.status === 429 || r.json?.code === -412) {
          if (i === tries - 1) throw new Error("被B站限流（412），请过几分钟再继续");
          app.throttleWeb.cool(30 * (i + 1));
          continue;
        }
        if (!r.json) throw new Error("返回不是 JSON（HTTP " + r.status + "）");
        return r.json;
      }
      throw new Error("重试耗尽");
    },
    // 最近投稿：app 通道，免登录态、限速宽松；走 GM 请求绕开跨域
    async lastVideo(mid, tries = 3) {
      const p = new URLSearchParams({
        vmid: mid, pn: "1", ps: "1", order: "pubdate",
        mobi_app: "android", platform: "android", build: "7700000",
        appkey: "1d8b6e7d45233436", ts: String(now()),
      });
      const sorted = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      const q = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      p.set("sign", md5(q + "560c52ccd288fed045859ed18bffd973"));
      const url = "https://app.bilibili.com/x/v2/space/archive?" + p;
      for (let i = 0; i < tries; i++) {
        await app.throttleApp.wait();
        try {
          const r = await request(url, { headers: { Referer: "https://www.bilibili.com/" } });
          app.throttleApp.hit();
          if (r.status === 412 || r.status === 429) { app.throttleApp.cool(20); continue; }
          const j = r.json;
          if (!j) return { ok: false, err: "HTTP " + r.status };
          if (j.code === 0) {
            const items = j.data?.item || [];
            return { ok: true, ts: items.length ? Number(items[0].ctime) || 0 : 0 };
          }
          return { ok: false, err: `code ${j.code} ${j.message || ""}` };
        } catch (e) {
          if (i === tries - 1) return { ok: false, err: String(e.message || e) };
          await sleep(1500);
        }
      }
      return { ok: false, err: "重试耗尽" };
    },
    async mixinKey() {
      if (app.wbiKey && app.wbiDay === new Date().toDateString()) return app.wbiKey;
      const j = await this.web("/x/web-interface/nav", {});
      const img = (j?.data?.wbi_img?.img_url || "").split("/").pop().split(".")[0];
      const sub = (j?.data?.wbi_img?.sub_url || "").split("/").pop().split(".")[0];
      if (!img || !sub) throw new Error("拿不到 wbi key（可能未登录）");
      const raw = img + sub;
      const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,
        39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,
        63,57,62,11,36,20,34,44,52];
      app.wbiKey = TAB.map((i) => raw[i]).join("").slice(0, 32);
      app.wbiDay = new Date().toDateString();
      return app.wbiKey;
    },
    async lastDynamic(mid, tries = 3) {
      const key = await this.mixinKey();
      for (let i = 0; i < tries; i++) {
        const p = new URLSearchParams({
          host_mid: mid, timezone_offset: "-480", platform: "web",
          features: "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote",
          wts: String(now()),
        });
        const sorted = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
        const q = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
        p.set("w_rid", md5(q + key));
        await app.throttleWeb.wait();
        try {
          const r = await request("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?" + p,
            { headers: { Referer: `https://space.bilibili.com/${mid}` } });
          app.throttleWeb.hit();
          const j = r.json;
          if (!j) return { ok: false, err: "HTTP " + r.status };
          if (j.code === 0) {
            const items = j.data?.items || [];
            return { ok: true, ts: items.length ? Number(items[0].modules?.module_author?.pub_ts) || 0 : 0 };
          }
          if (j.code === -412 || r.status === 412) { app.throttleWeb.cool(30); app.wbiKey = null; continue; }
          return { ok: false, err: `code ${j.code}` };
        } catch (e) {
          if (i === tries - 1) return { ok: false, err: String(e.message || e) };
          await sleep(1500);
        }
      }
      return { ok: false, err: "重试耗尽" };
    },
    async followings(selfMid, onPage) {
      const out = [];
      for (let pn = 1; pn <= 80; pn++) {
        const j = await this.web("/x/relation/followings",
          { vmid: selfMid, pn, ps: 50, order: "desc", order_type: "attention" });
        if (j.code !== 0) throw new Error(`关注列表读取失败：code ${j.code} ${j.message || ""}（请确认已登录）`);
        const list = j.data?.list || [];
        out.push(...list);
        onPage?.(out.length, j.data?.total || 0);
        if (list.length < 50 || out.length >= (j.data?.total || 0)) break;
        await sleep(300);
      }
      return out;
    },
    // POST：收藏夹清理这类写操作用
    async post(path, params = {}, tries = 3) {
      const url = "https://api.bilibili.com" + path;
      const body = new URLSearchParams(params).toString();
      for (let i = 0; i < tries; i++) {
        await app.throttleWeb.wait();
        let r;
        try {
          r = await request(url, {
            method: "POST",
            headers: { Referer: location.href, "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });
        } catch (e) { if (i === tries - 1) throw e; await sleep(2000); continue; }
        app.throttleWeb.hit();
        if (r.status === 412 || r.status === 429) { app.throttleWeb.cool(60); continue; }
        if (!r.json) throw new Error("返回不是 JSON（HTTP " + r.status + "）");
        return r.json;
      }
      throw new Error("重试耗尽");
    },
    async unfollow(mid) {
      const j = await this.web("/x/relation/modify", {
        fid: mid, act: 2, re_src: 11, csrf: getCookie("bili_jct"),
      }, 3);
      return j.code === 0;
    },
    async card(mid) {
      const j = await this.web("/x/web-interface/card", { mid }, 2);
      if (j.code === 0 && j.data) return { ok: true, name: j.data.card?.name, fans: j.data.follower };
      if (j.code === -404) return { ok: false, deleted: true };
      return { ok: false, err: `code ${j.code}` };
    },
    // 直播：B站 不开放「上次开播时间」（离线时 live_time 恒为 0000），
    // 所以用「有没有自定义标题/分区」判断播没播过，播过的一律保留
    async liveInfo(mid) {
      try {
        const a = await request(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${mid}`,
          { headers: { Referer: "https://live.bilibili.com/" } });
        const d = a.json?.data || {};
        const roomid = d.roomid || 0;
        if (!roomid) return { room: 0, live: false, streamed: false };
        await sleep(120);
        const b = await request(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomid}`,
          { headers: { Referer: "https://live.bilibili.com/" } });
        const e = b.json?.data || {};
        const title = (e.title || "").trim();
        const area = (e.area_name || "").trim();
        const streamed = !(title.endsWith("的直播间") && title.startsWith("用户")) || !!area;
        return { room: roomid, live: e.live_status === 1, streamed, title };
      } catch {
        return { room: 0, live: false, streamed: false };
      }
    },
  };

  // ---------------------------------------------------------------- 应用状态
  const app = {
    cache: {},
    config: { interval: 1200, autoFans: true, staleDays: 730 },
    // 两条独立的限速池：app 通道（投稿）可以快，web 接口（动态/资料）必须慢。
    // 挤在一个池里是之前慢的主因 —— 837 个 × 3 请求 × 1.2s ≈ 50 分钟。
    throttleApp: new Throttle(450),
    throttleWeb: new Throttle(1200),
    throttle: new Throttle(1200), // 兼容旧引用，实际用上面两个
    scanning: false,
    aborted: false,
    // 收藏夹体检的状态（跟关注体检分开，但共用同一套凭证和限流池）
    tab: "follow",
    fav: { folders: [], scanning: false, aborted: false, at: 0 },
    selfMid: "",
    rows: [],
    filter: "zombie",
    ui: {},
  };

  const loadState = () => {
    try { app.cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { app.cache = {}; }
    try { Object.assign(app.config, JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}")); } catch { /* ignore */ }
  };
  const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(app.cache)); } catch { /* ignore */ } };

  const staleWindow = () => Math.max(30, Number(app.config.staleDays) || 730) * 86400;

  const statusOf = (r) => {
    if (r.deleted) return "deleted";
    if (r.mutual) return "mutual";
    if (r.live?.live) return "live";
    if (r.live?.streamed) return "streamed";
    if (r.videoTs === 0 && r.dynTs === 0) return "empty";
    if (r.videoTs === null && r.dynTs === null) return "error";
    const win = staleWindow();
    const vStale = r.videoTs === 0 || (r.videoTs && now() - r.videoTs > win);
    const dStale = !r.dynTs || now() - r.dynTs > win;
    if (vStale && dStale) return "zombie";
    if (vStale && !dStale) return "dynonly";
    return "alive";
  };

  const STATUS_TEXT = {
    deleted: "已注销", zombie: "僵尸号", dynonly: "只发动态", empty: "零内容",
    error: "查询失败", alive: "正常", live: "正在直播", streamed: "播过", mutual: "互关",
  };

  // ---------------------------------------------------------------- 扫描
  const scan = async () => {
    if (app.scanning) return;
    app.scanning = true;
    app.aborted = false;
    try {
      app.selfMid = getCookie("DedeUserID");
      if (!app.selfMid) throw new Error("没读到登录态（DedeUserID）。请先登录 B站，且在本页刷新一次。");
      app.throttle.interval = app.config.interval;

      setStatus("正在读取关注列表…");
      const followings = await api.followings(app.selfMid, (got, total) => {
        setStatus(`读取关注列表 ${got}/${total || "?"}`);
        setProgress((total ? got / total : 0) * 0.15);
      });

      const todo = followings.filter((u) => !app.cache[u.mid]?.checked);
      setStatus(`共 ${followings.length} 个关注，本次需要查 ${todo.length} 个`);
      let done = 0, hit = 0;
      for (const u of followings) {
        if (app.aborted) break;
        const mid = String(u.mid);
        const cached = app.cache[mid];
        if (cached?.checked) { done++; continue; }
        const rec = { mid, name: u.uname || "", sign: u.sign || "" };
        // attribute=6 就是互相关注：认识的人，不参与清理
        rec.mutual = Number(u.attribute) === 6;

        if ((u.uname || "").includes("已注销")) {
          rec.deleted = true;
          rec.videoTs = null;
          rec.dynTs = null;
        } else {
          // 投稿（app 通道）和动态（web 通道）并行：两条限速池互不占用，耗时≈较慢的那条
          const [v, d] = await Promise.all([api.lastVideo(mid), api.lastDynamic(mid)]);
          rec.videoTs = v.ok ? v.ts : null;
          if (!v.ok) rec.err = v.err;
          rec.dynTs = d.ok ? d.ts : null;
          if (!d.ok && !rec.err) rec.err = d.err;

          const win = staleWindow();
          const vStale = rec.videoTs === 0 || (rec.videoTs && now() - rec.videoTs > win);
          const dStale = !rec.dynTs || now() - rec.dynTs > win;
          const silent = vStale && dStale;                    // 投稿和动态都停了
          const empty = rec.videoTs === 0 && rec.dynTs === 0; // 零内容（可能已经注销）

          // 只有「可能被清理」的号才值得多花请求：查资料（判注销 + 拿粉丝）和直播。
          // 正常号省掉两次请求 —— 这是 837 个能快一倍的关键。
          if (empty || (silent && app.config.autoFans)) {
            const c = await api.card(mid);
            if (c.deleted) { rec.deleted = true; }
            else if (c.ok) { rec.name = c.name || rec.name; rec.fans = c.fans; }
          }
          // 视频和动态都停了，才去查直播（主播账号不能误删）
          if (silent && !rec.deleted) rec.live = await api.liveInfo(mid);
        }
        rec.checked = true;
        rec.at = now();
        app.cache[mid] = rec;
        done++;
        hit++;
        if (hit % 5 === 0) saveCache();
        const pct = 15 + (done / Math.max(1, followings.length)) * 85;
        setProgress(pct);
        setStatus(`扫描中 ${done}/${followings.length} · 已测 ${hit} 个`);
        if (hit % 10 === 0) renderRows(); // 边扫边出结果
      }
      saveCache();
      setStatus(app.aborted ? "已暂停（进度已保存）" : "扫描完成");
    } catch (e) {
      setStatus("出错：" + (e.message || e), true);
    } finally {
      app.scanning = false;
      renderRows();
      renderStats();
    }
  };

  // ---------------------------------------------------------------- 渲染
  const collectRows = () => {
    const rows = [];
    for (const [mid, rec] of Object.entries(app.cache)) {
      if (!rec.checked) continue;
      const st = statusOf(rec);
      rows.push({
        mid, name: rec.name || mid, fans: rec.fans,
        videoTs: rec.videoTs, dynTs: rec.dynTs, status: st, err: rec.err,
        videoDays: days(rec.videoTs), dynDays: days(rec.dynTs),
        live: rec.live || null,
      });
    }
    const rank = { deleted: 0, zombie: 1, empty: 2, mutual: 3, live: 4, streamed: 5, dynonly: 6, error: 7, alive: 8 };
    rows.sort((a, b) => (rank[a.status] - rank[b.status]) || ((b.videoDays || 0) - (a.videoDays || 0)));
    return rows;
  };

  const setStatus = (text, isErr) => {
    if (!app.ui.status) return;
    app.ui.status.textContent = text;
    app.ui.status.style.color = isErr ? "#e5646e" : "#8b98a9";
  };
  const setProgress = (pct) => {
    if (app.ui.bar) app.ui.bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  };

  // 固定顺序 + 固定颜色：跟上面状态标签的颜色保持一致，图例才对得上
  const CHART_ORDER = [
    ["deleted", "已注销", "#e5646e"],
    ["zombie", "僵尸号", "#f0a35e"],
    ["empty", "零内容", "#8b98a9"],
    ["dynonly", "只发动态", "#7aa2f7"],
    ["streamed", "播过的主播", "#9d7cd8"],
    ["live", "直播中", "#b98cff"],
    ["mutual", "互关", "#4dc9c0"],
    ["alive", "正常", "#5ec97a"],
    ["error", "查询失败", "#8b98a9"],
  ];
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    return n;
  };

  // 停更时长分桶（只统计僵尸号/零内容这些「有候选意义」的）
  const STALE_BUCKETS = [
    ["2–3 年", 730, 1095],
    ["3–5 年", 1095, 1825],
    ["5–8 年", 1825, 2920],
    ["8 年以上", 2920, Infinity],
  ];

  const renderCharts = (rows) => {
    const box = app.ui.charts;
    if (!box) return;
    const total = rows.length;
    if (!total) { box.replaceChildren(); return; }

    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const parts = CHART_ORDER.filter(([k]) => counts[k]).map(([k, label, color]) => ({ k, label, color, n: counts[k] }));

    // ── 环形图（stroke-dasharray 拼圆环）
    const R = 42, CIRC = 2 * Math.PI * R;
    const svg = svgEl("svg", { viewBox: "0 0 100 100", class: "bfd-donut" });
    let acc = 0;
    for (const p of parts) {
      const len = (p.n / total) * CIRC;
      const c = svgEl("circle", {
        cx: 50, cy: 50, r: R, fill: "none", stroke: p.color, "stroke-width": 13,
        "stroke-dasharray": `${Math.max(0, len - 0.7)} ${CIRC}`,
        "stroke-dashoffset": -acc,
        transform: "rotate(-90 50 50)",
      });
      svg.append(c);
      acc += len;
    }
    const t1 = svgEl("text", { x: 50, y: 48, "text-anchor": "middle", class: "bfd-donut-n" });
    t1.textContent = String(total);
    const t2 = svgEl("text", { x: 50, y: 61, "text-anchor": "middle", class: "bfd-donut-l" });
    t2.textContent = "个关注";
    svg.append(t1, t2);

    const legend = el("div", { class: "bfd-legend" },
      ...parts.map((p) => el("div", { class: "bfd-lg" },
        el("i", { style: `background:${p.color}` }),
        el("span", { class: "bfd-lg-t" }, p.label),
        el("b", {}, `${p.n} · ${((p.n / total) * 100).toFixed(p.n / total < 0.1 ? 1 : 0)}%`))));

    // ── 停更时长分布
    const stale = rows.filter((r) => r.status === "zombie" || r.status === "empty");
    const ageDays = (r) => {
      const t = Math.max(r.videoTs || 0, r.dynTs || 0);
      return t ? (now() - t) / 86400 : null;
    };
    const bars = STALE_BUCKETS.map(([label, min, max]) => ({
      label,
      n: stale.filter((r) => { const d = ageDays(r); return d !== null && d >= min && d < max; }).length,
    }));
    const noTime = stale.length - bars.reduce((s, b) => s + b.n, 0);
    const maxN = Math.max(1, ...bars.map((b) => b.n));

    const barBox = el("div", { class: "bfd-bars" },
      ...bars.map((b) => el("div", { class: "bfd-bar-row" },
        el("span", { class: "bfd-bar-l" }, b.label),
        el("div", { class: "bfd-bar-track" },
          el("div", { class: "bfd-bar-fill", style: `width:${(b.n / maxN) * 100}%` })),
        el("b", { class: "bfd-bar-n" }, String(b.n)))),
      noTime > 0 ? el("div", { class: "bfd-note" }, `另 ${noTime} 个没有可用的时间（已注销 / 零内容）`) : null);

    box.replaceChildren(
      el("div", { class: "bfd-card" },
        el("div", { class: "bfd-card-h" }, "状态分布"),
        el("div", { class: "bfd-donut-wrap" }, svg, legend)),
      el("div", { class: "bfd-card" },
        el("div", { class: "bfd-card-h" }, `停更多久（候选 ${stale.length} 个）`),
        barBox),
    );
  };

  const renderStats = () => {
    const rows = collectRows();
    const c = {};
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    if (app.ui.statsLine) {
      app.ui.statsLine.textContent = `共 ${rows.length} 个 · 已注销 ${c.deleted || 0} · 僵尸 ${c.zombie || 0} · ` +
        `主播 ${(c.live || 0) + (c.streamed || 0)} · 互关 ${c.mutual || 0} · 只发动态 ${c.dynonly || 0} · 零内容 ${c.empty || 0} · ` +
        `正常 ${c.alive || 0}`;
    }
    for (const b of app.ui.filters || []) {
      const k = b.dataset.filter;
      const n = k === "all" ? rows.length
        : k === "live" ? ((c.live || 0) + (c.streamed || 0))
          : (c[k] || 0);
      b.textContent = `${b.dataset.label} ${n}`;
      b.classList.toggle("on", k === app.filter);
    }
    renderCharts(rows);
  };

  const renderRows = () => {
    if (!app.ui.tbody) return;
    const rows = collectRows();
    const list = app.filter === "all" ? rows
      : app.filter === "live" ? rows.filter((r) => r.status === "live" || r.status === "streamed")
        : rows.filter((r) => r.status === app.filter);
    app.ui.tbody.replaceChildren();
    for (const r of list) {
      const tr = el("tr", { "data-mid": r.mid });
      const chk = el("input", { type: "checkbox", class: "bfd-chk" });
      chk.dataset.mid = r.mid;
      tr.append(el("td", {}, chk));
      tr.append(el("td", { class: "bfd-name" }, el("a", {
        href: `https://space.bilibili.com/${r.mid}`, target: "_blank", rel: "noreferrer",
      }, r.name)));
      tr.append(el("td", {}, el("span", { class: `bfd-tag bfd-${r.status}` }, STATUS_TEXT[r.status] || r.status)));
      tr.append(el("td", {}, r.videoTs ? `${fmtDate(r.videoTs)} (${r.videoDays}天)` : (r.videoTs === 0 ? "无投稿" : "-")));
      tr.append(el("td", {}, r.dynTs ? `${fmtDate(r.dynTs)} (${r.dynDays}天)` : (r.dynTs === 0 ? "无动态" : "-")));
      tr.append(el("td", {}, num(r.fans)));
      tr.append(el("td", {}, el("button", {
        class: "bfd-btn bfd-mini", onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = "取关中…";
          const ok = await api.unfollow(r.mid).catch(() => false);
          e.target.textContent = ok ? "已取关" : "失败";
          if (ok) {
            delete app.cache[r.mid];
            saveCache();
            tr.style.opacity = "0.35";
            renderStats();
          } else {
            e.target.disabled = false;
            setTimeout(() => (e.target.textContent = "取关"), 1500);
          }
        },
      }, "取关")));
      app.ui.tbody.append(tr);
    }
    renderStats();
  };

  const exportCsv = () => {
    const rows = collectRows();
    const head = ["状态", "UID", "昵称", "最近投稿", "最近动态", "粉丝", "主页"];
    const lines = [head.join(",")];
    for (const r of rows) {
      lines.push([
        STATUS_TEXT[r.status] || r.status, r.mid,
        `"${String(r.name).replace(/"/g, '""')}"`,
        r.videoTs ? fmtDate(r.videoTs) : "-",
        r.dynTs ? fmtDate(r.dynTs) : "-",
        r.fans ?? "",
        `https://space.bilibili.com/${r.mid}`,
      ].join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `bili-follow-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  };

  const batchUnfollow = async () => {
    const checked = [...document.querySelectorAll(".bfd-chk:checked")];
    const rowsByMid = new Map(collectRows().map((r) => [String(r.mid), r]));
    const skipped = checked.filter((c) => ["live", "streamed", "mutual"].includes(rowsByMid.get(c.dataset.mid)?.status));
    const mids = checked.filter((c) => !skipped.includes(c))
      .map((c) => c.dataset.mid);
    if (skipped.length) {
      alert(`有 ${skipped.length} 个「正在直播 / 播过 / 互关」的账号已自动跳过（主播和你认识的人不删）。\n要删它们请单独点那一行的取关按钮。`);
    }
    if (!mids.length) return;
    const names = mids.map((m) => app.cache[m]?.name || m);
    const preview = names.slice(0, 10).join("、") + (names.length > 10 ? ` 等 ${names.length} 个` : "");
    if (!confirm(`确定取关这 ${mids.length} 个？\n\n${preview}\n\nB站没有批量撤销，取关后要一个个手动加回来。`)) return;
    setStatus(`批量取关 0/${mids.length}`);
    let ok = 0;
    for (const [i, mid] of mids.entries()) {
      const success = await api.unfollow(mid).catch(() => false);
      if (success) { ok++; delete app.cache[mid]; }
      setStatus(`批量取关 ${i + 1}/${mids.length}（成功 ${ok}）`);
      setProgress(((i + 1) / mids.length) * 100);
      await sleep(1500);
    }
    saveCache();
    renderRows();
    setStatus(`批量取关完成：成功 ${ok}/${mids.length}`);
    alert(`完成：成功取关 ${ok} 个，失败 ${mids.length - ok} 个`);
  };

  // ---------------------------------------------------------------- UI
  const CSS = `
  .bfd-fab{position:fixed;right:22px;bottom:26px;z-index:9999;display:flex;align-items:center;gap:6px;
    padding:10px 16px;border-radius:999px;background:#fb7299;color:#fff;font:14px/1 system-ui,sans-serif;
    box-shadow:0 6px 20px rgba(251,114,153,.45);cursor:pointer;border:0;transition:.15s}
  .bfd-fab:hover{transform:translateY(-1px);filter:brightness(1.05)}
  .bfd-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(8,12,18,.55);display:flex;
    align-items:center;justify-content:center;backdrop-filter:blur(2px)}
  .bfd-panel{width:min(1080px,94vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;
    background:#161b22;color:#e6edf6;border:1px solid #273040;border-radius:16px;
    font:13px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .bfd-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #273040}
  .bfd-title{font-size:15px;font-weight:600}
  .bfd-sub{color:#8b98a9;font-size:12px}
  .bfd-x{margin-left:auto;border:0;background:transparent;color:#8b98a9;font-size:18px;cursor:pointer}
  .bfd-x:hover{color:#e5646e}
  .bfd-body{padding:12px 16px;overflow:auto}
  .bfd-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .bfd-btn{border:1px solid #273040;background:#1c2330;color:#e6edf6;border-radius:8px;
    padding:7px 13px;cursor:pointer;font:inherit}
  .bfd-btn:hover{border-color:#4dc9c0;color:#4dc9c0}
  .bfd-btn.primary{background:#fb7299;border-color:#fb7299;color:#fff}
  .bfd-btn.primary:hover{filter:brightness(1.06);color:#fff}
  .bfd-btn.danger{border-color:#5a2a30;color:#e5646e}
  .bfd-btn.danger:hover{background:#e5646e18}
  .bfd-btn:disabled{opacity:.5;cursor:not-allowed}
  .bfd-mini{padding:3px 10px;font-size:12px}
  .bfd-progress{height:6px;background:#1c2330;border-radius:99px;overflow:hidden;margin-bottom:8px}
  .bfd-bar{height:100%;width:0;background:linear-gradient(90deg,#4dc9c0,#7aa2f7);transition:width .2s}
  .bfd-status{color:#8b98a9;font-size:12px;min-height:18px;margin-bottom:8px}
  .bfd-stats{color:#8b98a9;font-size:12px;margin:6px 0 10px}
  .bfd-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
  .bfd-filters button{border:1px solid #273040;background:transparent;color:#8b98a9;border-radius:99px;
    padding:4px 12px;font-size:12px;cursor:pointer}
  .bfd-filters button.on{border-color:#fb7299;color:#fb7299;background:#fb729914}
  table.bfd-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .bfd-table th{position:sticky;top:0;background:#161b22;text-align:left;color:#8b98a9;
    font-weight:500;padding:8px 6px;border-bottom:1px solid #273040;white-space:nowrap}
  .bfd-table td{padding:7px 6px;border-bottom:1px solid #1f2733;vertical-align:middle}
  .bfd-table tr:hover td{background:#1a212c}
  .bfd-name a{color:#e6edf6;text-decoration:none}
  .bfd-name a:hover{color:#4dc9c0;text-decoration:underline}
  .bfd-tag{padding:2px 8px;border-radius:99px;font-size:11px;white-space:nowrap}
  .bfd-deleted{background:#e5646e20;color:#e5646e}
  .bfd-zombie{background:#f0a35e20;color:#f0a35e}
  .bfd-dynonly{background:#7aa2f720;color:#7aa2f7}
  .bfd-empty{background:#8b98a920;color:#8b98a9}
  .bfd-alive{background:#5ec97a20;color:#5ec97a}
  .bfd-live{background:#a259ff22;color:#b98cff}
  .bfd-mutual{background:#4dc9c020;color:#4dc9c0}
  .bfd-streamed{background:#a259ff18;color:#9d7cd8}
  .bfd-error{background:#8b98a920;color:#8b98a9}
  .bfd-foot{padding:10px 16px;border-top:1px solid #273040;display:flex;gap:12px;align-items:center;
    color:#8b98a9;font-size:12px;flex-wrap:wrap}
  .bfd-foot label{display:flex;align-items:center;gap:5px;cursor:pointer}
  .bfd-foot input[type=number]{width:70px;background:#1c2330;border:1px solid #273040;color:#e6edf6;
    border-radius:6px;padding:3px 6px}
  /* 图表：环形 + 条形，纯 SVG/DOM，不引任何外部库 */
  .bfd-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(258px,1fr));gap:10px;margin:4px 0 10px}
  .bfd-card{border:1px solid #273040;border-radius:12px;padding:10px 12px;background:#1a212c}
  .bfd-card-h{font-size:12px;color:#8b98a9;margin-bottom:8px}
  .bfd-donut-wrap{display:flex;gap:14px;align-items:center}
  .bfd-donut{width:112px;height:112px;flex:none}
  .bfd-donut-n{fill:#e6edf6;font-size:15px;font-weight:600}
  .bfd-donut-l{fill:#8b98a9;font-size:7px}
  .bfd-legend{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
  .bfd-lg{display:flex;align-items:center;gap:6px;font-size:11.5px}
  .bfd-lg i{width:8px;height:8px;border-radius:2px;flex:none;display:block}
  .bfd-lg-t{color:#c9d1d9;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bfd-lg b{color:#8b98a9;font-weight:500;flex:none}
  .bfd-bars{display:flex;flex-direction:column;gap:6px}
  .bfd-bar-row{display:flex;align-items:center;gap:8px;font-size:11.5px}
  .bfd-bar-l{width:62px;color:#8b98a9;flex:none}
  .bfd-bar-track{flex:1;height:9px;background:#1c2330;border-radius:99px;overflow:hidden}
  .bfd-bar-fill{height:100%;background:linear-gradient(90deg,#f0a35e,#e5646e);border-radius:99px;transition:width .2s}
  .bfd-bar-n{width:26px;text-align:right;color:#c9d1d9;font-weight:500;flex:none}
  .bfd-note{font-size:11px;color:#8b98a9;margin-top:2px}
  /* 两个功能共用一个面板：顶部页签切换 */
  .bfd-tabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:#1c2330;margin-bottom:10px}
  .bfd-tab{flex:1;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:#8b98a9;
    font:inherit;font-size:13px;cursor:pointer}
  .bfd-tab:hover{color:#e6edf6}
  .bfd-tab.on{background:#161b22;color:#e6edf6;font-weight:600}
  .bfd-folder{display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid #1f2733}
  .bfd-folder:last-child{border-bottom:0}
  .bfd-folder-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bfd-folder-d{color:#e5646e;font-size:12px;flex:none;font-variant-numeric:tabular-nums}
  .bfd-fav-list{max-height:min(52vh,460px);overflow:auto;border:1px solid #273040;border-radius:10px;padding:2px 8px}
  `;

  // ---------------------------------------------------------------- 收藏夹体检
  // 跟关注体检共用凭证 / 限速池 / 面板，只是数据源和动作不一样。
  const FAV_KEY = "bfd.fav.v1";

  const favApi = {
    async folders() {
      const j = await api.web("/x/v3/fav/folder/created/list-all", { up_mid: app.selfMid });
      if (j.code !== 0) throw new Error(`收藏夹列表失败：code ${j.code} ${j.message || ""}`);
      return Array.isArray(j.data) ? j.data : (j.data?.list || []);
    },
    page: (mediaId, pn) => api.web("/x/v3/fav/resource/list",
      { media_id: mediaId, pn, ps: 20, platform: "web" }),
    // 清空某个收藏夹里的失效内容（B站 官方接口）
    clean: (mediaId) => api.post("/x/v3/fav/resource/clean",
      { media_id: mediaId, platform: "web", csrf: getCookie("bili_jct") }),
  };

  const loadFavState = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
      if (Array.isArray(raw.folders)) app.fav.folders = raw.folders;
      app.fav.at = raw.at || 0;
    } catch { /* 坏数据就当没有 */ }
  };
  const saveFavState = () => {
    app.fav.at = now();
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify({ folders: app.fav.folders, at: app.fav.at }));
    } catch { /* 存不下就算了 */ }
  };

  const setFavStatus = (text, isErr) => {
    if (!app.ui.favStatus) return;
    app.ui.favStatus.textContent = text;
    app.ui.favStatus.style.color = isErr ? "#e5646e" : "#8b98a9";
  };

  const scanFav = async () => {
    if (app.fav.scanning) return;
    app.fav.scanning = true;
    app.fav.aborted = false;
    try {
      app.selfMid = getCookie("DedeUserID");
      if (!app.selfMid) throw new Error("没读到登录态（DedeUserID），请先登录 B站 并刷新");
      setFavStatus("正在读取收藏夹列表…");
      const folders = await favApi.folders();
      app.fav.folders = folders.map((f) => ({
        id: f.id, title: f.title, count: f.media_count, dead: 0, scanned: 0, done: false,
      }));
      renderFav();

      for (const f of app.fav.folders) {
        if (app.fav.aborted) break;
        let pn = 1, dead = 0, scanned = 0, more = true;
        while (more && pn <= 400) {
          if (app.fav.aborted) break;
          const j = await favApi.page(f.id, pn);
          if (j.code !== 0) {
            setFavStatus(`「${f.title}」第 ${pn} 页失败：code ${j.code} ${j.message || ""}`, true);
            break;
          }
          for (const m of (j.data?.medias || [])) {
            scanned += 1;
            if (m.title === "已失效视频" || (m.attr & 1) === 1) dead += 1;
          }
          more = Boolean(j.data?.has_more);
          pn += 1;
          f.dead = dead;
          f.scanned = scanned;
          renderFav();
          setFavStatus(`扫描中：${f.title} ${scanned}/${f.count || "?"}`);
          // 每页间隔比关注体检长一点：收藏夹接口翻上百页就会 412
          if (pn % 60 === 0) await sleep(25000);
          else await sleep(Math.max(400, app.config.interval / 2));
        }
        f.done = true;
        saveFavState();
        renderFav();
      }
      setFavStatus(app.fav.aborted ? "已暂停（进度已保存）" : "扫描完成");
    } catch (e) {
      setFavStatus("出错：" + (e.message || e), true);
    } finally {
      app.fav.scanning = false;
      renderFav();
    }
  };

  const cleanFav = async (f) => {
    if (!f.dead) return;
    if (!confirm(`清空「${f.title}」里的 ${f.dead} 个失效视频？\n\nB站 没有批量恢复，删了要一个个手动加回来。`)) return;
    setFavStatus(`正在清理「${f.title}」…`);
    const j = await favApi.clean(f.id).catch((e) => ({ code: -1, message: String(e.message || e) }));
    if (j.code === 0) {
      f.dead = 0;
      saveFavState();
      renderFav();
      setFavStatus(`✅ 「${f.title}」已清理`);
    } else {
      setFavStatus(`❌ 「${f.title}」清理失败：code ${j.code} ${j.message || ""}`, true);
    }
  };

  const renderFav = () => {
    if (!app.ui.favList) return;
    const list = app.fav.folders || [];
    app.ui.favList.replaceChildren();
    if (!list.length) {
      app.ui.favList.append(el("div", { class: "bfd-note", style: "padding:14px 6px" },
        "还没扫描过。点上面的「扫描收藏夹」。"));
      if (app.ui.favSummary) app.ui.favSummary.textContent = "";
      return;
    }
    const totalDead = list.reduce((s, f) => s + f.dead, 0);
    const totalScanned = list.reduce((s, f) => s + (f.scanned || 0), 0);
    if (app.ui.favSummary) {
      app.ui.favSummary.textContent = `${list.length} 个收藏夹 · 已扫 ${totalScanned} 个视频 · `
        + (totalDead ? `${totalDead} 个失效` : "没有失效的");
    }
    for (const f of list) {
      const btn = el("button", {
        class: "bfd-btn bfd-mini danger",
        disabled: f.dead ? null : "1",
        onclick: () => cleanFav(f),
      }, f.dead ? `清理 ${f.dead}` : "干净");
      app.ui.favList.append(el("div", { class: "bfd-folder" },
        el("span", { class: "bfd-folder-n", title: f.title }, f.title),
        el("span", { class: "bfd-folder-d" }, `${f.dead} / ${f.scanned || f.count}`),
        btn));
    }
  };

  const openPanel = () => {
    if (app.ui.mask) { app.ui.mask.style.display = "flex"; return; }

    const filters = [
      ["zombie", "僵尸号"], ["live", "主播"], ["mutual", "互关"], ["deleted", "已注销"],
      ["empty", "零内容"], ["dynonly", "只发动态"], ["alive", "正常"], ["all", "全部"],
    ].map(([k, label]) => {
      const b = el("button", { "data-filter": k, "data-label": label, onclick: () => {
        app.filter = k;
        renderRows();
        renderStats();
      } }, label);
      return b;
    });

    const tbody = el("tbody");
    const status = el("div", { class: "bfd-status" }, "准备就绪");
    const bar = el("div", { class: "bfd-bar" });
    const statsLine = el("div", { class: "bfd-stats" });
    const charts = el("div", { class: "bfd-charts" });

    // ── 关注体检这一页（原来的内容原封不动搬进来）
    const followPane = el("div", {},
      el("div", { class: "bfd-progress" }, bar),
      status,
      el("div", { class: "bfd-actions" },
        el("button", { class: "bfd-btn primary", onclick: scan }, "开始 / 继续扫描"),
        el("button", { class: "bfd-btn", onclick: () => { app.aborted = true; setStatus("正在停止…"); } }, "暂停"),
        el("button", { class: "bfd-btn", onclick: exportCsv }, "导出 CSV"),
        el("button", { class: "bfd-btn danger", onclick: batchUnfollow }, "取关勾选"),
        el("button", { class: "bfd-btn", onclick: () => {
          if (!confirm("清空本地缓存？已扫的结果要重新扫一遍。")) return;
          app.cache = {}; saveCache(); renderRows(); renderStats(); setStatus("缓存已清空");
        } }, "清缓存")),
      el("div", { class: "bfd-filters" }, ...filters),
      charts,
      statsLine,
      el("table", { class: "bfd-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, ""), el("th", {}, "昵称"), el("th", {}, "状态"),
          el("th", {}, "最近投稿"), el("th", {}, "最近动态"), el("th", {}, "粉丝"), el("th", {}, ""))),
        tbody));

    // ── 收藏夹体检这一页
    const favStatus = el("div", { class: "bfd-status" }, "准备就绪");
    const favSummary = el("div", { class: "bfd-stats" });
    const favList = el("div", { class: "bfd-fav-list" });
    const favPane = el("div", { style: "display:none" },
      el("div", { class: "bfd-actions" },
        el("button", { class: "bfd-btn primary", onclick: scanFav }, "扫描收藏夹"),
        el("button", { class: "bfd-btn", onclick: () => {
          app.fav.aborted = true;
          setFavStatus("正在停止…");
        } }, "暂停"),
        el("button", { class: "bfd-btn", onclick: () => {
          if (!confirm("清空收藏夹扫描结果？")) return;
          app.fav.folders = [];
          saveFavState();
          renderFav();
        } }, "清结果")),
      favStatus,
      favSummary,
      favList,
      el("div", { class: "bfd-note", style: "margin-top:8px" },
        "只有「已失效视频」会被算进来。清理用的是 B站 官方的「清空失效内容」接口，一次清一个收藏夹。"));

    // ── 页签
    const tabBtns = ["follow", "fav"].map((k) => el("button", {
      class: "bfd-tab" + (k === app.tab ? " on" : ""),
      "data-tab": k,
      onclick: () => switchTab(k),
    }, k === "follow" ? "关注体检" : "收藏夹体检"));

    // 用函数声明而不是 const 箭头函数：会被提升，不依赖它在文件里的位置
    function switchTab(k) {
      app.tab = k;
      followPane.style.display = k === "follow" ? "" : "none";
      favPane.style.display = k === "fav" ? "" : "none";
      for (const b of tabBtns) b.classList.toggle("on", b.dataset.tab === k);
    }

    const panel = el("div", { class: "bfd-panel" },
      el("div", { class: "bfd-head" },
        el("div", {},
          el("div", { class: "bfd-title" }, "🐟 B站体检"),
          el("div", { class: "bfd-sub" }, `v${VERSION} · 纯本地运行，不经过任何服务器 · 请求间隔 ${app.config.interval}ms`)),
        el("button", { class: "bfd-x", onclick: () => (app.ui.mask.style.display = "none") }, "✕")),
      el("div", { class: "bfd-body" },
        el("div", { class: "bfd-tabs" }, ...tabBtns),
        followPane,
        favPane),
      el("div", { class: "bfd-foot" },
        el("label", {}, "多久算僵尸 ",
          el("input", { type: "number", min: "30", step: "30", value: String(app.config.staleDays),
            onchange: (e) => {
              app.config.staleDays = Math.max(30, Number(e.target.value) || 730);
              localStorage.setItem(CONFIG_KEY, JSON.stringify(app.config));
              renderRows(); renderStats();
            } }, "天")),
        el("label", {}, "请求间隔 ",
          el("input", { type: "number", min: "400", step: "100", value: String(app.config.interval),
            onchange: (e) => {
              app.config.interval = Math.max(400, Number(e.target.value) || 1200);
              app.throttleWeb.interval = app.config.interval;
              app.throttle.interval = app.config.interval;
              localStorage.setItem(CONFIG_KEY, JSON.stringify(app.config));
            } }, "ms")),
        el("label", {}, el("input", { type: "checkbox", checked: app.config.autoFans ? "" : null,
          onchange: (e) => {
            app.config.autoFans = e.target.checked;
            localStorage.setItem(CONFIG_KEY, JSON.stringify(app.config));
          } }), "顺便取粉丝数（多一次请求）"),
        el("span", { style: "margin-left:auto" }, "数据只存在这个浏览器里")));

    const mask = el("div", { class: "bfd-mask", onclick: (e) => {
      if (e.target === mask) mask.style.display = "none";
    } }, panel);

    document.body.append(mask);
    app.ui = { mask, panel, tbody, status, bar, statsLine, filters, charts, favStatus, favSummary, favList };

    app.throttle.onCooldown = (sec) => setStatus(`被 B站 限流，冷却 ${sec} 秒…`, true);
    renderRows();
    renderStats();
    renderFav();
    if (app.tab === "fav") switchTab("fav");
  };

  const mount = () => {
    loadState();
    loadFavState();
    app.throttleWeb.interval = app.config.interval;
    app.throttle.interval = app.config.interval;
    const fab = el("button", { class: "bfd-fab", title: "关注体检 + 收藏夹体检", onclick: openPanel }, "🐟 B站体检");
    document.body.append(fab);
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    // 排查用：装完在控制台应该能看到这一行。看不到就是没注入（页面不在 @match 范围里）
    console.log(`[关注体检] v${VERSION} 已注入 ${location.hostname}${location.pathname}`);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
