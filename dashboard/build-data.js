// 把体检 CSV 转成仪表盘用的紧凑 JSON：[uid, name, videoDays, dynDays, fans, deleted, streamed, mutual]
const fs = require("fs");
const path = process.argv[2];
const out = process.argv[3];

const text = fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "");
const lines = text.split(/\r?\n/).filter(Boolean);
const head = lines[0].split(",");
const idx = (n) => head.indexOf(n);
const col = (row, n) => (row[idx(n)] || "").trim();

const rows = lines.slice(1).map((l) => l.split(","));
const today = new Date("2026-11-08T00:00:00+08:00").getTime();
const daysAgo = (s) => {
  if (!s) return -1;
  const t = Date.parse(s + "T00:00:00+08:00");
  return Number.isFinite(t) ? Math.floor((today - t) / 86400000) : -1;
};

const data = rows.map((r) => {
  const status = col(r, "状态");
  const live = col(r, "直播状态");
  return [
    col(r, "UID"),
    (col(r, "昵称") || "").replace(/"/g, ""),
    daysAgo(col(r, "最近投稿")),
    daysAgo(col(r, "最近动态")),
    Number(col(r, "粉丝数")) || 0,
    status.includes("已注销") ? 1 : 0,
    (live === "播过" || live === "正在直播") ? 1 : 0,
    col(r, "互关") === "是" ? 1 : 0,
  ];
});

fs.writeFileSync(out, JSON.stringify(data));
console.log("rows:", data.length,
  "| 无投稿:", data.filter((d) => d[2] < 0).length,
  "| 无动态:", data.filter((d) => d[3] < 0).length,
  "| 播过:", data.filter((d) => d[6]).length,
  "| 互关:", data.filter((d) => d[7]).length,
  "| json bytes:", fs.statSync(out).size);
