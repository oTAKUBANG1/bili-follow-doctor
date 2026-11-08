// 生成演示数据：[uid, name, videoDays, dynDays, fans, deleted, streamed, mutual]
// 全部虚构，不含任何真实账号。用固定种子，保证每次生成结果一致。
const fs = require("fs");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261108);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const FIRST = ["示例", "演示", "测试", "虚构", "样本", "占位", "假想", "模拟"];
const STYLE = ["UP主", "频道", "工作室", "小站", "日记", "研究所", "编辑部", "电台"];
const EN = ["demo", "example", "sample", "mock", "dummy", "fake", "test"];
const SUFFIX = ["01", "02", "03", "04", "05", "x", "_v2", "official", "lab", "log"];

const used = new Set();
function makeName(i) {
  let n;
  do {
    n = rnd() < 0.55
      ? pick(FIRST) + pick(STYLE) + (rnd() < 0.5 ? ri(1, 99) : "")
      : pick(EN) + "_" + pick(["creator", "channel", "user", "studio"]) + "_" + pick(SUFFIX);
    if (n.length < 3) n += ri(10, 99);
  } while (used.has(n));
  used.add(n);
  return n;
}

// 粉丝数：对数分布，少量大号
function makeFans() {
  const r = rnd();
  if (r < 0.35) return ri(1, 999);
  if (r < 0.7) return ri(1000, 9999);
  if (r < 0.93) return ri(10000, 99999);
  return ri(100000, 800000);
}

const rows = [];
let uid = 900000001;
const add = (v, d, fans, flags = {}) => {
  rows.push([
    String(uid++), makeName(),
    v, d, fans,
    flags.deleted ? 1 : 0, flags.streamed ? 1 : 0, flags.mutual ? 1 : 0,
  ]);
};

// 正常更新（大部分）
for (let i = 0; i < 52; i++) add(ri(1, 700), ri(1, 700), makeFans());
// 双停更 → 可清理
for (let i = 0; i < 14; i++) add(ri(760, 2150), ri(760, 2150), makeFans());
// 播过的（有的也停更，但被保护）
for (let i = 0; i < 9; i++) add(ri(760, 1900), ri(500, 1900), makeFans(), { streamed: true });
// 互关
for (let i = 0; i < 5; i++) add(ri(200, 1900), ri(200, 1900), makeFans(), { mutual: true });
// 已注销
for (let i = 0; i < 3; i++) add(ri(400, 1800), -1, makeFans(), { deleted: true });
// 动态没查过 → 待核验
for (let i = 0; i < 7; i++) add(ri(760, 2100), -1, makeFans());
// 零内容
for (let i = 0; i < 3; i++) add(-1, -1, makeFans());

fs.writeFileSync(process.argv[2] || "demo-data.json", JSON.stringify(rows));
console.log("rows:", rows.length, "bytes:", fs.statSync(process.argv[2] || "demo-data.json").size);
