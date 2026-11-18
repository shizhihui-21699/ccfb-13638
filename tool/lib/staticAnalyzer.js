// 静态字段使用分析器：一个小型"污点式抽象解释器"。
//
// 做法：把 apiClient 里发请求的函数识别为污点源（返回值为 tainted），
// 然后对整个前端做抽象解释，跟踪污点值经过解构、展开、透传、动态键、
// 函数参数之后的每一次属性读取，记录成"访问路径"。
//
// 覆盖的刁钻取字段方式：
//   - 解构：            const { displayName } = user
//   - 展开透传：        renderUserCard({ ...user })   —— 顺着 spread 进入本地组件继续跟
//   - 动态键：          user[c.key]（常量可解析则解析，不可解析记 dynamic 标记）
//   - 权限/条件分支：   路径不敏感，两个分支都分析（宁可多算使用，不可漏算）
//   - 第三方黑盒：      vendor/ 等外部目录不分析，记 external 标记（交给运行时追踪）
//   - 枚举式访问：      Object.entries / JSON.stringify 记 weak 标记，不算真使用
//
// 输出（按 endpoint）：accessed（终端访问路径）、weakSubtrees、dynamic、external、spreads。
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON', 'Object', 'Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'RegExp', 'Promise', 'console', 'Symbol', 'BigInt',
  'Intl', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'undefined',
  'NaN', 'Infinity', 'globalThis', 'process', 'fetch', 'URL',
]);

// 原型方法名：出现在污点值上不记为字段访问
const METHOD_KEYS = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'constructor', 'toLocaleString',
  'toUpperCase', 'toLowerCase', 'trim', 'slice', 'substring', 'substr', 'split',
  'replace', 'replaceAll', 'includes', 'startsWith', 'endsWith', 'charAt',
  'concat', 'toFixed', 'padStart', 'padEnd', 'join', 'push', 'pop', 'shift',
  'unshift', 'splice', 'indexOf', 'lastIndexOf', 'keys', 'values', 'entries',
  'then', 'catch', 'finally', 'bind', 'call', 'apply', 'stringify', 'parse',
]);

const ARRAY_ITER_METHODS = new Set(['map', 'forEach', 'filter', 'find', 'some', 'every', 'flatMap', 'findIndex']);

// ---------- 抽象值 ----------
const UNK = { k: 'u' };
const T = (endpoint, tpath) => ({ k: 't', endpoint, path: tpath });
const CON = (value) => ({ k: 'c', value });
const OBJ = (props, spreadSources) => ({ k: 'o', props, spreadSources });
const ARR = (els) => ({ k: 'a', els });
const FN = (node, env, mod) => ({ k: 'f', node, env, mod });

function sigOf(av) {
  if (!av) return 'u';
  switch (av.k) {
    case 't': return `t:${av.endpoint}:${av.path}`;
    case 'c': return `c:${String(av.value)}`;
    case 'o': return 'o';
    case 'a': return 'a';
    case 'f': return `f:${av.node.start}`;
    default: return 'u';
  }
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// 在函数子树里找 request('/api/...') / fetch('/api/...') 之类的调用，提取 endpoint
function prescanEndpoint(fnNode) {
  let found = null;
  const visit = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const name =
        callee.type === 'Identifier' ? callee.name
        : callee.type === 'MemberExpression' && callee.property.type === 'Identifier' ? callee.property.name
        : null;
      if (name && ['request', 'fetch', 'get', 'post', 'put', 'del', 'delete'].includes(name)) {
        const arg = node.arguments[0];
        const ep = arg && endpointFromArg(arg);
        if (ep) { found = ep; return; }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && v.type) visit(v);
      if (found) return;
    }
  };
  const body = fnNode.body ? (fnNode.body.type === 'BlockStatement' ? fnNode.body.body : [fnNode.body]) : [];
  body.forEach(visit);
  return found;
}

function endpointFromArg(arg) {
  if (arg.type === 'StringLiteral' && arg.value.startsWith('/api')) return arg.value;
  if (arg.type === 'TemplateLiteral') {
    let s = '';
    for (let i = 0; i < arg.quasis.length; i++) {
      s += arg.quasis[i].value.cooked;
      if (i < arg.expressions.length) s += ':param';
    }
    if (s.includes('/api')) return s.replace(/:param/g, ':id');
  }
  return null;
}

export function analyzeProject({ rootDir, externalDirs = ['vendor'] }) {
  const isExternal = (absPath) =>
    externalDirs.some((d) => absPath.includes(path.sep + d + path.sep));

  const files = collectJsFiles(rootDir);
  const modules = new Map(); // absPath -> { ast, exports: Map|null, evaluating: bool }
  const usage = new Map();   // endpoint -> { accessed:Set, weakSubtrees:Set, dynamic:[], external:[], spreads:[] }

  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8');
    const ast = parse(code, { sourceType: 'module', plugins: [] });
    modules.set(f, { ast, exports: null, evaluating: false });
  }

  function getUsage(endpoint) {
    if (!usage.has(endpoint)) {
      usage.set(endpoint, { accessed: new Set(), weakSubtrees: new Set(), dynamic: [], external: [], spreads: [] });
    }
    return usage.get(endpoint);
  }

  // ---------- 环境 ----------
  function newEnv(parent) {
    return { vars: new Map(), parent: parent || null, returnVal: null, hasReturn: false };
  }
  function envGet(env, name) {
    let e = env;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    if (GLOBALS.has(name)) return { k: 'g', name };
    return UNK;
  }
  function envSet(env, name, val) {
    // 简化：就近写入已有绑定，否则写当前层
    let e = env;
    while (e) {
      if (e.vars.has(name)) { e.vars.set(name, val); return; }
      e = e.parent;
    }
    env.vars.set(name, val);
  }

  // ---------- 模块求值（懒加载 + 记忆化） ----------
  const endpointPrescanCache = new Map(); // fnNode.start -> endpoint|null

  function getModuleExports(absPath) {
    const mod = modules.get(absPath);
    if (!mod) return new Map();
    if (mod.exports) return mod.exports;
    if (mod.evaluating) return new Map(); // 循环依赖，放弃
    mod.evaluating = true;
    const env = newEnv(null);
    const exports = new Map();
    for (const stmt of mod.ast.program.body) {
      evalTopLevel(stmt, env, absPath, exports);
    }
    mod.exports = exports;
    mod.evaluating = false;
    return exports;
  }

  function resolveImport(fromFile, source) {
    if (!source.startsWith('.')) return null; // 裸导入：外部
    const abs = path.resolve(path.dirname(fromFile), source);
    if (isExternal(abs)) return 'EXTERNAL';
    if (!modules.has(abs)) return null;
    return abs;
  }

  function evalTopLevel(stmt, env, file, exports) {
    if (stmt.type === 'ImportDeclaration') {
      const target = resolveImport(file, stmt.source.value);
      let imported = null;
      if (target === 'EXTERNAL' || target === null) imported = null;
      else imported = getModuleExports(target);
      for (const spec of stmt.specifiers) {
        const local = spec.local.name;
        if (!imported) {
          env.vars.set(local, UNK);
        } else if (spec.type === 'ImportDefaultSpecifier') {
          env.vars.set(local, imported.get('default') || UNK);
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          env.vars.set(local, OBJ(imported, []));
        } else {
          env.vars.set(local, imported.get(spec.imported.name) || UNK);
        }
      }
      return;
    }
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) {
        evalStmt(stmt.declaration, env, file);
        const d = stmt.declaration;
        if (d.type === 'FunctionDeclaration') {
          exports.set(d.id.name, envGet(env, d.id.name));
        } else if (d.type === 'VariableDeclaration') {
          for (const decl of d.declarations) {
            if (decl.id.type === 'Identifier') exports.set(decl.id.name, envGet(env, decl.id.name));
          }
        }
      } else {
        for (const spec of stmt.specifiers) {
          exports.set(spec.exported.name, envGet(env, spec.local.name));
        }
      }
      return;
    }
    if (stmt.type === 'ExportDefaultDeclaration') {
      exports.set('default', evalExpr(stmt.declaration, env, file));
      return;
    }
    evalStmt(stmt, env, file);
  }

  // ---------- 使用记录 ----------
  function recordAccess(endpoint, tpath) {
    if (!tpath) return; // 根本身不算字段
    if (tpath.endsWith('.*')) return;
    getUsage(endpoint).accessed.add(tpath);
  }

  // ---------- 成员访问 ----------
  function memberAccess(objAV, keyAV, computed, file) {
    if (objAV.k === 't') {
      const u = getUsage(objAV.endpoint);
      if (keyAV.k === 'c' && typeof keyAV.value === 'string') {
        const key = keyAV.value;
        if (METHOD_KEYS.has(key)) return UNK;
        const p = objAV.path ? `${objAV.path}.${key}` : key;
        recordAccess(objAV.endpoint, p);
        return T(objAV.endpoint, p);
      }
      // 真·动态键：解析不出常量
      u.dynamic.push({ at: objAV.path || '(root)', file: path.basename(file) });
      return T(objAV.endpoint, objAV.path ? `${objAV.path}.*` : '*');
    }
    if (objAV.k === 'o') {
      if (keyAV.k === 'c' && typeof keyAV.value === 'string') {
        if (objAV.props.has(keyAV.value)) return objAV.props.get(keyAV.value);
        // 展开透传：属性不在本地，去 spread 源里找
        for (const src of objAV.spreadSources) {
          const r = memberAccess(src, keyAV, computed, file);
          if (r.k !== 'u') return r;
        }
      }
      return UNK;
    }
    if (objAV.k === 'a') {
      if (keyAV.k === 'c' && typeof keyAV.value === 'number') return objAV.els[keyAV.value] || UNK;
      return UNK;
    }
    return UNK;
  }

  // ---------- 表达式求值 ----------
  function evalExpr(node, env, file) {
    switch (node.type) {
      case 'Identifier':
        return envGet(env, node.name);
      case 'StringLiteral': return CON(node.value);
      case 'NumericLiteral': return CON(node.value);
      case 'BooleanLiteral': return CON(node.value);
      case 'NullLiteral': return CON(null);
      case 'TemplateLiteral': {
        const parts = [];
        let allConst = true;
        for (let i = 0; i < node.quasis.length; i++) {
          parts.push(node.quasis[i].value.cooked);
          if (i < node.expressions.length) {
            const v = evalExpr(node.expressions[i], env, file);
            if (v.k === 'c') parts.push(String(v.value));
            else { allConst = false; parts.push(''); }
          }
        }
        return allConst ? CON(parts.join('')) : UNK;
      }
      case 'BinaryExpression': {
        const l = evalExpr(node.left, env, file);
        const r = evalExpr(node.right, env, file);
        if (l.k === 'c' && r.k === 'c') {
          try {
            switch (node.operator) {
              case '+': return CON(l.value + r.value);
              case '===': return CON(l.value === r.value);
              case '!==': return CON(l.value !== r.value);
              case '<': return CON(l.value < r.value);
              case '>': return CON(l.value > r.value);
            }
          } catch { /* ignore */ }
        }
        return UNK;
      }
      case 'LogicalExpression': {
        evalExpr(node.left, env, file);
        return evalExpr(node.right, env, file);
      }
      case 'UnaryExpression':
        evalExpr(node.argument, env, file);
        return UNK;
      case 'ObjectExpression': {
        const props = new Map();
        const spreadSources = [];
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            const src = evalExpr(prop.argument, env, file);
            if (src.k === 't') {
              getUsage(src.endpoint).spreads.push({ at: src.path || '(root)', file: path.basename(file) });
              spreadSources.push(src);
            } else if (src.k === 'o') {
              for (const [k, v] of src.props) props.set(k, v);
              spreadSources.push(...src.spreadSources);
            }
            continue;
          }
          const key = prop.key.type === 'Identifier' ? prop.key.name
            : prop.key.type === 'StringLiteral' ? prop.key.value : null;
          if (key !== null) props.set(key, evalExpr(prop.value, env, file));
        }
        return OBJ(props, spreadSources);
      }
      case 'ArrayExpression': {
        const els = [];
        for (const el of node.elements) {
          if (!el) { els.push(UNK); continue; }
          if (el.type === 'SpreadElement') {
            const src = evalExpr(el.argument, env, file);
            if (src.k === 't') els.push(T(src.endpoint, src.path));
            else if (src.k === 'a') els.push(...src.els);
            else els.push(UNK);
          } else {
            els.push(evalExpr(el, env, file));
          }
        }
        return ARR(els);
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const obj = evalExpr(node.object, env, file);
        const key = node.computed
          ? evalExpr(node.property, env, file)
          : CON(node.property.name);
        return memberAccess(obj, key, node.computed, file);
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
        return evalCall(node, env, file);
      case 'NewExpression': {
        for (const a of node.arguments) consumeArg(evalExpr(a, env, file), file);
        return UNK;
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return FN(node, env, file);
      case 'AwaitExpression':
        return evalExpr(node.argument, env, file);
      case 'ConditionalExpression': {
        evalExpr(node.test, env, file);
        const a = evalExpr(node.consequent, env, file);
        const b = evalExpr(node.alternate, env, file);
        return a.k !== 'u' ? a : b;
      }
      case 'AssignmentExpression': {
        const v = evalExpr(node.right, env, file);
        if (node.left.type === 'Identifier') envSet(env, node.left.name, v);
        else evalExpr(node.left, env, file);
        return v;
      }
      case 'SequenceExpression': {
        let last = UNK;
        for (const e of node.expressions) last = evalExpr(e, env, file);
        return last;
      }
      case 'ParenthesizedExpression':
        return evalExpr(node.expression, env, file);
      case 'ThisExpression':
        return UNK;
      default:
        return UNK;
    }
  }

  // 污点值流入全局函数/未知函数：非根路径视为该字段被消费；根路径记 external（整对象逃逸）
  function consumeArg(av, file) {
    if (!av || av.k !== 't') return;
    const u = getUsage(av.endpoint);
    if (av.path === '') u.external.push({ arg: '(root)', file: path.basename(file) });
    else recordAccess(av.endpoint, av.path);
  }

  const activeCalls = new Set();
  let callDepth = 0;
  const MAX_DEPTH = 60;

  function callFunction(fnAV, args, file) {
    if (callDepth >= MAX_DEPTH) return UNK;
    const key = `${fnAV.node.start}|${args.map(sigOf).join(',')}`;
    if (activeCalls.has(key)) return UNK;

    // 污点源识别：函数体里直接发请求的，返回污点值
    if (!endpointPrescanCache.has(fnAV.node.start)) {
      endpointPrescanCache.set(fnAV.node.start, prescanEndpoint(fnAV.node));
    }
    const ep = endpointPrescanCache.get(fnAV.node.start);
    if (ep) return T(ep, '');

    activeCalls.add(key);
    callDepth++;
    try {
      const fnEnv = newEnv(fnAV.env);
      const params = fnAV.node.params || [];
      for (let i = 0; i < params.length; i++) {
        bindPattern(params[i], args[i] === undefined ? UNK : args[i], fnEnv, file);
      }
      const body = fnAV.node.body;
      if (body.type === 'BlockStatement') {
        for (const s of body.body) evalStmt(s, fnEnv, file);
      } else {
        fnEnv.returnVal = evalExpr(body, fnEnv, file);
        fnEnv.hasReturn = true;
      }
      return fnEnv.hasReturn ? fnEnv.returnVal : UNK;
    } finally {
      activeCalls.delete(key);
      callDepth--;
    }
  }

  function evalCall(node, env, file) {
    const argAVs = node.arguments.map((a) =>
      a.type === 'SpreadElement' ? UNK : evalExpr(a, env, file)
    );

    // 成员调用：user.map(...) / Object.entries(...) / apiClient.listUsers()
    if (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') {
      const objAV = evalExpr(node.callee.object, env, file);
      const keyAV = node.callee.computed
        ? evalExpr(node.callee.property, env, file)
        : CON(node.callee.property.name);
      const methodName = keyAV.k === 'c' ? keyAV.value : null;

      // 数组迭代方法（污点数组 / 抽象数组）
      if (methodName && ARRAY_ITER_METHODS.has(methodName)) {
        // 污点数组：元素同构，一个代表即可；常量数组：元素各异，每个都要过一遍
        const elems =
          objAV.k === 't' ? [T(objAV.endpoint, objAV.path)]
          : objAV.k === 'a' ? (objAV.els.length ? objAV.els : [UNK])
          : [UNK];
        const cb = argAVs[0];
        const rets = [];
        if (cb && cb.k === 'f') {
          for (const el of elems) rets.push(callFunction(cb, [el, CON(0), objAV], file));
        }
        if (methodName === 'map' || methodName === 'flatMap') return ARR(rets);
        if (methodName === 'filter') return objAV;
        if (methodName === 'find') return elems[0] || UNK;
        return UNK;
      }
      if (methodName === 'sort' && (objAV.k === 't' || objAV.k === 'a')) {
        const elem = objAV.k === 't' ? T(objAV.endpoint, objAV.path)
          : objAV.els.find((e) => e.k !== 'u') || UNK;
        const cb = argAVs[0];
        if (cb && cb.k === 'f') callFunction(cb, [elem, elem], file);
        return objAV;
      }

      // Object.entries / Object.keys / JSON.stringify：枚举式访问 → 弱使用。
      // 同时把父路径从 accessed 里移除：它是被枚举，不是被当作不透明值消费。
      if (objAV.k === 'g' && objAV.name === 'Object' && ['entries', 'keys', 'values'].includes(methodName)) {
        const target = argAVs[0];
        if (target && target.k === 't') {
          const u = getUsage(target.endpoint);
          u.weakSubtrees.add(target.path ? `${target.path}.*` : '*');
          if (target.path) u.accessed.delete(target.path);
        }
        return ARR([]);
      }
      if (objAV.k === 'g' && objAV.name === 'JSON' && methodName === 'stringify') {
        const target = argAVs[0];
        if (target && target.k === 't') {
          const u = getUsage(target.endpoint);
          u.weakSubtrees.add(target.path ? `${target.path}.*` : '*');
          if (target.path) u.accessed.delete(target.path);
        }
        return CON('');
      }

      // 普通成员调用：先取成员再调
      const calleeAV = memberAccess(objAV, keyAV, node.callee.computed, file);
      if (calleeAV.k === 'f') return callFunction(calleeAV, argAVs, file);
      // 未知方法：污点参数按逃逸规则处理
      for (const a of argAVs) consumeArg(a, file);
      if (objAV.k === 't' && methodName === null) {
        getUsage(objAV.endpoint).dynamic.push({ at: objAV.path || '(root)', file: path.basename(file) });
      }
      return UNK;
    }

    // 标识符调用
    if (node.callee.type === 'Identifier') {
      const calleeAV = envGet(env, node.callee.name);
      if (calleeAV.k === 'f') return callFunction(calleeAV, argAVs, file);
      if (calleeAV.k === 'g') {
        // 全局函数：参数里的污点值被消费
        for (const a of argAVs) consumeArg(a, file);
        return UNK;
      }
      // 未知函数（外部导入等）：整对象逃逸记 external
      for (const a of argAVs) consumeArg(a, file);
      return UNK;
    }

    return UNK;
  }

  // ---------- 模式绑定 ----------
  function bindPattern(pat, value, env, file) {
    if (!pat) return;
    switch (pat.type) {
      case 'Identifier':
        env.vars.set(pat.name, value);
        return;
      case 'ObjectPattern': {
        for (const prop of pat.properties) {
          if (prop.type === 'RestElement') {
            bindPattern(prop.argument, value, env, file);
            continue;
          }
          const key = prop.key.type === 'Identifier' ? prop.key.name
            : prop.key.type === 'StringLiteral' ? prop.key.value : null;
          if (key === null) continue;
          const member = memberAccess(value, CON(key), false, file);
          bindPattern(prop.value, member, env, file);
        }
        return;
      }
      case 'ArrayPattern': {
        for (const el of pat.elements) {
          if (!el) continue;
          if (value.k === 't') bindPattern(el, T(value.endpoint, value.path), env, file);
          else bindPattern(el, UNK, env, file);
        }
        return;
      }
      case 'AssignmentPattern':
        bindPattern(pat.left, value, env, file);
        return;
      case 'RestElement':
        bindPattern(pat.argument, value, env, file);
        return;
      default:
        return;
    }
  }

  // ---------- 语句求值 ----------
  function evalStmt(node, env, file) {
    switch (node.type) {
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          const v = decl.init ? evalExpr(decl.init, env, file) : UNK;
          bindPattern(decl.id, v, env, file);
        }
        return;
      case 'ExpressionStatement':
        evalExpr(node.expression, env, file);
        return;
      case 'IfStatement':
        evalExpr(node.test, env, file);
        evalStmt(node.consequent, env, file);
        if (node.alternate) evalStmt(node.alternate, env, file);
        return;
      case 'BlockStatement':
        for (const s of node.body) evalStmt(s, env, file);
        return;
      case 'ForOfStatement': {
        const right = evalExpr(node.right, env, file);
        // 常量数组：每个元素都过一遍；污点数组：元素同构，一个代表即可
        const elems =
          right.k === 't' ? [T(right.endpoint, right.path)]
          : right.k === 'a' ? (right.els.length ? right.els : [UNK])
          : [UNK];
        for (const elem of elems) {
          const loopEnv = newEnv(env);
          if (node.left.type === 'VariableDeclaration') {
            bindPattern(node.left.declarations[0].id, elem, loopEnv, file);
          }
          evalStmt(node.body, loopEnv, file);
        }
        return;
      }
      case 'ForStatement': {
        const loopEnv = newEnv(env);
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') evalStmt(node.init, loopEnv, file);
          else evalExpr(node.init, loopEnv, file);
        }
        if (node.test) evalExpr(node.test, loopEnv, file);
        if (node.update) evalExpr(node.update, loopEnv, file);
        evalStmt(node.body, loopEnv, file);
        return;
      }
      case 'WhileStatement':
        evalExpr(node.test, env, file);
        evalStmt(node.body, env, file);
        return;
      case 'ReturnStatement':
        env.returnVal = node.argument ? evalExpr(node.argument, env, file) : UNK;
        env.hasReturn = true;
        return;
      case 'FunctionDeclaration':
        env.vars.set(node.id.name, FN(node, env, file));
        return;
      case 'TryStatement':
        evalStmt(node.block, env, file);
        if (node.handler) evalStmt(node.handler.body, env, file);
        return;
      case 'ThrowStatement':
        if (node.argument) evalExpr(node.argument, env, file);
        return;
      case 'SwitchStatement': {
        evalExpr(node.discriminant, env, file);
        for (const c of node.cases) {
          if (c.test) evalExpr(c.test, env, file);
          for (const s of c.consequent) evalStmt(s, env, file);
        }
        return;
      }
      default:
        return;
    }
  }

  // ---------- 入口：分析所有非外部模块 ----------
  for (const [file, mod] of modules) {
    if (isExternal(file)) continue;
    const exports = getModuleExports(file);
    // 调用所有导出的函数（参数给未知值），驱动页面级分析
    for (const [, val] of exports) {
      if (val.k === 'f') callFunction(val, [], file);
      if (val.k === 'o') {
        for (const [, m] of val.props) {
          if (m.k === 'f') callFunction(m, [], file);
        }
      }
    }
  }

  // ---------- 汇总：accessed 折叠为"终端访问" ----------
  // user.address.province 会依次访问 address 和 address.province，
  // 中间路径只是路过，不算消费；去掉所有是其他路径前缀的项。
  const result = {};
  for (const [endpoint, u] of usage) {
    const paths = [...u.accessed];
    const terminal = paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(p + '.')));
    result[endpoint] = {
      used: terminal.sort(),
      weakSubtrees: [...u.weakSubtrees].sort(),
      dynamic: u.dynamic,
      external: u.external,
      spreads: u.spreads,
    };
  }
  return result;
}
