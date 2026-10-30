// 只读：打印 23:53 之后每个回合的逐条时间戳与间隔，判断「回合」该怎么切。
import { DatabaseSync } from 'node:sqlite';

const CUTOFF = new Date('2026-10-28T23:53:00+08:00').getTime();
const db = new DatabaseSync('state/archive.db', { readOnly: true });
const rows = db.prepare('select t, side, text from messages order by t asc').all()
  .filter((r) => r.t >= CUTOFF);

const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

let cur = [];
const flush = () => {
  if (!cur.length) return;
  const span = (cur[cur.length - 1].t - cur[0].t) / 1000;
  const gaps = cur.slice(1).map((m, i) => ((m.t - cur[i].t) / 1000).toFixed(1) + 's');
  console.log(`\n她 ${cur.length} 条 | 起 ${fmt(cur[0].t)} 跨 ${span.toFixed(1)}s | 间隔 [${gaps.join(', ')}]`);
  for (const m of cur) console.log(`   ${fmt(m.t)}  ${String(m.text).slice(0, 46)}`);
  cur = [];
};

for (const r of rows) {
  if (r.side === 'her') cur.push(r);
  else {
    if (cur.length) { flush(); console.log(`   ── 他 ${fmt(r.t)}: ${String(r.text).slice(0, 34)}`); }
    else console.log(`他 ${fmt(r.t)}: ${String(r.text).slice(0, 34)}`);
  }
}
flush();
