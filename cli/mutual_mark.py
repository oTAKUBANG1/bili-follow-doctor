#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
互相关注标记：关注列表接口的 attribute=6 就是互相关注。

互关的人默认不参与清理 —— 那是你认识的人，不是"僵尸号"。

用法：
  python mutual_mark.py --report out/follow_final_xxx.csv
  python mutual_mark.py --report ... --refresh   # 强制重拉关注列表
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit import load_cookies  # noqa: E402

CST = timezone(timedelta(hours=8))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
CACHE = os.path.join(OUT_DIR, "followings.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def fetch_followings():
    c = load_cookies()
    cookie = "; ".join(f"{k}={v}" for k, v in c.items() if v)
    self_uid = c["DedeUserID"]
    out = []
    for pn in range(1, 30):
        url = ("https://api.bilibili.com/x/relation/followings?vmid=%s&pn=%d&ps=50"
               "&order=desc&order_type=attention" % (self_uid, pn))
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Cookie": cookie, "Referer": "https://space.bilibili.com/",
        })
        j = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "replace"))
        if j.get("code") != 0:
            raise SystemExit(f"读取关注列表失败：code {j.get('code')} {j.get('message')}")
        lst = (j.get("data") or {}).get("list") or []
        out += lst
        total = (j.get("data") or {}).get("total") or 0
        if len(lst) < 50 or len(out) >= total:
            break
        time.sleep(1.2)
    return out


def load_followings(refresh=False):
    if not refresh and os.path.exists(CACHE):
        age = time.time() - os.path.getmtime(CACHE)
        if age < 6 * 3600:
            return json.load(open(CACHE, encoding="utf-8"))
    data = fetch_followings()
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(data, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.report):
        raise SystemExit("报表不存在：" + args.report)

    followings = load_followings(args.refresh)
    mutual = {str(u["mid"]): u for u in followings if u.get("attribute") == 6}
    print(f"关注 {len(followings)} 个，其中互关 {len(mutual)} 个")

    rows = list(csv.DictReader(open(args.report, encoding="utf-8-sig")))
    fields = list(rows[0].keys())
    if "互关" not in fields:
        fields.append("互关")

    hit = 0
    for r in rows:
        if r["UID"] in mutual:
            r["互关"] = "是"
            # 互关是认识的人，不参与自动清理（原状态记在备注里）
            if r.get("状态") not in ("正常", "动态还活着"):
                r["备注"] = ((r.get("备注") or "") + f" 原状态:{r.get('状态')}").strip()
                r["状态"] = "互关（保留）"
            hit += 1
        else:
            r["互关"] = ""

    stamp = datetime.now(CST).strftime("%Y%m%d-%H%M")
    csv_path = os.path.join(OUT_DIR, f"follow_mutual_{stamp}.csv")
    md_path = os.path.join(OUT_DIR, f"follow_mutual_{stamp}.md")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    kept = [r for r in rows if r["互关"] == "是"]
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# 互关保护 {datetime.now(CST):%Y-%m-%d %H:%M}\n\n")
        f.write(f"你的关注里 {len(mutual)} 个是互相关注，已全部标为「互关（保留）」：\n\n")
        f.write("| # | UID | 昵称 | 之前的状态 |\n|---|---|---|---|\n")
        for i, r in enumerate(kept, 1):
            prev = (r.get("备注") or "").replace("原状态:", "") or "-"
            f.write(f"| {i} | {r['UID']} | {r['昵称']} | {prev} |\n")

    print(json.dumps({"ok": True, "互关": len(mutual), "命中报表": hit,
                      "csv": csv_path, "md": md_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
