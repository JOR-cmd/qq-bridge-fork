// 只读：核查真实对话里「谁做了什么」，用于判断叙事化改写是否扭曲语义。
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('state/archive.db', { readOnly: true });
const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });

const q = (kw) => {
  const rows = db.prepare(`select t, side, text from messages where text like ? order by t`).all(`%${kw}%`);
  console.log(`\n=== 含「${kw}」的消息 (${rows.length} 条) ===`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${fmt(r.t)} | ${r.side === 'her' ? '她' : '他'} | ${r.text.slice(0, 68)}`);
  }
};

q('作业');
q('抱');
db.close();
