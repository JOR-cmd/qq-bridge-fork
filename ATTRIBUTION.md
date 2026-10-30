# 参考项目与归属声明

本仓库是在 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（下称「上游」）
`v0.2.1-r1` 的基础上做**本地化修改**。

上游本身的代码与文档版权归 **Derpyu520 及 qq-bridge / QSH 贡献者**，依其 `LICENSE` 授权。
除此之外，本仓库的**部分设计与数值**参考了下列项目。这里逐条列明，以便追溯。

> **免责**：以下均为「参考设计思路 / 数值 / 结构」，**不包含复制粘贴对方源码**。
> 各项目许可请以其原仓库为准，本文件不构成对其许可的解释。

---

## 一、参考项目清单

| 项目 | 参考了什么 | 未采用什么 |
| --- | --- | --- |
| **memory-brain**<br>`_probe/memory-brain`（AstrBot 插件） | PAD 情绪层结构、5 级遗忘数值（衰减 0.01/天、访问加成 0.5、归档阈值、清理 180 天）、识海预算 2400 字、「人格只读」思路 | 完整 Python 服务、LLM 抽实体、图谱两表 |
| **dsh-remembers** | 五层记忆的 half-life 数值（L3=90 天 / L2=180 天 / L1=30 天）、tier 分层 | 完整实现（它是 AstrBot 插件）；`episode` 段级压缩未采用（我们逐条存原话） |
| **Mieksido/surfcore** | 目的引擎骨架（需求向量 / 未闭合的事 / 相似度去重 / 熟悉度降权）、对话收尾 `conversation-closure`、`purpose-engine.js` 的结构 | 完整实现；向量检索、LoRA 融合 |
| **dsh-world** | 告警便签（alarm note）思路 —— 「要记牢」的事要说清「怎么算应验」 | — |
| **dsh-retcon** | 「只加不改」（同一天改信存新版本、旧版保留可查）、切断实验（退役 + 回访）、「矛盾才失效、失效不删」的思路 | 整套图数据库 |
| **silicon** / `silicon-retention` | `parse_when` 中文时间解析（已本地化为 `when-cn.mjs`） | 向量检索、LoRA 融合 |
| **Graphiti** | 「矛盾才失效、失效不删」的思路 | 整套图数据库 |

## 二、代码中的标注位置

本仓库在自己的代码注释里已标明出处，便于逐条核对：

```
src/emotion-pad.mjs        照搬 memory-brain 的 emotion.py 结构与常量
src/covenant-store.mjs     dsh-world（便签）/ dsh-retcon（只加不改、切断实验）
src/covenant-facts.mjs     行为轨迹的做法
src/intent-engine.mjs      Mieksido/surfcore 的 purpose-engine.js 骨架
src/closure-engine.mjs     surfcore 的 conversation-closure.js
src/when-cn.mjs            silicon 的 parse_when（本地化）
scripts/decay-memory.mjs   memory-brain 的 store.py / engine.py 数值
dsh-remembers 的 TIER_HALF_LIFE
```

## 三、许可差异提示

- 上游在 `v0.2.1-r1` **之后**把许可证从 MIT 换成了
  PolyForm Noncommercial 1.0.0。**本仓库使用的是 MIT 版本的 `v0.2.1-r1`**，
  按上游 `NOTICE.md` 第 1.3 条，该等版本仍适用其发布时的许可。
- 上表各参考项目的许可**各自独立**，本仓库仅参考其设计，未复制其源码；
  如有再分发需求，请自行核对其原仓库许可。

## 四、如果发现遗漏

如果你是本文件所列项目的作者，认为某处标注不准确或应补充，
请通过 Issue 联系，我会按你的要求更正或移除。
