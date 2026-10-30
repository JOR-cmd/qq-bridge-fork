/**
 * 契阔脱敏（2026-10-29）—— 只用于契阔入库/注入，不改动别处的行为。
 *
 * 为什么单独一层：
 *   `SENSITIVE_RE`（sensitive.js）抓的是**路径和凭据赋值**，用于日志/出站文本；
 *   但契阔是**她写日记**，可能自然写下手机号、身份证、门牌号 ——
 *   这些不属于"凭据"，SENSITIVE_RE 不管，而它们不该被原样存进 archive.db。
 *
 * 设计原则：
 *   · **只脱敏，不审查**：不拦截内容、不报错，只把数字换成占位符；
 *   · **宁可放过**：误伤（把正常数字打码）比漏掉更影响她写日记的连贯性，
 *     所以规则只覆盖明确的强特征（手机号 11 位、身份证 18 位、长卡号）；
 *   · QQ 号**不脱敏**：那是她自己和主人聊天的一部分，且 archive.db 本来就存。
 */

/** 强特征的个人隐私数字。 */
const PRIVATE_PATTERNS = [
  // 中国大陆手机号：1 开头 11 位（前后不能是数字/字母，避免误伤长串）
  { re: /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/g, to: '[手机号]' },
  // 身份证：17 位数字 + 校验位（数字或 X）
  { re: /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g, to: '[证件号]' },
  // 银行卡 / 长卡号：16~19 位（前后不是数字），且不能是纯 QQ 号（QQ 最多 12 位）
  { re: /(?<![0-9A-Za-z])\d{16,19}(?![0-9A-Za-z])/g, to: '[卡号]' },
];

/**
 * 对一段可能进契阔的文本做脱敏。
 * @param {string} text
 * @returns {string}
 */
export function redactForCovenant(text) {
  let s = String(text ?? '');
  // 控制字符（可能来自复制粘贴）先清掉，别把不可见字符存进库
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  for (const { re, to } of PRIVATE_PATTERNS) {
    s = s.replace(re, to);
  }
  return s;
}

/** 判断一段文本里是否含隐私数字（给日志/诊断用，不改文本）。 */
export function hasPrivateNumbers(text) {
  const s = String(text ?? '');
  return PRIVATE_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}
