# CHANGELOG

## 1.2.1 — 2026-11-09

### 修复
- **油猴脚本只在 `space.bilibili.com` 注入**，在首页 / 视频页装完之后右下角什么都没有 ——
  使用者反馈「装了无法使用，没有弹出来」。注入范围放宽到 `www` / `t` / `live` / `search` / 主域。
- `mount()` 里加一行 `console.log("[关注体检] v… 已注入 <host><path>")`，装完打开控制台就能确认
  到底有没有注入（比「右下角啥都没有」好排查）。

## 1.2.0 — 2026-11-09

### 新增
- **DSH 插件自带设置页**（`dsh-plugin/client.js`）：`{ name: 'settings.section', id, order, label }`
  往 DSH「设置」里注册一页「关注体检」。总览卡片、阈值（天数 + 1/2/3 年快捷）、后台扫描 + 进度条、
  按状态筛的名单、导出报表、勾选取关（弹确认框）全在里面。
- **host 端 HTTP 接口** `/api/bili-follow/*`：`status` / `list` / `scan` / `stop` / `report` / `unfollow` / `cred`。
  扫描改成**后台任务 + 前端轮询**，不再挂在请求里等（879 个要十几分钟）。
- 工具和 HTTP 接口共用同一套实现（`scanBatch` / `listRows` / `writeReport` / `doUnfollow` / `statusSummary`），
  两边口径不会漂移。
- **油猴脚本加两张图**：状态分布环形图（SVG，颜色跟状态标签一致）+ 停更时长分布
  （2–3 年 / 3–5 年 / 5–8 年 / 8 年以上）。纯 SVG/DOM 画，不引任何外部库。

### 修复
- 油猴脚本的统计行从 1.1.0 起一直是空白的：`renderStats` 读 `app.ui.stats`，但实际注册的键叫
  `statsLine`，两个名字对不上。
- 插件 README 里的安装示例带着开发机路径（`D:\project-demo\...`），换成通用写法。

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
