// 只读探针：确认「改 qq-bridge 的 dsh.provider 为 silicon」的可行性。
//
// 关键问题：ensureChatModel 调用 api.sessions.selectModel({provider, model})。
//   DSH 会不会因为 provider 不在 routableProviders 里而拒绝？
//   → 由 session/modelCatalog 返回的 routableProviders 与 groups 决定。
//
// 本脚本不改任何配置、不建会话、不发消息。
import fs from 'node:fs';
import { NodeApiClient } from '../src/dsh-client.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const d = cfg.dsh;
const client = new NodeApiClient(d.baseUrl, 5000, { token: d.authToken, tokenExplicit: false });

const res = await client.callUnary('session/modelCatalog', {});
const v = res.result.value ?? res.result;

console.log('=== 当前 DSH 模型目录 ===');
console.log('default:', JSON.stringify(v.default));
console.log('\nroutableProviders (', v.routableProviders.length, '个):');
for (const p of v.routableProviders) console.log('  -', p);

console.log('\ngroups (', (v.groups || []).length, '组):');
for (const g of v.groups || []) {
  console.log(`  ${g.id} (${g.name}) — ${(g.models || []).length} 个模型`);
}

console.log('\n=== 关键判断 ===');
const hasSilicon = v.routableProviders.some((p) => /silicon/i.test(p));
console.log('silicon 在 routableProviders 里:', hasSilicon ? '✅ 是' : '❌ 否（未安装，所以现在不可能）');

// ensureChatModel 用的 provider 是 cfg 里的值
const cur = d.provider;
const inList = v.routableProviders.includes(cur);
console.log(`\n桥当前周 provider「${cur}」在白名单里:`, inList ? '✅' : '❌');
if (!inList) console.log('  ⚠️ 这意味着 selectModel 可能被 DSH 拒绝！');
