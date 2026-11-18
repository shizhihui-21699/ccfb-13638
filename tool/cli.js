#!/usr/bin/env node
// 过度返回检测工具 CLI
//   node tool/cli.js analyze   静态分析前端字段使用      → report/static.json
//   node tool/cli.js trace     运行时 Proxy 追踪真实流程  → report/runtime.json（含基线快照）
//   node tool/cli.js report    合并两本账 + 敏感定级      → report/over-return.json, report/report.md
//   node tool/cli.js plan      生成字段裁剪方案           → report/trim-plan.json
//   node tool/cli.js regress   应用裁剪方案跑回归         → report/regression.json
//   node tool/cli.js all       一键跑完整流程
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from './lib/staticAnalyzer.js';
import { createTracer, normalizePath } from './lib/proxyTracer.js';
import { mergeResults, inventoryOf } from './lib/merge.js';
import { gradeField } from './lib/sensitivity.js';
import { renderReport } from './lib/reportGen.js';
import { startServer, runFlows, fetchJson } from './lib/capture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_DIR = path.join(ROOT, 'sample-app', 'frontend');
const REPORT_DIR = path.join(ROOT, 'report');
const DEFAULT_PATTERNS = ['/api/users', '/api/users/:id'];

fs.mkdirSync(REPORT_DIR, { recursive: true });
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, name), 'utf8'));
const writeJson = (name, data) => {
  fs.writeFileSync(path.join(REPORT_DIR, name), JSON.stringify(data, null, 2));
  console.log(`  → report/${name}`);
};

// ---------- analyze ----------
function cmdAnalyze() {
  console.log('[analyze] 静态分析前端字段使用…');
  const result = analyzeProject({ rootDir: FRONTEND_DIR, externalDirs: ['vendor'] });
  writeJson('static.json', result);
  for (const [ep, u] of Object.entries(result)) {
    console.log(`  ${ep}: ${u.used.length} 个字段被使用, 弱使用子树 ${u.weakSubtrees.length}, 动态键 ${u.dynamic.length}, 外部逃逸 ${u.external.length}`);
  }
  return result;
}

// ---------- trace ----------
async function cmdTrace() {
  console.log('[trace] 启动未裁剪服务器，运行用户流程并追踪字段读取…');
  let patterns = DEFAULT_PATTERNS;
  try {
    patterns = Object.keys(readJson('static.json'));
  } catch { /* 用默认 */ }

  const server = await startServer();
  try {
    const tracer = createTracer();
    const inventory = {};
    const { setResponseInterceptor } = await import('../sample-app/frontend/apiClient.js');
    setResponseInterceptor((data, reqPath) => {
      const pathname = new URL(reqPath, 'http://x').pathname;
      const ep = normalizePath(pathname, patterns);
      // 先留字段清单（基于原始数据），再包 Proxy 追踪
      inventory[ep] = [...new Set([...(inventory[ep] || []), ...inventoryOf(data)])].sort();
      return tracer.track(data, ep);
    });

    const outputs = await runFlows(server.baseUrl);
    // 追踪完毕立即摘掉拦截器，避免污染同一进程里后续的回归抓取
    setResponseInterceptor(null);
    const runtime = tracer.collect();
    writeJson('runtime.json', { endpoints: runtime, inventory, tracedOutputs: outputs });
    for (const [ep, u] of Object.entries(runtime)) {
      console.log(`  ${ep}: 运行时直接读 ${u.used.length}, 枚举弱使用 ${u.weak.length}, 返回字段 ${inventory[ep].length}`);
    }
    return { runtime, inventory, outputs };
  } finally {
    await server.close();
  }
}

// ---------- report ----------
function cmdReport() {
  console.log('[report] 合并静态/运行时结果，生成判定与敏感定级…');
  const staticResult = readJson('static.json');
  const { endpoints: runtimeResult, inventory } = readJson('runtime.json');
  const merged = mergeResults({ staticResult, runtimeResult, inventory });

  // 附敏感定级后写出
  const graded = {};
  for (const [ep, data] of Object.entries(merged)) {
    graded[ep] = {
      ...data,
      fields: data.fields.map((f) => ({ ...f, sensitivity: gradeField(f.path) })),
    };
  }
  writeJson('over-return.json', graded);

  const md = renderReport({ merged, staticResult, runtimeResult });
  fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), md);
  console.log('  → report/report.md');

  const trimCount = Object.values(merged).reduce(
    (n, d) => n + d.fields.filter((f) => f.verdict === 'trim').length, 0
  );
  console.log(`  疑似过度返回字段: ${trimCount}`);
  return merged;
}

// ---------- plan ----------
function cmdPlan() {
  console.log('[plan] 生成字段裁剪方案…');
  const merged = readJson('over-return.json');
  const plan = { generatedAt: new Date().toISOString(), endpoints: {} };
  for (const [ep, data] of Object.entries(merged)) {
    const keep = data.fields.filter((f) => f.verdict !== 'trim').map((f) => f.path);
    const drop = data.fields.filter((f) => f.verdict === 'trim').map((f) => f.path);
    plan.endpoints[ep] = { keep, drop };
    console.log(`  ${ep}: 保留 ${keep.length}, 裁剪 ${drop.length}`);
  }
  writeJson('trim-plan.json', plan);
  return plan;
}

// ---------- regress ----------
async function cmdRegress() {
  console.log('[regress] 应用裁剪方案，对比裁剪前后全部流程输出…');
  const plan = readJson('trim-plan.json');

  // 基线必须现抓且干净（不经过追踪拦截器）：
  // trace 阶段的输出是 Proxy 包装下渲染的，不能当回归基准。
  console.log('[regress] 抓取未裁剪基线…');
  const untrimmed = await startServer();
  let baseline;
  try {
    baseline = await runFlows(untrimmed.baseUrl);
  } finally {
    await untrimmed.close();
  }

  const trimmed = await startServer({ trimPlan: plan });
  try {
    const outputs = await runFlows(trimmed.baseUrl);

    const flowResults = {};
    let allPass = true;
    for (const name of Object.keys(baseline)) {
      const pass = baseline[name] === outputs[name];
      flowResults[name] = pass ? 'PASS' : 'FAIL';
      if (!pass) {
        allPass = false;
        console.log(`  ✗ 流程 ${name} 输出不一致！`);
        // 打出第一处差异位置，方便定位
        const a = baseline[name], b = outputs[name];
        let i = 0;
        while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        console.log(`    首个差异 @${i}:\n    基线: …${a.slice(Math.max(0, i - 40), i + 60)}\n    裁剪: …${b.slice(Math.max(0, i - 40), i + 60)}`);
      } else {
        console.log(`  ✓ 流程 ${name} 输出一致`);
      }
    }

    // 再验证裁剪真的生效：丢的字段不在，留的字段还在
    const rawChecks = [];
    for (const [ep, cfg] of Object.entries(plan.endpoints)) {
      const samplePath = ep.includes(':id') ? ep.replace(':id', 'u1001') : ep;
      const data = await fetchJson(trimmed.baseUrl, samplePath);
      const leaves = inventoryOf(data);
      for (const d of cfg.drop) {
        const gone = !leaves.some((l) => l === d || l.startsWith(d + '.'));
        rawChecks.push({ endpoint: ep, field: d, expect: 'absent', pass: gone });
        if (!gone) allPass = false;
      }
      for (const k of cfg.keep) {
        const present = leaves.some((l) => l === k || l.startsWith(k + '.'));
        rawChecks.push({ endpoint: ep, field: k, expect: 'present', pass: present });
        if (!present) allPass = false;
      }
    }
    const droppedVerified = rawChecks.filter((c) => c.expect === 'absent');
    const keptVerified = rawChecks.filter((c) => c.expect === 'present');
    const dropFails = droppedVerified.filter((c) => !c.pass);
    const keepFails = keptVerified.filter((c) => !c.pass);
    if (dropFails.length === 0 && keepFails.length === 0) {
      console.log(`  ✓ 裁剪生效验证: ${droppedVerified.length} 个被裁字段已消失, ${keptVerified.length} 个保留字段仍在`);
    } else {
      for (const c of dropFails) console.log(`  ✗ 字段 ${c.endpoint} → ${c.field} 应被裁剪却仍在`);
      for (const c of keepFails) console.log(`  ✗ 字段 ${c.endpoint} → ${c.field} 应保留却丢失`);
    }

    const result = { pass: allPass, flows: flowResults, rawChecks };
    writeJson('regression.json', result);
    console.log(allPass ? '[regress] ✅ 回归通过：裁剪后功能无损' : '[regress] ❌ 回归失败');
    return result;
  } finally {
    await trimmed.close();
  }
}

// ---------- main ----------
const cmd = process.argv[2] || 'all';
const steps = {
  analyze: cmdAnalyze,
  trace: cmdTrace,
  report: cmdReport,
  plan: cmdPlan,
  regress: cmdRegress,
};

if (cmd === 'all') {
  cmdAnalyze();
  await cmdTrace();
  cmdReport();
  cmdPlan();
  await cmdRegress();
  console.log('\n完成。查看 report/report.md 获取完整报告。');
} else if (steps[cmd]) {
  await steps[cmd]();
} else {
  console.error(`未知命令: ${cmd}\n可用: ${['all', ...Object.keys(steps)].join(', ')}`);
  process.exit(1);
}
