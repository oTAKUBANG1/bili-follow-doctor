# B站关注体检 · Follow Doctor

扫一遍你的 B站 关注列表，标出**已注销**和**长期没动静**的僵尸 UP。
三种形态，都只走本机网络、不经过任何第三方服务器。

| 形态 | 适合谁 | 入口 |
|---|---|---|
| 🐟 **油猴脚本** | 一般用户，装完就能用 | [`bili-follow-doctor.user.js`](bili-follow-doctor.user.js) |
| 🔌 **DSH 插件** | 用 DeepSeek Harness 的人 | [`dsh-plugin/`](dsh-plugin/) |
| 💻 **命令行** | 想跑在服务器/批量处理 | [`cli/`](cli/) |
| 📊 **可视化仪表盘** | 想先看「阈值改一改能清多少」 | [`dashboard/`](dashboard/) |

![界面](screenshot.png)

## 它做什么

1. 拉你的完整关注列表
2. 逐个查**最近一条投稿**和**最近一条动态**
3. 按「视频和动态都超过 N 天没更新」判定僵尸号（N 可自己设，默认 730 天）
4. 出名单（CSV / Markdown / 表格），你确认后再取关

## 判定口径

| 状态 | 含义 |
|---|---|
| 已注销 | 昵称是「账号已注销」，或主页接口 404 |
| 僵尸号 | 最近投稿**和**最近动态都超过阈值天数，**且没播过** |
| 主播（保留） | 正在直播，或开过直播间（B站 不开放"上次开播时间"，所以播过的一律保守保留） |
| 互关（保留） | 你们互相关注（接口 `attribute=6`）—— 认识的人，不参与清理 |
| 只发动态 | 视频停更但动态在更新 —— **别误删** |
| 零内容 | 投稿、动态都没有 |
| 正常 | 还有更新 |

只按投稿算会误杀一大批"只发动态"的 UP（实测 121 个"停更"里有 26 个还在更新动态），所以动态必须一起查。
再加上直播：113 个"停更"账号里有 72 个开过播，全部单独拎出来，不参与自动清理。

## 安装油猴脚本

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey
2. 打开这个地址安装（会弹安装页）：

```
https://raw.githubusercontent.com/oTAKUBANG1/bili-follow-doctor/main/bili-follow-doctor.user.js
```

3. 打开任意 B站 页面，右下角出现「🐟 关注体检」

面板里有**状态分布环形图**和**停更时长分布**（2–3 年 / 3–5 年 / 5–8 年 / 8 年以上），
扫完一眼就能看出「僵尸号都停更多久了」。图是纯 SVG 画的，不引任何外部库，断网也能看。

## 命令行

```bash
cd cli
python audit.py --days 730          # 扫最近投稿（可中断续跑）
python dynamics_audit.py --days 730 # 补查动态，剔除误判
python unfollow.py --report out/follow_final_xxx.csv --status "2年无任何更新"  # dry-run
```

取关默认 dry-run，必须 `--yes` 才真执行。详见 [`cli/README.md`](cli/README.md)。

## DSH 插件

```bash
# 插件市场 / GitHub 源
dsh plugin --profile web add github:oTAKUBANG1/bili-follow-doctor#path:/dsh-plugin
```

装上重启后，DSH「设置」里多一页**「B站体检」**，两个页签：

- **关注体检**：总览、阈值、后台扫描进度、名单筛选、导出报表、勾选取关
- **收藏夹体检**：扫描所有收藏夹、按夹显示失效数、逐个夹清理

不用每次让 AI 敲工具。同时注册 7 个工具供会话使用（登录 / 扫描 / 列名单 / 报表 / 取关 / 状态）。
详见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

## 可视化仪表盘

[`dashboard/index.html`](dashboard/index.html) 是一个单文件网页：拖动视频/动态两条阈值线，实时看「能清掉几个」。
深色/浅色主题可切，带演示数据，离线可用。详见 [`dashboard/README.md`](dashboard/README.md)。

## 隐私

- 没有任何自建服务器、统计、埋点；只请求 `api.bilibili.com`、`app.bilibili.com`
- 油猴脚本不读 `SESSDATA`，只取 `DedeUserID`（算 mid）和 `bili_jct`（取关要 csrf）
- 扫描结果只存在本机（localStorage 或 `~/.dsh/bili-follow/`）
- 仓库里不放任何真实账号、关注名单、本机路径

细节和发布前自查清单见 [SECURITY.md](SECURITY.md)。

## 已知限制

1. 只看投稿视频 + 动态，不看专栏、直播、收藏夹；纯直播 UP 会被算成僵尸。
2. B站 风控：web 的 `arc/search` 约 60~80 次请求就被 412，所以最近投稿走 app 通道（`x/v2/space/archive`，appkey 签名）。
3. 取关不可撤销，批量前请先看 dry-run 名单。
4. 接口随时可能变；失效时先看错误码。

## License

MIT
