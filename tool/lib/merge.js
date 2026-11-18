// 合并静态/运行时两本账，生成过度返回判定。
//
// 判定逻辑（对每个返回字段）：
//   静态或运行时直接读过        → keep（保留）
//   仅枚举式访问（弱使用）      → keep-review（保留但建议人工确认：通用渲染/序列化）
//   两边都没见过                → trim（裁剪候选）
//     · 若该端点存在未解析动态键或整对象逃逸到外部函数 → 降置信度，标 review
//
// 静态 used 是"终端访问路径"：非叶子路径命中时整棵子树算使用。
// 运行时 weak 同理（如 JSON.stringify(user.preferences) → preferences.* 全弱使用）。

function pathMatches(usedPaths, fieldPath) {
  // fieldPath 命中：精确相等，或它是某个 used 路径的后代（used 为非叶子终端）
  return usedPaths.some((u) => u === fieldPath || fieldPath.startsWith(u + '.'));
}

export function mergeResults({ staticResult, runtimeResult, inventory }) {
  const endpoints = {};
  const allEndpoints = new Set([
    ...Object.keys(inventory),
    ...Object.keys(staticResult || {}),
    ...Object.keys(runtimeResult || {}),
  ]);

  for (const ep of allEndpoints) {
    const s = (staticResult && staticResult[ep]) || { used: [], weakSubtrees: [], dynamic: [], external: [], spreads: [] };
    const r = (runtimeResult && runtimeResult[ep]) || { used: [], weak: [] };

    // 展开透传去伪：静态分析证明某路径被 `{...obj}` 展开过，那么运行时在该路径下
    // 的"仅枚举读"只是拷贝动作的副产品（passthrough），不算弱使用 ——
    // 拷贝走的值若真被下游消费，会在子 Proxy 上留下直接读。
    // 真正的枚举式消费（Object.entries / JSON.stringify）静态侧已另有 weakSubtrees 标记。
    const spreadRoots = (s.spreads || []).map((sp) => (sp.at === '(root)' ? '' : sp.at));
    const runtimeWeakEffective = r.weak.filter(
      (w) => !spreadRoots.some((root) => root === '' || w === root || w.startsWith(root + '.'))
    );

    const fields = (inventory[ep] || []).map((fieldPath) => {
      const staticUsed = pathMatches(s.used, fieldPath);
      const staticWeak = s.weakSubtrees.some((w) => {
        const prefix = w === '*' ? '' : w.slice(0, -2);
        return prefix === '' || fieldPath === prefix || fieldPath.startsWith(prefix + '.');
      });
      const runtimeUsed = pathMatches(r.used, fieldPath);
      const runtimeWeak = pathMatches(runtimeWeakEffective, fieldPath);

      let verdict, evidence;
      if (staticUsed && runtimeUsed) { verdict = 'keep'; evidence = 'static+runtime'; }
      else if (staticUsed) { verdict = 'keep'; evidence = 'static-only'; }
      else if (runtimeUsed) { verdict = 'keep'; evidence = 'runtime-only'; }
      else if (staticWeak || runtimeWeak) { verdict = 'keep-review'; evidence = 'enumeration-only'; }
      else { verdict = 'trim'; evidence = 'never-read'; }

      return { path: fieldPath, verdict, evidence, staticUsed, staticWeak, runtimeUsed, runtimeWeak };
    });

    const uncertain = s.dynamic.length > 0 || s.external.length > 0;
    for (const f of fields) {
      if (f.verdict === 'trim' && uncertain) f.confidence = 'review';
      else if (f.verdict === 'trim') f.confidence = 'high';
    }

    endpoints[ep] = {
      fields,
      notes: {
        dynamicKeys: s.dynamic,
        externalCalls: s.external,
        spreads: s.spreads,
      },
    };
  }
  return endpoints;
}

// 从原始响应提取叶子字段路径清单（对象数组按元素展开，路径相对单条记录）
export function inventoryOf(data) {
  const paths = new Set();
  const walk = (value, prefix) => {
    if (Array.isArray(value)) {
      if (value.length === 0) { if (prefix) paths.add(prefix); return; }
      if (value.every((v) => v === null || typeof v !== 'object')) {
        if (prefix) paths.add(prefix); // 标量数组整体算一个叶子
        return;
      }
      for (const el of value) walk(el, prefix);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) { if (prefix) paths.add(prefix); return; }
      for (const k of keys) walk(value[k], prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (prefix) paths.add(prefix);
  };
  walk(data, '');
  return [...paths].sort();
}
