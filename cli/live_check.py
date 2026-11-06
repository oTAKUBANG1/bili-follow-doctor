#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第三轮：给"僵尸号"补查直播，避免把还在开播的 UP 当成死号取关。

判定：
  - 正在直播（live_status=1）        → 保留
  - 最近开播在 N 天内（live_time）   → 保留
  - 从没开过播（live_time=0000）     → 照旧算僵尸
  - 没有直播间（roomid=0）           → 照旧算僵尸

接口（只读）：
  getRoomInfoOld?mid=  → roomid / liveStatus
  room/v1/Room/get_info?room_id= → live_status / live_time

用法：
  python live_check.py --report out/follow_final_xxx.csv --days 730
  python live_check.py --report ... --dry-run   # 只看结果不写文件
"""
import argparse
import csv
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit import load_cookies  # noqa: E402

CST = timezone(timedelta(hours=8))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://live.bilibili.com/",
}

TARGETS = ("2年无任何更新", "零投稿且无动静", "零投稿", "2年未更新")


def cookie_header():
    try:
        c = load_cookies()
    except Exception:  # noqa: BLE001
        return ""
    return "; ".join(f"{k}={v}" for k, v in c.items() if v)


def http_json(url, cookie, tries=3):
    hdrs = dict(UA)
    if cookie:
        hdrs["Cookie"] = cookie
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code in (412, 429) and i < tries - 1:
                time.sleep(8 * (i + 1))
                continue
            return {"code": e.code, "message": f"HTTP {e.code}"}
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                return {"code": None, "message": str(e)}
            time.sleep(2 * (i + 1))
    return {"code": -412, "message": "blocked"}


def room_of(mid, cookie):
    """返回 (roomid, live_status_now, err)"""
    j = http_json("https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=%d" % mid, cookie)
    if j.get("code") != 0:
        return None, None, f"roomOld code={j.get('code')} {j.get('message', '')}"
    d = j.get("data") or {}
    return d.get("roomid") or 0, d.get("liveStatus"), ""


def room_live(roomid, cookie):
    """返回 (live_status, live_time_str, title, area_name, err)"""
    j = http_json("https://api.live.bilibili.com/room/v1/Room/get_info?room_id=%d" % roomid, cookie)
    if j.get("code") != 0:
        return None, "", "", "", f"get_info code={j.get('code')} {j.get('message', '')}"
    d = j.get("data") or {}
    return (d.get("live_status"), d.get("live_time") or "",
            d.get("title") or "", d.get("area_name") or "", "")


def is_empty_room(title, area, mid):
    """默认标题「用户<uid>的直播间」且没有分区 = 从没真正开过播"""
    t = (title or "").strip()
    default_titles = {f"用户{mid}的直播间", f"用户{mid}的直播間", ""}
    if t in default_titles:
        return True
    return t.startswith("用户") and t.endswith("的直播间") and not (area or "").strip()


def parse_live_time(s):
    if not s or s.startswith("0000"):
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST).timestamp()
    except ValueError:
        return None


def load_cache(path):
    out = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            try:
                r = json.loads(line)
                out[str(r["mid"])] = r
            except Exception:  # noqa: BLE001
                continue
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--days", type=int, default=730, help="多少天内有开播就保留（默认 730）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.6)
    args = ap.parse_args()

    if not os.path.exists(args.report):
        raise SystemExit("报表不存在：" + args.report)
    cache_path = os.path.join(OUT_DIR, "live_cache_v2.jsonl")
    cache = load_cache(cache_path)
    cookie = cookie_header()
    now = time.time()
    win = max(1, args.days) * 86400

    rows = list(csv.DictReader(open(args.report, encoding="utf-8-sig")))
    fields = list(rows[0].keys())
    for col in ("直播状态", "最近开播"):
        if col not in fields:
            fields.append(col)

    targets = [r for r in rows if (r.get("状态") or "") in TARGETS]
    print(f"需补查直播 {len(targets)} 个（已有缓存 {sum(1 for r in targets if r['UID'] in cache)}）")

    changed = 0
    for i, r in enumerate(targets, 1):
        mid = str(r["UID"])
        if mid not in cache:
            roomid, live_now, err = room_of(int(mid), cookie)
            live_status, live_time, title, area, err2 = (None, "", "", "", "")
            if roomid:
                live_status, live_time, title, area, err2 = room_live(roomid, cookie)
            rec = {
                "mid": int(mid), "roomid": roomid, "live_now": live_now,
                "live_status": live_status, "live_time": live_time,
                "title": title, "area": area,
                "err": err or err2, "at": int(now),
            }
            cache[mid] = rec
            with open(cache_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            time.sleep(args.sleep + random.random() * 0.4)

        rec = cache[mid]
        ts = parse_live_time(rec.get("live_time"))
        if rec.get("live_now") == 1 or rec.get("live_status") == 1:
            r["直播状态"], r["最近开播"] = "正在直播", rec.get("live_time") or ""
        elif rec.get("roomid") and not is_empty_room(rec.get("title"), rec.get("area"), mid):
            # 有自定义标题/分区 = 真的播过。B站 不开放上次开播时间，保守保留
            r["直播状态"], r["最近开播"] = "播过", rec.get("title") or "-"
        elif rec.get("roomid"):
            r["直播状态"], r["最近开播"] = "空壳直播间", "-"
        else:
            r["直播状态"], r["最近开播"] = "无直播间", "-"

        if r["直播状态"] == "正在直播":
            r["状态"] = "只在直播（保留）"
            changed += 1
        elif r["直播状态"] == "播过":
            r["状态"] = "有直播间（待确认）"

        if i % 20 == 0 or i == len(targets):
            print(f"[{i}/{len(targets)}] 救回 {changed} 个")

    if args.dry_run:
        print("dry-run：不写文件")
        return

    stamp = datetime.now(CST).strftime("%Y%m%d-%H%M")
    csv_path = os.path.join(OUT_DIR, f"follow_live_{stamp}.csv")
    md_path = os.path.join(OUT_DIR, f"follow_live_{stamp}.md")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    counts = {}
    for r in rows:
        counts[r["状态"]] = counts.get(r["状态"], 0) + 1
    order = ["已注销/不可访问", "2年无任何更新", "零投稿且无动静", "只在直播（保留）",
             "有直播间（待确认）", "动态还活着", "只发动态/零投稿", "查询失败", "正常"]
    kept = [r for r in rows if r["状态"] == "只在直播（保留）"]

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# B站关注体检（含直播）{datetime.now(CST):%Y-%m-%d %H:%M}\n\n")
        f.write(f"共 {len(rows)} 个关注：" + "，".join(
            f"{s} {counts.get(s, 0)}" for s in order if counts.get(s)) + "\n\n")
        f.write("判定：投稿和动态都超过阈值天数算「停更」；B站 不开放上次开播时间，"
                "所以**播过的账号一律保守保留**（用直播间有没有自定义标题/分区来区分「播过」和「空壳直播间」）。\n\n")

        f.write(f"## 正在直播（{len(kept)}）\n\n")
        if kept:
            f.write("| # | UID | 昵称 | 最近开播 | 最近投稿 | 粉丝 |\n")
            f.write("|---|---|---|---|---|---|\n")
            for i, r in enumerate(kept, 1):
                f.write(f"| {i} | {r['UID']} | {r['昵称']} | {r['最近开播']} | "
                        f"{r['最近投稿'] or '-'} | {r['粉丝数'] or '-'} |\n")
        else:
            f.write("无\n")

        roomed = [r for r in rows if r["状态"] == "有直播间（待确认）"]
        f.write(f"\n## 有直播间，默认保留（{len(roomed)}）\n\n")
        f.write("开过直播间，可能只是很久没播了。**默认不自动取关**，想强制清理要加 `--include-live`。\n\n")
        if roomed:
            f.write("| # | UID | 昵称 | 最近投稿 | 最近动态 | 粉丝 |\n")
            f.write("|---|---|---|---|---|---|\n")
            for i, r in enumerate(roomed, 1):
                f.write(f"| {i} | {r['UID']} | {r['昵称']} | {r['最近投稿'] or '-'} | "
                        f"{r.get('最近动态') or '-'} | {r['粉丝数'] or '-'} |\n")

        f.write("\n## 确认僵尸（可清理）\n\n")
        zombies = [r for r in rows if r["状态"] == "2年无任何更新"]
        f.write(f"共 {len(zombies)} 个，都没开过直播间：\n\n"
                "| # | UID | 昵称 | 最近投稿 | 最近动态 | 粉丝 |\n")
        f.write("|---|---|---|---|---|---|\n")
        for i, r in enumerate(zombies, 1):
            f.write(f"| {i} | {r['UID']} | {r['昵称']} | {r['最近投稿'] or '-'} | "
                    f"{r.get('最近动态') or '-'} | {r['粉丝数'] or '-'} |\n")

    print(json.dumps({"ok": True, "正在直播": len(kept), "有直播间": len(roomed),
                      "僵尸": len(zombies), "csv": csv_path, "md": md_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
