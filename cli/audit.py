#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站 关注列表体检（只读，绝不取关）

  关注列表  →  web 接口（分页 18 次，自带昵称）
  最近投稿  →  app 通道 x/v2/space/archive（每个 UP 1 次，限速宽松）
  注销判定  →  零投稿的才补查 x/web-interface/card（-404 = 注销/不存在）

进度写 out/progress.jsonl，中断后重跑会自动跳过已完成的 UP。
用法：
  python audit.py --probe 3
  python audit.py                 # 全量，可反复重跑续传
  python audit.py --report-only   # 只按已有进度出报表
"""
import argparse, csv, gzip, hashlib, json, os, random, sys, time
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

HOME = os.path.expanduser(r"~\.dsh\bili-duty")
CRED = os.path.join(HOME, "bili_credential.json")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
PROGRESS = os.path.join(OUT_DIR, "progress.jsonl")

UA_WEB = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
UA_APP = "Mozilla/5.0 BiliDroid/7.70.0 (bbcallen@gmail.com) os/android"
APPKEY = "1d8b6e7d45233436"
APPSEC = "560c52ccd288fed045859ed18bffd973"
CST = timezone(timedelta(hours=8))
TWO_YEARS = 2 * 365 * 86400


# ---------------------------------------------------------------- 基础设施
def load_cookies():
    with open(CRED, "r", encoding="utf-8") as f:
        c = json.load(f)
    return {
        "SESSDATA": c["sessdata"],
        "bili_jct": c["bili_jct"],
        "buvid3": c["buvid3"],
        "DedeUserID": str(c.get("dedeuserid") or c.get("DedeUserID") or ""),
    }


def http_json(url, headers, timeout=20):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", "replace"))


class Web:
    def __init__(self, cookies):
        self.cookie = "; ".join(f"{k}={v}" for k, v in cookies.items() if v)
        self.uid = cookies.get("DedeUserID") or ""
        if not self.uid:
            raise SystemExit("凭证里没有 DedeUserID：无法确定当前登录账号。"
                             "请确认 bili_credential.json 里带 dedeuserid 字段。")

    def call(self, path, params, tries=5, base_sleep=4):
        url = "https://api.bilibili.com" + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        hdrs = {"User-Agent": UA_WEB, "Referer": "https://space.bilibili.com/",
                "Accept": "application/json, text/plain, */*", "Cookie": self.cookie}
        for i in range(tries):
            try:
                j = http_json(url, hdrs)
                code = j.get("code", 0)
                if code in (-412, -352, -799, -509) and i < tries - 1:
                    time.sleep(base_sleep * (i + 1) + random.random() * 2)
                    continue
                return code, j.get("data"), j.get("message", "")
            except urllib.error.HTTPError as e:
                if e.code in (412, 403) and i < tries - 1:
                    time.sleep(base_sleep * (i + 1) + random.random() * 2)
                    continue
                return None, None, f"HTTP {e.code}"
            except Exception as e:  # noqa: BLE001
                if i == tries - 1:
                    return None, None, f"EXC {e}"
                time.sleep(2 + 2 * i)
        return -412, None, "blocked"


class App:
    """appkey 签名的 app 通道：独立限速池，不需要 cookie。"""

    def __init__(self):
        self.hdrs = {"User-Agent": UA_APP}

    def call(self, path, params, tries=4):
        p = dict(params)
        p["appkey"] = APPKEY
        p["ts"] = int(time.time())
        q = urllib.parse.urlencode(sorted(p.items()))
        p["sign"] = hashlib.md5((q + APPSEC).encode()).hexdigest()
        url = "https://app.bilibili.com" + path + "?" + urllib.parse.urlencode(p)
        for i in range(tries):
            try:
                j = http_json(url, self.hdrs)
                code = j.get("code", 0)
                if code == -412 and i < tries - 1:
                    time.sleep(20 * (i + 1))
                    continue
                return code, j.get("data"), j.get("message", "")
            except urllib.error.HTTPError as e:
                if e.code in (412, 429) and i < tries - 1:
                    time.sleep(15 * (i + 1))
                    continue
                return None, None, f"HTTP {e.code}"
            except Exception as e:  # noqa: BLE001
                if i == tries - 1:
                    return None, None, f"EXC {e}"
                time.sleep(2 + 3 * i)
        return -412, None, "blocked"

    def last_video(self, mid):
        """返回 (created_ts|0|None, err)。0=有主页但零投稿，None=查询失败。"""
        code, data, msg = self.call("/x/v2/space/archive",
                                    {"vmid": mid, "pn": 1, "ps": 1, "order": "pubdate",
                                     "mobi_app": "android", "platform": "android", "build": 7700000})
        if code == 0:
            items = (data or {}).get("item") or []
            if items:
                return items[0].get("ctime") or 0, ""
            return 0, ""
        return None, f"app code={code} {msg}"


def fetch_followings(web, cap=5000):
    out, pn = [], 1
    while True:
        code, data, msg = web.call("/x/relation/followings",
                                   {"vmid": web.uid, "pn": pn, "ps": 50,
                                    "order": "desc", "order_type": "attention"})
        if code != 0 or not data:
            sys.stderr.write(f"[!] followings pn={pn} code={code} {msg}\n")
            break
        lst = data.get("list") or []
        total = data.get("total", 0)
        out.extend(lst)
        sys.stderr.write(f"[.] 关注 pn={pn} +{len(lst)} => {len(out)}/{total}\n")
        if len(lst) < 50 or len(out) >= total or len(out) >= cap:
            break
        pn += 1
        time.sleep(1.0 + random.random() * 0.8)
    return out


# ---------------------------------------------------------------- 主流程
def load_progress():
    done = {}
    if os.path.exists(PROGRESS):
        with open(PROGRESS, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    done[int(r["mid"])] = r
                except Exception:  # noqa: BLE001
                    continue
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=int, default=0)
    ap.add_argument("--days", type=int, default=730,
                    help="多少天没更新算「僵尸」（默认 730 = 两年，传 365 = 一年）")
    ap.add_argument("--sleep", type=float, default=0.35, help="每个 UP 的间隔基数(秒)")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    cookies = load_cookies()
    web, appc = Web(cookies), App()
    done = load_progress()

    if not args.report_only:
        fw = fetch_followings(web)
        if args.probe:
            fw = fw[:args.probe]
        todo = [u for u in fw if int(u["mid"]) not in done]
        sys.stderr.write(f"[.] 关注 {len(fw)} 个，已完成 {len(fw)-len(todo)}，本轮待查 {len(todo)}\n")

        t0, ok, fail = time.time(), 0, 0
        with open(PROGRESS, "a", encoding="utf-8") as pf:
            for i, u in enumerate(todo, 1):
                mid = int(u["mid"])
                ts, err = appc.last_video(mid)
                rec = {"mid": mid, "name": u.get("uname") or "",
                       "sign": (u.get("sign") or "")[:40],
                       "follow_ts": u.get("mtime"),
                       "last_ts": ts, "err": err}
                pf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                pf.flush()
                done[mid] = rec
                ok += ts is not None
                fail += ts is None
                if i % 25 == 0 or i == len(todo):
                    rate = i / max(1e-9, time.time() - t0)
                    eta = (len(todo) - i) / max(1e-9, rate)
                    sys.stderr.write(f"[.] {i}/{len(todo)} ok={ok} fail={fail} "
                                     f"{rate:.1f}/s ETA {eta/60:.1f}min\n")
                time.sleep(args.sleep + random.random() * 0.25)

    # ---------------- 报表 ----------------
    rows = list(done.values())
    if not rows:
        print(json.dumps({"ok": False, "msg": "没有进度数据"}, ensure_ascii=False))
        return

    # 先粗判，再给需要人眼判断的行补粉丝数/注销确认
    now = time.time()

    def coarse(r):
        ts = r.get("last_ts")
        if r.get("deleted") or "已注销" in (r.get("name") or ""):
            return "已注销/不可访问"
        if ts is None:
            return "查询失败"
        if ts == 0:
            return "零投稿"
        if now - ts > max(30, args.days) * 86400:
            return "2年未更新"
        return "正常"

    for r in rows:
        r["status"] = coarse(r)

    need_card = [r for r in rows
                 if r["status"] in ("已注销/不可访问", "2年未更新", "零投稿")
                 and not r.get("card_checked")]
    if need_card:
        sys.stderr.write(f"[.] 给 {len(need_card)} 个待清理账号补查粉丝数/注销状态\n")
        for i, r in enumerate(need_card, 1):
            code, data, msg = web.call("/x/web-interface/card", {"mid": r["mid"]},
                                       tries=3, base_sleep=3)
            r["card_checked"] = True
            if code == 0 and data:
                card = data.get("card") or {}
                r["fans"] = data.get("follower") if data.get("follower") is not None else card.get("fans")
                if card.get("name"):
                    r["name"] = card["name"]
                r["deleted"] = False
            elif code == -404:
                r["deleted"] = True
            else:
                r["err"] = ((r.get("err") or "") + f" card={code} {msg}").strip()
            if i % 20 == 0 or i == len(need_card):
                sys.stderr.write(f"[.] enriched {i}/{len(need_card)}\n")
            time.sleep(0.6 + random.random() * 0.4)
        with open(PROGRESS, "w", encoding="utf-8") as pf:
            for r in rows:
                pf.write(json.dumps(r, ensure_ascii=False) + "\n")

    for r in rows:
        ts = r.get("last_ts")
        r["status"] = coarse(r)
        r["last_video"] = datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d") if ts else ""
        r["days"] = int((now - ts) / 86400) if ts else ""

    order = {"已注销/不可访问": 0, "2年未更新": 1, "零投稿": 2, "查询失败": 3, "正常": 4}
    rows.sort(key=lambda r: (order[r["status"]], -(r["days"] or 0)))

    stamp = datetime.now(CST).strftime("%Y%m%d-%H%M")
    csv_path = os.path.join(OUT_DIR, f"follow_audit_{stamp}.csv")
    md_path = os.path.join(OUT_DIR, f"follow_audit_{stamp}.md")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["状态", "UID", "昵称", "最近投稿", "停更天数", "粉丝数", "关注时间", "主页", "备注"])
        for r in rows:
            ft = r.get("follow_ts")
            w.writerow([r["status"], r["mid"], r.get("name", ""), r["last_video"], r["days"],
                        r.get("fans") if r.get("fans") is not None else "",
                        datetime.fromtimestamp(ft, CST).strftime("%Y-%m-%d") if ft else "",
                        f"https://space.bilibili.com/{r['mid']}", r.get("err", "")])

    cnt = {}
    for r in rows:
        cnt[r["status"]] = cnt.get(r["status"], 0) + 1
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# B站关注体检 {datetime.now(CST):%Y-%m-%d %H:%M}\n\n")
        f.write(f"共 {len(rows)} 个关注：" + "，".join(f"{k} {v}" for k, v in cnt.items()) + "\n\n")
        for st in ["已注销/不可访问", "2年未更新", "零投稿", "查询失败"]:
            sub = [r for r in rows if r["status"] == st]
            f.write(f"## {st}（{len(sub)}）\n\n")
            if not sub:
                f.write("无\n\n")
                continue
            f.write("| # | UID | 昵称 | 最近投稿 | 停更 | 粉丝 | 主页 |\n|---|---|---|---|---|---|---|\n")
            for i, r in enumerate(sub, 1):
                f.write(f"| {i} | {r['mid']} | {r.get('name','')} | {r['last_video'] or '-'} | "
                        f"{r['days'] or '-'} | {r.get('fans') if r.get('fans') is not None else '-'} | "
                        f"https://space.bilibili.com/{r['mid']} |\n")
            f.write("\n")

    print(json.dumps({"ok": True, "total": len(rows), "counts": cnt,
                      "csv": csv_path, "md": md_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
