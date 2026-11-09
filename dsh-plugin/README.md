# dsh-bili-follow-doctor

DeepSeek Harness 插件版「B站关注体检」：扫关注 → 查最近投稿/动态 → 出名单 → 经确认后逐个取关。
只走本机网络，凭证存在 `~/.dsh/bili-follow/cred.json`，不经过第三方。

**v1.2.0 起自带设置页**：不用每次让 AI 帮你敲工具，DSH「设置」里多一页「关注体检」，
总览、阈值、开扫、看名单、出报表、勾选取关都在里面。

## 安装

```bash
# 插件市场 / GitHub 源
dsh plugin --profile web add github:oTAKUBANG1/bili-follow-doctor#path:/dsh-plugin

# 本地开发（换成你自己的路径）
dsh plugin --profile web add link:/path/to/bili-follow-doctor/dsh-plugin
```

装上后重启 DSH，左侧「设置」里会出现「关注体检」这一页。会话里的工具也同时可用。

## 设置页怎么用

1. **账号**：装过「刷B站」的话会自动复用它的登录；没有就从浏览器 F12 → Application → Cookies
   抄 `SESSDATA` / `bili_jct` / `buvid3` / `DedeUserID` 四项填进去。
2. **多久没动静算僵尸**：填天数，或者点 1 年 / 2 年 / 3 年。
3. **开始扫描**：后台跑，可以离开这一页去看别的，进度条会自己走。
4. **名单**：按状态筛（僵尸号 / 已注销 / 零内容 / 只发动态 / 播过的主播 / 互关 / 正常），可翻页。
5. **取关**：勾选 → 点「取关选中的」→ 弹确认框。正在直播/播过的主播和互关默认被跳过，
   要删它们得单独点那行的按钮（跟命令行 `allowLive` / `allowMutual` 同一套规则）。
6. **导出 CSV + Markdown**：落在 `~/.dsh/bili-follow/out/`。

## 工具（会话里用）

| 工具 | 作用 |
|---|---|
| `bili_follow_login` | 生成扫码登录地址，返回 `url` + `qrcodeKey` |
| `bili_follow_login_poll` | 查询扫码结果，成功自动写凭证 |
| `bili_follow_scan` | **分批**扫描（工具调用有超时，一次 `limit` 个，反复调直到 `remaining=0`）；`staleDays` 可自定义僵尸阈值 |
| `bili_follow_list` | 按状态列名单（zombie / deleted / empty / dynonly / alive / all），支持 `staleDays` |
| `bili_follow_report` | 导出 CSV + Markdown 到 `~/.dsh/bili-follow/out/`，支持 `staleDays` |
| `bili_follow_unfollow` | 取关（**必须 `confirm:true`**，一次最多 50 个；正在直播/播过的默认跳过，`allowLive:true` 才删） |
| `bili_follow_status` | 总览：凭证是否就绪、扫了多少、各状态数量 |

设置页读写的接口在 `/api/bili-follow/*`（`status` / `list` / `scan` / `stop` / `report` / `unfollow` / `cred`），
跟工具共用同一套实现，不会两边口径漂移。

## 典型流程

```
1. bili_follow_login            → 得到二维码地址，手机 B站 App 扫
2. bili_follow_login_poll       → ok:true 表示凭证已落地
3. bili_follow_scan {limit:40}  → 反复调用，直到 remaining = 0
4. bili_follow_report           → 出 CSV / Markdown
5. 把名单给使用者看，确认后再 bili_follow_unfollow {mids:[...], confirm:true}
```

## 实现要点

- **最近投稿走 app 通道**（`app.bilibili.com/x/v2/space/archive`，appkey 签名）。web 的
  `x/space/wbi/arc/search` 大约 60~80 次就会被 HTTP 412 封，全量扫必挂（2026-11-06 实测）。
- 注销判定：关注列表昵称含「已注销」→ 直接算；否则看 `x/web-interface/card` 的 -404。
- 最近动态走 `x/polymer/web-dynamic/v1/feed/space`（wbi 签名，本插件自己算）。
- **直播保护**：视频和动态都停了才去查直播间（`room/v1/Room/getRoomInfoOld` + `get_info`）。
  B站 不开放"上次开播时间"（离线时 `live_time` 恒为 `0000-00-00`），所以用「直播间有没有自定义标题/分区」
  判断播没播过 —— 播过的一律保留，不参与自动清理。
- 结果落 `~/.dsh/bili-follow/cache.json`，中断可续；`refresh:true` 重扫。
- 凭证也能复用「刷B站」(dsh-bili-scroll) 登录过的那份 `~/.dsh/bili-duty/bili_credential.json`。

## 判定口径

- **僵尸号** = 最近投稿和最近动态都超过 730 天
- **只发动态** = 视频停更但动态在更新（建议保留）
- **零内容** = 主页能访问但什么也没发过

## 注意

- 取关不可撤销；插件强制要求 `confirm:true`，且一次最多 50 个。
- 只看投稿视频 + 动态，不看专栏/直播；只直播的 UP 会被算成僵尸。
- 别把 `limit` 开太大：工具调用超时会被中断（设置页默认每批 40 个，约 1.5 分钟一批）。

License: MIT
