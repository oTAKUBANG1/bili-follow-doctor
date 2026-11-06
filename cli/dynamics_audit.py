#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第二轮：给「2年未更新 / 零投稿」的 UP 补查动态，剔除只发动态的误判。

依赖第一轮产物 out/progress.jsonl（每个关注的最近投稿时间）。
本脚本只读，不取关。结果写 out/dynamics.jsonl（可续传），再合并出最终报表。

用法：
  python dynamics_audit.py --limit 3     # 小样本
  python dynamics_audit.py               # 全量（144 个左右，5~8 分钟）
  python dynamics_audit.py --report-only # 只按已有动态数据出报表
"""
import argparse, csv, hashlib, json, os, random, sys, time
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit import load_cookies, UA_WEB, CST, TWO_YEARS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
PROGRESS = os.path.join(OUT_DIR, "progress.jsonl")
DYN = os.path.join(OUT_DIR, "dynamics.jsonl")

MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,
         39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,
         63,57,62,11,36,20,34,44,52]


def login_cookie():
    return "; ".join(f"{k}={v}" for k, v in load_cookies().items() if v)


def http_json(url, cookie):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA_WEB, "Cookie": cookie,
        "Referer": "https://space.bilibili.com/", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def mixin_key(cookie):
    j = http_json("https://api.bilibili.com/x/web-interface/nav", cookie)
    d = (j.get("data") or {}).get("wbi_img") or {}
    raw = (d.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
           + d.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0])
    if len(raw) < 64:
        raise RuntimeError("拿不到 wbi key")
    return "".join(raw[i] for i in MIXIN)[:32]


def signed(params, key):
    p = dict(params)
    p["wts"] = int(time.time())
    q = urllib.parse.urlencode(sorted(
        (k, "".join(c for c in str(v) if c not in "!'()*")) for k, v in p.items()))
    p["w_rid"] = hashlib.md5((q + key).encode()).hexdigest()
    return p


class DynClient:
    def __init__(self, cookie):
        self.cookie = cookie
        self.key = mixin_key(cookie)
        self.key_ts = time.time()

    def _refresh(self):
        time.sleep(30 + random.random() * 30)
        self.key = mixin_key(self.cookie)
        self.key_ts = time.time()

    def last_post(self, mid, tries=3):
        """返回 (pub_ts|None, err)。None 表示没有动态或查不到。"""
        for i in range(tries):
            try:
                p = signed({"host_mid": mid, "timezone_offset": -480,
                            "platform": "web",
                            "features": "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote"},
                           self.key)
                url = ("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?"
                       + urllib.parse.urlencode(p))
                j = http_json(url, self.cookie)
                code = j.get("code", 0)
                if code == 0:
                    items = (j.get("data") or {}).get("items") or []
                    if not items:
                        return None, ""
                    return int(items[0]["modules"]["module_author"]["pub_ts"]), ""
                if code in (-412, -352, -799):
                    if i == tries - 1:
                        return None, f"dyn code={code}"
                    self._refresh()
                    continue
                return None, f"dyn code={code} {j.get('message','')}"
            except urllib.error.HTTPError as e:
                if e.code in (412, 403) and i < tries - 1:
                    self._refresh()
                    continue
                return None, f"dyn HTTP {e.code}"
            except Exception as e:  # noqa: BLE001
                if i == tries - 1:
                    return None, f"dyn EXC {e}"
                time.sleep(3 + 2 * i)
        return None, "dyn blocked"


def load_jsonl(path):
    out = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    out[int(r["mid"])] = r
                except Exception:  # noqa: BLE001
                    continue
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--days", type=int, default=730,
                    help="多少天没更新算「僵尸」（默认 730 = 两年，传 365 = 一年）")
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--sleep", type=float, default=1.8)
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    rows = list(load_jsonl(PROGRESS).values())
    if not rows:
        print(json.dumps({"ok": False, "msg": "缺少 progress.jsonl"}, ensure_ascii=False))
        return

    now = time.time()
    win = max(30, args.days) * 86400
    dyn_done = load_jsonl(DYN)

    def video_status(r):
        ts = r.get("last_ts")
        if r.get("deleted") or "已注销" in (r.get("name") or ""):
            return "deleted"
        if ts is None:
            return "error"
        if ts == 0:
            return "novideo"
        if now - ts > win:
            return "stale"
        return "fresh"

    targets = [r for r in rows if video_status(r) in ("stale", "novideo")]
    targets.sort(key=lambda r: r["mid"])

    if not args.report_only:
        todo = [r for r in targets if int(r["mid"]) not in dyn_done]
        if args.limit:
            todo = todo[:args.limit]
        sys.stderr.write(f"[.] 待查动态 {len(todo)} 个（已有 {len(targets)-len(todo)}）\n")
        if todo:
            client = DynClient(login_cookie())
            t0, hit = time.time(), 0
            with open(DYN, "a", encoding="utf-8") as pf:
                for i, r in enumerate(todo, 1):
                    mid = int(r["mid"])
                    ts, err = client.last_post(mid)
                    rec = {"mid": mid, "name": r.get("name"), "dyn_ts": ts, "err": err}
                    pf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    pf.flush()
                    dyn_done[mid] = rec
                    hit += ts is not None
                    if i % 20 == 0 or i == len(todo):
                        rate = i / max(1e-9, time.time() - t0)
                        sys.stderr.write(f"[.] {i}/{len(todo)} 有动态={hit} {rate:.2f}/s "
                                         f"ETA {(len(todo)-i)/max(1e-9,rate)/60:.1f}min\n")
                    time.sleep(args.sleep + random.random() * 0.7)

    # ---------------- 合并出报表 ----------------
    for r in rows:
        d = dyn_done.get(int(r["mid"])) or {}
        dts = d.get("dyn_ts")
        r["dyn_ts"] = dts
        r["dyn_date"] = datetime.fromtimestamp(dts, CST).strftime("%Y-%m-%d") if dts else ""
        r["dyn_days"] = int((now - dts) / 86400) if dts else ""
        vs = video_status(r)
        dyn_fresh = bool(dts and now - dts <= win)
        if vs == "deleted":
            r["status"] = "已注销/不可访问"
        elif vs == "error":
            r["status"] = "查询失败"
        elif vs == "stale":
            r["status"] = "动态还活着" if dyn_fresh else "2年无任何更新"
        elif vs == "novideo":
            r["status"] = "只发动态/零投稿" if dyn_fresh else "零投稿且无动静"
        else:
            r["status"] = "正常"
        r["last_video"] = (datetime.fromtimestamp(r["last_ts"], CST).strftime("%Y-%m-%d")
                           if r.get("last_ts") else "")
        r["video_days"] = int((now - r["last_ts"]) / 86400) if r.get("last_ts") else ""

    order = {"已注销/不可访问": 0, "2年无任何更新": 1, "零投稿且无动静": 2,
             "动态还活着": 3, "只发动态/零投稿": 4, "查询失败": 5, "正常": 6}
    rows.sort(key=lambda r: (order[r["status"]], -(r["video_days"] or 0)))

    stamp = datetime.now(CST).strftime("%Y%m%d-%H%M")
    csv_path = os.path.join(OUT_DIR, f"follow_final_{stamp}.csv")
    md_path = os.path.join(OUT_DIR, f"follow_final_{stamp}.md")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["状态", "UID", "昵称", "最近投稿", "停更天数", "最近动态", "动态天数",
                    "粉丝数", "主页", "备注"])
        for r in rows:
            w.writerow([r["status"], r["mid"], r.get("name", ""), r["last_video"],
                        r["video_days"], r["dyn_date"], r["dyn_days"],
                        r.get("fans") if r.get("fans") is not None else "",
                        f"https://space.bilibili.com/{r['mid']}",
                        (r.get("err") or "")])

    cnt = {}
    for r in rows:
        cnt[r["status"]] = cnt.get(r["status"], 0) + 1

    def table(f, sub):
        if not sub:
            f.write("无\n\n")
            return
        f.write("| # | UID | 昵称 | 最近投稿 | 最近动态 | 粉丝 | 主页 |\n")
        f.write("|---|---|---|---|---|---|---|\n")
        for i, r in enumerate(sub, 1):
            f.write(f"| {i} | {r['mid']} | {r.get('name','')} | {r['last_video'] or '-'} | "
                    f"{r['dyn_date'] or '-'} | {r.get('fans') if r.get('fans') is not None else '-'} | "
                    f"https://space.bilibili.com/{r['mid']} |\n")
        f.write("\n")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# B站关注体检（含动态）{datetime.now(CST):%Y-%m-%d %H:%M}\n\n")
        f.write(f"共 {len(rows)} 个关注：" + "，".join(f"{k} {v}" for k, v in cnt.items()) + "\n\n")
        f.write("判定：投稿与动态都超过 730 天 = 真僵尸；只有动态在更新 = 建议保留。\n\n")
        for st, tip in [("已注销/不可访问", ""),
                        ("2年无任何更新", "**可以直接取关**"),
                        ("零投稿且无动静", "关注后什么都没发过"),
                        ("动态还活着", "只发动态不投视频，别误删"),
                        ("只发动态/零投稿", "同上"),
                        ("查询失败", "接口异常，需人工复核")]:
            sub = [r for r in rows if r["status"] == st]
            f.write(f"## {st}（{len(sub)}）{('  ' + tip) if tip else ''}\n\n")
            table(f, sub)

    print(json.dumps({"ok": True, "total": len(rows), "counts": cnt,
                      "csv": csv_path, "md": md_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
