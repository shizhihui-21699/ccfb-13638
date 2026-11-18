# 接口过度返回检测工具（overreturn-detector）

渗透测试报告里反复出现的问题：接口一次返回整条用户记录，包括前端根本不显示的
内部字段（`passwordHash`、`idCardNumber`、`salary`……）。本工具对照**接口实际返回的字段**
和**前端真正用到的字段**，找出"返回了却从没用过"的字段，自动生成字段裁剪方案，
并跑回归证明裁剪后功能无损。

## 快速开始

```bash
npm install
npm run detect        # 一键：静态分析 → 运行时追踪 → 报告 → 裁剪方案 → 回归
```

分步执行：

```bash
node tool/cli.js analyze   # 静态分析前端字段使用      → report/static.json
node tool/cli.js trace     # 运行时 Proxy 追踪 追踪流程   → report/runtime.json
node tool/cli.js report    # 合并判定 + 敏感定级        → report/report.md
node tool/cli.js plan      # 生成字段裁剪方案           → report/trim-plan.json
node tool/cli.js regress   # 应用方案跑回归             → report/regression.json
```

也可以手动起服务对比：

```bash
npm run demo:server     # 未裁剪，4173 端口
npm run demo:trimmed    # 应用裁剪方案，4174 端口
```

## 为什么单靠静态分析或单靠录制都会误判

前端取字段的方式五花八门，任何一种单一手段都有盲区，所以本工具是**双引擎取并集**：

| 取字段方式 | 静态分析 | 运行时追踪 |
|---|---|---|
| 解构 `const { a } = user` | ✅ 直接识别 | ✅ |
| 展开透传 `{...user}` 给本地组件 | ✅ 顺着 spread 跟进接收方 | ⚠️ 原始值（字符串等）一经拷贝无法继续追踪，靠静态补 |
| 动态键 `user[c.key]` | ✅ 常量可解析则解析；不可解析记 `dynamic` 标记降置信度 | ✅ 真实键名直接落账 |
| 权限/分支专属字段 | ✅ 路径不敏感，分支全覆盖 | ⚠️ 流程没走到就覆盖不到，靠静态补 |
| 第三方组件内部偷读 | ⚠️ 黑盒（`vendor/` 不分析），记 `external` 标记 | ✅ Proxy 拦截真实读取 |
| `Object.entries` / `JSON.stringify` 枚举 | 记 `weakSubtrees` 弱使用 | 记 `weak` 弱使用 |

示例应用里特意安排了互补案例（见 `report/report.md` 的"覆盖说明"）：

- `username` 只有**运行时**能发现（第三方头像组件 `vendor/avatarBadge.js` 内部读取）；
- `loginCount`、`costCenter` 只有**静态**能发现（`auditor` 角色分支，回归流程从不触发）；
- `bio`、`id`、`role` 经展开透传给 `userCard`，原始字符串值拷贝后运行时追踪不到，
  靠静态的 spread 跟进补上。

## 架构

```
sample-app/                  示例应用（故意过度返回）
  server/app.js              零依赖 node:http API；可加载裁剪方案做字段投影
  frontend/                  前端（渲染 HTML 字符串，Node 可跑）
    pages/                   解构 / 展开透传 / 动态键 / 权限分支 / 枚举渲染
    vendor/                  模拟第三方黑盒组件（静态分析排除在外）
    flows.js                 用户流程（运行时追踪 + 回归共用）
tool/
  lib/staticAnalyzer.js      静态引擎：污点式抽象解释器（@babel/parser）
  lib/proxyTracer.js         运行时引擎：Proxy 记录真实读路径
  lib/merge.js               合并两本账 + 判定
  lib/sensitivity.js         敏感分级 P0–P3
  lib/reportGen.js           生成 Markdown 报告
  cli.js                     analyze / trace / report / plan / regress
report/                      全部产物
```

### 静态引擎（tool/lib/staticAnalyzer.js）

一个小型抽象解释器：把 `apiClient` 里发请求的函数识别为污点源，对前端全部模块做
抽象求值，跟踪污点值经过解构、展开、函数参数、动态键之后的每一次属性读取。
路径不敏感（分支全走），宁可多算使用、不可漏算——这是裁剪类工具的安全方向。

### 运行时引擎（tool/lib/proxyTracer.js）

把 API 响应包成 Proxy。关键设计是区分**直接读**和**枚举读**：

- `{...user}`、`Object.entries(user)` 都会触发 `ownKeys` + 一轮 `get`。
  若把这些 `get` 全算作"使用"，展开透传会把所有顶层字段误判为已使用。
  所以 `ownKeys` 之后同一轮的 `get` 记为**枚举读**；
- 被展开拷贝走的对象值仍是子 Proxy，下游组件真正读它时记为**直接读**；
- 只有"直接读且无更深读取"的终端路径算真使用（`user.address.province`
  路过 `address` 不算消费 `address` 整棵子树）；
- 合并时，静态已证明是 `{...obj}` 展开的路径，其下的"仅枚举读"判为
  passthrough 而非弱使用——防止展开透传污染判定。

### 判定与敏感分级

| 判定 | 含义 |
|---|---|
| keep | 静态或运行时确认使用 |
| keep-review | 仅枚举式访问（通用渲染/序列化），保留但建议人工确认 |
| trim | 两边都没见过 → 裁剪候选；若端点存在未解析动态键/外部逃逸调用，置信度降为"需复核" |

敏感分级：**P0** 凭据/金融/证件（passwordHash、idCardNumber、bankCard、ssn）、
**P1** 直接 PII/薪酬（phone、email、salary、address.detail）、
**P2** 内部运营数据（riskScore、internalNotes、lastLoginIp、costCenter）、
**P3** 普通业务字段。`tool/lib/sensitivity.js` 里是正则规则，按自家数据字典扩充即可。

### 裁剪方案与回归

`plan` 生成 `report/trim-plan.json`（每端点 keep/drop 清单），服务端
`TRIM_PLAN=... node sample-app/server/app.js` 即可按白名单投影。
`regress` 做三层验证：

1. 未裁剪基线全流程输出 vs 裁剪后全流程输出，逐字节一致；
2. 被裁字段在裁剪后响应中确实消失；
3. 保留字段一个不少。

> 投影实现有个容易踩的坑：必须按**原记录的键序**重建对象。前端若有
> `Object.entries` 之类的枚举式渲染，键序变了输出就变——回归抓得到。

## 已知局限

- 展开拷贝的**原始值**（字符串/数字）离开 Proxy 后无法继续追踪 → 靠静态引擎补；
- 真·动态键（键名运行时才算出来）静态只能标记，靠运行时补；若流程也没覆盖到，
  该端点的裁剪置信度会自动降级为"需复核"；
- 静态解释器是务实子集（不支持 `eval`、复杂的 this 绑定等），遇到未知模式时
  选择保守（记为使用/标记），不会激进误删；
- 弱使用（枚举式访问）默认保留，因为它可能是真实的通用渲染。
