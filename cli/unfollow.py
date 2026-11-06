#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键取关：按体检报表批量取关。

🔴 安全守则：
  - 默认 **dry-run**，只打印名单，不碰账号
  - 必须加 --yes 才真的取关
  - 一次超过 100 个要再加 --allow-large
  - 每个间隔默认 2 秒，中途 Ctrl+C 可停，已完成的记在日志里，重跑会跳过

用法：
  # 看看会取关谁（不执行）
  python unfollow.py --report out/follow_final_20261106-1206.csv --status 2年无任何更新

  # 只取关停更超过一年的
  python unfollow.py --report report.csv --status 2年无任何更新 --min-days 365 --dry-run

  # 真的执行
  python unfollow.py --report report.csv --status 2年无任何更新 --yes
"""
import argparse
import csv
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
LOG = os.path.join(OUT_DIR, "unfollow.jsonl")

CRED_CANDIDATES = [
    os.path.expanduser(r"~\.dsh\bili-follow\cred.json"),
    os.path.expanduser(r"~\.dsh\bili-duty\bili_credential.json"),
]


def load_cred(path=None):
    for p in ([path] if path else []) + CRED_CANDIDATES:
        if not p or not os.path.exists(p):
            continue
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f)
        c = {
            "sessdata": raw.get("sessdata") or raw.get("SESSDATA") or "",
            "bili_jct": raw.get("bili_jct") or "",
            "buvid3": raw.get("buvid3") or "",
            "dedeuserid": str(raw.get("dedeuserid") or raw.get("DedeUserID") or ""),
        }
        if c["sessdata"] and c["bili_jct"]:
            return c, p
    raise SystemExit(
        "找不到登录凭证。请先登录一次（油猴脚本或 DSH 插件都行），确认这些文件之一存在：\n  "
        + "\n  ".join(CRED_CANDIDATES))


def cookie_header(c):
    return "; ".join(f"{k}={v}" for k, v in {
        "SESSDATA": c["sessdata"], "bili_jct": c["bili_jct"],
        "buvid3": c["buvid3"], "DedeUserID": c["dedeuserid"],
    }.items() if v)


def unfollow_one(mid, c):
    body = urllib.parse.urlencode({
        "fid": mid, "act": 2, "re_src": 11, "csrf": c["bili_jct"],
    }).encode()
    req = urllib.request.Request(
        "https://api.bilibili.com/x/relation/modify", data=body, method="POST",
        headers={
            "User-Agent": UA,
            "Cookie": cookie_header(c),
            "Referer": "https://space.bilibili.com/",
            "Content-Type": "application/x-www-form-urlencoded",
        })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
        return j.get("code") == 0, j.get("code"), j.get("message", "")
    except urllib.error.HTTPError as e:
        if e.code in (412, 429):
            time.sleep(20)
        return False, e.code, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return False, None, str(e)


def done_before():
    """已经成功取关过的 UID（重跑时跳过）"""
    s = set()
    if os.path.exists(LOG):
        with open(LOG, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    if r.get("ok"):
                        s.add(int(r["mid"]))
                except Exception:  # noqa: BLE001
                    continue
    return s


def main():
    ap = argparse.ArgumentParser(description="按报表批量取关（默认 dry-run）")
    ap.add_argument("--report", required=True, help="体检报表 CSV 路径")
    ap.add_argument("--status", default="", help="只处理这个状态，比如 2年无任何更新 / 已注销/不可访问")
    ap.add_argument("--min-days", type=int, default=0, help="只处理停更天数 >= 这个值的")
    ap.add_argument("--max-fans", type=int, default=0, help="只处理粉丝数 <= 这个值的（0=不限，保护大号）")
    ap.add_argument("--limit", type=int, default=0, help="最多处理几个（0=全部）")
    ap.add_argument("--interval", type=float, default=2.0, help="每个之间的间隔秒数")
    ap.add_argument("--cred", default=None, help="凭证 json 路径")
    ap.add_argument("--yes", action="store_true", help="真的执行取关（不加就是 dry-run）")
    ap.add_argument("--allow-large", action="store_true", help="允许一次超过 100 个")
    ap.add_argument("--include-live", action="store_true",
                    help="连「有直播间 / 正在直播」的账号也一起取关（默认跳过，防止误删主播）")
    args = ap.parse_args()

    if not os.path.exists(args.report):
        raise SystemExit(f"报表不存在：{args.report}")

    rows = []
    live_skipped = 0
    with open(args.report, "r", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            try:
                mid = int(r.get("UID") or 0)
            except ValueError:
                continue
            if not mid:
                continue
            if args.status and args.status not in (r.get("状态") or ""):
                continue
            live_col = (r.get("直播状态") or "").strip()
            if not args.include_live and live_col in ("正在直播", "播过"):
                # 开过直播间的账号可能还在播，默认不取关（要强制就加 --include-live）
                live_skipped += 1
                continue
            try:
                days = int(r.get("停更天数") or 0)
            except ValueError:
                days = 0
            if days < args.min_days:
                continue
            if args.max_fans:
                raw_fans = (r.get("粉丝数") or "").strip()
                if not raw_fans.isdigit():
                    # 粉丝数查不到的行不能当成 0 混进"只清小号"的名单里，直接跳过
                    continue
                if int(raw_fans) > args.max_fans:
                    continue
            rows.append({"mid": mid, "name": r.get("昵称") or "", "status": r.get("状态") or "",
                         "days": days, "fans": r.get("粉丝数") or ""})

    done = done_before()
    rows = [r for r in rows if r["mid"] not in done]
    if args.limit:
        rows = rows[:args.limit]

    if not rows:
        print("没有符合条件的账号（或者都已经取关过了）")
        return

    print(f"符合条件 {len(rows)} 个：")
    if live_skipped:
        print(f"（另有 {live_skipped} 个「有直播间/正在直播」的账号已跳过，要一起处理加 --include-live）")
    print(f"{'UID':<14}{'昵称':<24}{'状态':<14}{'停更天数':<10}{'粉丝'}")
    for r in rows[:60]:
        name = r["name"][:22]
        print(f"{r['mid']:<14}{name:<24}{r['status']:<14}{r['days']:<10}{r['fans']}")
    if len(rows) > 60:
        print(f"... 还有 {len(rows) - 60} 个")

    if not args.yes:
        print("\n这是 dry-run，什么都没做。确认名单没问题后，加 --yes 才会真的取关。")
        return

    if len(rows) > 100 and not args.allow_large:
        raise SystemExit(f"\n一次 {len(rows)} 个太多了（上限 100）。确认要用就加 --allow-large。")

    c, cred_path = load_cred(args.cred)
    print(f"\n凭证：{cred_path}")
    print(f"开始取关 {len(rows)} 个，间隔 {args.interval}s，Ctrl+C 可中断（已完成的不重复）\n")

    os.makedirs(OUT_DIR, exist_ok=True)
    ok = fail = 0
    t0 = time.time()
    for i, r in enumerate(rows, 1):
        success, code, msg = unfollow_one(r["mid"], c)
        ok += success
        fail += (not success)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"mid": r["mid"], "name": r["name"], "ok": success,
                                "code": code, "msg": msg,
                                "at": datetime.now(CST).isoformat(timespec="seconds")},
                               ensure_ascii=False) + "\n")
        state = "✓" if success else f"✗({code} {msg})"
        print(f"[{i}/{len(rows)}] {r['mid']} {r['name'][:18]} {state}")
        if i < len(rows):
            time.sleep(args.interval + random.random() * 0.8)

    print(f"\n完成：成功 {ok}，失败 {fail}，用时 {time.time() - t0:.0f}s")
    print(f"日志：{LOG}")


if __name__ == "__main__":
    main()
