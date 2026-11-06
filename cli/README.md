# B站关注体检（命令行版）

只读扫描 + 可选批量取关。三个脚本，纯标准库，不需要 pip 安装。

| 脚本 | 作用 |
|---|---|
| `audit.py` | 全量关注 → 最近投稿时间 → CSV/MD |
| `dynamics_audit.py` | 给"停更"的补查动态，剔除误判 |
| `mutual_mark.py` | 标出互相关注的人，不参与清理 |
| `live_check.py` | 补查直播，播过的账号保下来（防误删主播） |
| `unfollow.py` | 按报表取关（**默认 dry-run**，加 `--yes` 才执行） |

## 用法

```powershell
# 1) 先扫投稿（879 个约 10 分钟，可中断重跑续传）
python audit.py --days 730

# 2) 再查动态，把只在动态活跃的挑出来
python dynamics_audit.py --days 730

# 3) 再查直播，把播过的保下来（B站 不开放上次开播时间，播过的一律保留）
python mutual_mark.py --report out\follow_final_xxx.csv
python live_check.py --report out\follow_mutual_xxx.csv --days 730

# 4) 看看会取关谁（不执行；默认跳过「正在直播 / 播过」的账号）
python unfollow.py --report out\follow_live_xxx.csv --status "2年无任何更新"

# 5) 真执行（不可撤销）
python unfollow.py --report out\follow_live_xxx.csv --status "2年无任何更新" --yes
```

`--days` 是自定义阈值：730 = 两年，365 = 一年。视频和动态**都**超过这个天数才算僵尸号。

## unfollow.py 的安全设计

- 默认 **dry-run**：只打印名单（UID/昵称/状态/停更天数/粉丝），不动账号
- 必须 `--yes` 才真的取关；一次超过 100 个还要 `--allow-large`
- **互关保护**：报表里「互关 = 是」的行默认跳过，要一起删得加 `--include-mutual`
- **主播保护**：报表里「直播状态 = 正在直播 / 播过」的行默认跳过，要一起删得加 `--include-live`
- `--min-days` / `--max-fans` 可以二次过滤（例如只清小号：`--max-fans 1000`）
- 每 2 秒一个，进度写 `out/unfollow.jsonl`，中断重跑自动跳过已成功的
- Ctrl+C 随时停

## 输出

`out/follow_final_<时间>.csv`（Excel 直接开）和 `.md`。CSV 列：
状态 / UID / 昵称 / 最近投稿 / 停更天数 / 最近动态 / 动态天数 / 粉丝数 / 主页。

## 凭证

读 `~/.dsh/bili-follow/cred.json` 或 `~/.dsh/bili-duty/bili_credential.json`，
字段 `sessdata / bili_jct / buvid3 / dedeuserid`。没有它会直接报错，不会用内置账号兜底。

## 已知局限

1. 只看**投稿视频 + 动态**，不看专栏、直播、收藏夹。
2. 粉丝数来自 card 接口，个别账号拿不到显示 `-`。
3. 限流：app 通道实测可 2.5 次/秒；web 的 `arc/search` 约 60~80 次就会 412，本方案已弃用。
