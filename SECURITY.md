# 安全与隐私

这个工具会接触你的 B站 账号数据，所以把边界写清楚。

## 工具接触什么

| 数据 | 用途 | 去哪 |
|---|---|---|
| `DedeUserID` | 知道"你是谁"，才能拉关注列表 | 只在本机内存 |
| `bili_jct` | 取关接口需要 csrf token | 只在本机内存 |
| `SESSDATA` | DSH 插件 / 命令行版本访问接口用 | 存 `~/.dsh/bili-follow/cred.json` |
| 关注列表、UP 名、投稿/动态时间、粉丝数 | 就是体检本身 | 存本机（localStorage 或 `cache.json`），**不上传** |

**油猴脚本不读 `SESSDATA`**：用浏览器本来就有的登录态，只取 `DedeUserID` 和 `bili_jct`。

## 绝不发送到的地方

- 没有自建服务器、统计、埋点
- 只请求 `api.bilibili.com`、`app.bilibili.com`、`passport.bilibili.com`
- 不写远程日志，不生成遥测

## 风险提示

- 请求太密会触发 B站 风控（HTTP 412）。脚本内置冷却，但别把间隔调到 1 秒以下。
- 取关不可撤销。批量操作前先看 dry-run 名单。
- 不是官方产品，接口随时可能变；失效时看返回的错误码。

## 发布者自查清单

1. 仓库里不出现 `out/`、`cache.json`、`cred.json`
2. 截图里用虚构昵称
3. README 不写本机路径
4. `git log` 里不带真实姓名/邮箱（用 noreply 地址）
5. `git status` 只应看到源码 + 文档
