# dsh-bili-follow-doctor

DeepSeek Harness 插件版「B站关注体检」：扫关注 → 查最近投稿/动态 → 出名单 → 经确认后逐个取关。
只走本机网络，凭证存在 `~/.dsh/bili-follow/cred.json`，不经过第三方。

## 安装

```bash
# 本地目录直接挂（开发用）
dsh plugin --profile web add link:D:\project-demo\dsh-bili-follow-doctor

# 或者发布到 npm 后
dsh plugin --profile web add dsh-bili-follow-doctor
```

装上后在 profile 的 `dsh.profile.bundles` 里出现即可，重启会话生效。

## 工具

| 工具 | 作用 |
|---|---|
| `bili_follow_login` | 生成扫码登录地址，返回 `url` + `qrcodeKey` |
| `bili_follow_login_poll` | 查询扫码结果，成功自动写凭证 |
| `bili_follow_scan` | **分批**扫描（工具调用有超时，一次 `limit` 个，反复调直到 `remaining=0`）；`staleDays` 可自定义僵尸阈值 |
| `bili_follow_list` | 按状态列名单（zombie / deleted / empty / dynonly / alive / all），支持 `staleDays` |
| `bili_follow_report` | 导出 CSV + Markdown 到 `~/.dsh/bili-follow/out/`，支持 `staleDays` |
| `bili_follow_unfollow` | 取关（**必须 `confirm:true`**，一次最多 50 个） |
| `bili_follow_status` | 总览：凭证是否就绪、扫了多少、各状态数量 |

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
- 结果落 `~/.dsh/bili-follow/cache.json`，中断可续；`refresh:true` 重扫。
- 凭证也能复用「刷B站」(dsh-bili-scroll) 登录过的那份 `~/.dsh/bili-duty/bili_credential.json`。

## 判定口径

- **僵尸号** = 最近投稿和最近动态都超过 730 天
- **只发动态** = 视频停更但动态在更新（建议保留）
- **零内容** = 主页能访问但什么也没发过

## 注意

- 取关不可撤销；插件强制要求 `confirm:true`，且一次最多 50 个。
- 只看投稿视频 + 动态，不看专栏/直播；只直播的 UP 会被算成僵尸。
- 别把 `limit` 开太大：工具调用超时会被中断（默认 40 个约 1.5 分钟）。

License: MIT
