# CHANGELOG

## 1.1.0 — 2026-11-06

### 新增
- **直播保护**：视频、动态都停了才查直播间（`room/v1/Room/getRoomInfoOld` + `get_info`）。
  B站 不开放"上次开播时间"（离线时 `live_time` 恒为 `0000-00-00`），改用「直播间有没有自定义标题/分区」
  判断播没播过 —— 播过的账号一律保留，不参与自动清理。
- **互关保护**：关注列表接口的 `attribute=6` 就是互相关注。互关的人默认不删。
- **自定义阈值**：油猴脚本底部「多久算僵尸」、DSH 插件 `staleDays`、命令行 `--days`。
- `cli/mutual_mark.py`：把互关标出来并落到报表里。

### 变更
- `cli/unfollow.py` 默认跳过「互关」和「正在直播 / 播过」，要强制分别加 `--include-mutual` / `--include-live`。
- 油猴脚本新增「主播」「互关」筛选与标签；批量取关会自动剔除这两类并提示。
- DSH 插件 `bili_follow_unfollow` 增加 `allowLive` / `allowMutual`。

### 修复
- `audit.py` 不再把 UID 硬编码成开发者自己的账号；凭证缺失时直接报错。
- `--max-fans` 不再把"粉丝数查不到"的行当成 0 混进小号名单。

## 1.0.0 — 2026-11-06

- 首个版本：关注列表体检（已注销 / 停更）、动态复查、CSV 导出、逐个与批量取关。
- 三种形态：油猴脚本、DSH 插件、命令行。
- 最近投稿走 app 通道（`app.bilibili.com/x/v2/space/archive`），避开 web `arc/search` 的 412 风控。
