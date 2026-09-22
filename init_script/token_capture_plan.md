# WMPFDebugger 自动注入改点草案

## 目标

在不改目标小程序包体的前提下, 扩展 WMPFDebugger, 让它在目标小程序的正确 JS context 就绪后自动执行 `Runtime.evaluate`, 注入 `inject_miniapp_auth_probe.js`。

这条路线的目标非常单一:

- 抢在首页自动 `miniapp/login` 之前挂上 probe
- 不依赖手工打开 DevTools Console 粘贴脚本
- 不改 Frida native hook 偏移和逻辑

## 为什么选这个落点

根据 WMPFDebugger 当前结构, 自动注入最适合落在 `src/index.ts` 的 CDP 桥接层, 而不是 Frida hook 层。

已知结构是:

1. `debug_server()` 负责接收小程序 runtime 发来的 protobuf 调试消息
2. `codex.unwrapDebugMessageData()` 把它解成 JSON 结构
3. 当 `category === "chromeDevtoolsResult"` 时, 现有代码会 `emit("cdpmessage", unwrappedData.data.payload)`
4. `proxy_server()` 负责把 CDP JSON 在浏览器 DevTools 和小程序 runtime 之间转发

因此最自然的扩展方式是:

1. 在 `debug_server()` 里识别 WMPF 暴露的 JS context 生命周期
2. 选择承载 app 逻辑的目标 jscontext
3. 一旦目标上下文可用, 主动向 `debugMessageEmitter` 发一条或几条 CDP 命令
3. 这些命令最终会被原有 `proxymessage -> chromeDevtools -> protobuf` 链路发给小程序 runtime

## 已验证结论

经过实际抓包和手工 Console 复核, 当前版本的关键事实已经比较明确:

1. 不能假设只有一个 JS context
2. 当前版本里不能把 `jscontext_id` 当作可靠主路径
3. 真正的注入目标是根 session 下动态识别出的 app-service context, 而不是 `top`
4. 当前 probe 的稳定实现已经收敛到“以模块 `46` 为主 hook 点”的版本

### 1. `jscontext_id` 在当前版本上不可依赖

在实际日志里, `chromeDevtoolsResult` 的 `jscontextId` 一直是 `undefined`, 同时也没有稳定看到 `addJsContext` / `connectJsContext` 提供可用的上下文选择信息。

这意味着:

- WMPF 私有协议层的 `jscontext_id` 不能作为当前版本的主识别手段
- 自动注入必须退回到标准 CDP 消息本身, 通过 `executionContextId` 动态定位目标

### 2. 目标不是 `top`, 也不是 worker session

实测中可以看到三类候选上下文:

1. 根 session 的页面型 context
2. 根 session 的非页面型 context
3. `Target.attachedToTarget` 之后出现的 worker session context

最终验证结果是:

- 页面型 context 能读到 `location.href = ...page-frame.html`, 对应 `top`
- worker session 有独立 `sessionId`, 但和 DevTools 里看到的 `appContext` 不一致
- 真正目标是根 session 下的非页面型 context

### 3. 当前版本的命中规则已经验证通过

现阶段可靠的目标识别规则是:

1. `sessionId = null`
2. `origin = https://servicewechat.com`
3. `auxData.type = default`
4. `location` 不存在
5. 测试注入后 `hasWx = true`
6. 测试注入后 `hasRequire = true`

在当前版本的验证里, 命中的具体 context 是一次运行中的 `executionContextId = 4`, 但这个编号只对当次运行有效, 不能硬编码。

### 4. 可行性已经用测试脚本验证

为了避免一上来就注入正式 auth probe, 已先在候选 context 中注入一段最小测试脚本:

```ts
(() => {
  const marker = {
    ok: true,
    hasWx: typeof wx !== "undefined",
    hasRequire: typeof require !== "undefined",
    timestamp: Date.now(),
  };
  globalThis.__wmpfDebuggerTestInjection = marker;
  return marker;
})()
```

测试结果表明:

- 命中的目标 context 可以成功执行 `Runtime.evaluate`
- 该 context 中确实存在 `wx` 和 `require`
- 手工在 DevTools Console 中切到 `appContext` 后复核, 结果与自动探针一致

### 5. 当前 probe 本体的实现结论已经变化

最近两次提交之后, `inject_miniapp_auth_probe.js` 的推荐实现已经比最初草案更明确:

1. 模块 `45` 的 `userlogin` 只是薄封装, 最终直接调用模块 `46`
2. 真正持有 URL 补全、`Authorization` 注入、AES/RSA 处理、请求发送、成功响应解密和 Promise resolve/reject 语义的是模块 `46` (`../util/request.js`)
3. 因此当前 probe 的 owning layer 应该是模块 `46`, 而不是模块 `45`
4. 当前脚本仍然保留对 `wx.request` / `uni.request` 的最小包装, 但它的职责已经缩小为补抓原始响应壳, 不再承担主关联逻辑
5. 旧版依赖 `encrypt.js` 多点 hook 和 `pendingEncryptContext` 拼接 `aesKey` / `aesIv` / 密文的方案, 已经不是当前推荐实现

当前版本下, 正式 probe 的主路径应该理解为:

1. 通过模块 `46` 的默认导出创建 login record
2. 直接从被 `request.js` 原地改写后的请求对象里读取:
  - 完整 URL
  - `Authorization`
  - 明文 `data`
  - `aesKey` / `aesIv`
  - `AES-KEY` / `AES-IV`
  - 加密后的 request body
3. 通过最小 `wx.request` / `uni.request` 包装补抓 `rawResponseShell`
4. 优先记录模块 `46` 正常 resolve 出来的解密 JSON; 只有在异常路径下才回退到基于 `encryptApi.aesDecrypt()` 的恢复逻辑

## 不建议修改的部分

当前阶段不建议修改:

- `frida/hook.js`
- `addresses.*.json`
- 任何 native offset 识别逻辑

原因:

- 这些部分负责“能不能调试”
- 我们现在要做的是“调试通了之后自动执行一段 JS”
- 自动注入逻辑完全可以在 TypeScript / WebSocket / CDP 桥接层完成

## 推荐改动位置

### 1. 在 `src/index.ts` 增加基于 CDP 的目标识别状态

当前版本不再建议围绕 `jscontext_id` 建状态, 而是围绕根 session 的 `executionContextId` 建状态。

建议至少跟踪:

- 已探测过的根 session `executionContextId`
- 每个 context 的 `frameId`
- `location.href` 探针结果
- 测试注入结果
- 当前已选中的真实注入目标
- 正式 probe 是否已经注入成功

建议结构:

```ts
const injectionState = {
  nextCommandId: 10_000,
  selectedContext: null as null | {
    sessionId: string | null;
    executionContextId: number;
    frameId: string | null;
  },
  pendingLocationProbes: new Map<number, {
    sessionId: string | null;
    executionContextId: number;
    frameId: string | null;
  }>(),
  pendingTestInjections: new Map<number, {
    sessionId: string | null;
    executionContextId: number;
    frameId: string | null;
  }>(),
  probedContexts: new Set<string>(),
  testedContexts: new Set<string>(),
  probeInjected: false,
};
```

### 2. 保留统一的 `sendCdpCommand()`

虽然不再依赖 `jscontext_id`, 但“主动发 CDP 命令”仍然是第一类能力。

建议统一走现有 `proxymessage` 链路:

```ts
const sendCdpCommand = (command: Record<string, unknown>) => {
  debugMessageEmitter.emit("proxymessage", JSON.stringify(command));
};
```

如果未来需要打到 worker session, 仍然可以在 `command` 顶层带 `sessionId`。

### 3. 先做只读探针, 再做测试注入

当前版本已经验证过, 最稳的顺序是:

1. 看到根 session 的 `Runtime.executionContextCreated`
2. 对候选 context 发 `location.href` 探针
3. 如果返回 `ReferenceError: location is not defined`, 则认定它是非页面候选
4. 再对该候选发最小测试脚本
5. 只有当测试结果同时满足 `hasWx = true` 和 `hasRequire = true` 时, 才把它选为真实注入目标

建议的只读探针:

```ts
Runtime.evaluate({
  expression: "location.href",
  contextId,
  returnByValue: true,
  silent: true,
})
```

建议的测试脚本:

```ts
(() => {
  const marker = {
    ok: true,
    hasWx: typeof wx !== "undefined",
    hasRequire: typeof require !== "undefined",
    timestamp: Date.now(),
  };
  globalThis.__wmpfDebuggerTestInjection = marker;
  return marker;
})()
```

### 4. 目标选择逻辑

当前版本建议用如下逻辑收敛目标:

```ts
if (
  probeValue &&
  typeof probeValue === "object" &&
  probeValue.ok === true &&
  probeValue.hasWx === true &&
  probeValue.hasRequire === true
) {
  injectionState.selectedContext = {
    sessionId,
    executionContextId,
    frameId,
  };
}
```

这一步是关键分界线:

- 命中 `location is not defined` 但没有 `wx` / `require` 的 context 不是目标
- 命中 `wx` 和 `require` 的 context 才是 `appContext`

### 5. 正式注入时机

正式注入 `inject_miniapp_auth_probe.js` 之前, 应该先满足:

1. 已经识别出 `selectedContext`
2. 已经用测试脚本确认该 context 可执行
3. 该次连接内还未注入正式 probe

建议流程:

```ts
const maybeInjectProbe = () => {
  if (!injectionState.selectedContext || injectionState.probeInjected) {
    return;
  }

  sendCdpCommand({
    id: injectionState.nextCommandId++,
    method: "Runtime.evaluate",
    params: {
      expression: PROBE_SOURCE,
      contextId: injectionState.selectedContext.executionContextId,
      includeCommandLineAPI: true,
      awaitPromise: false,
      returnByValue: true,
    },
  });
};
```

注意: 当前版本的目标在根 session 下, 所以实测路径里 `sessionId` 为 `null`。但状态里仍然建议保留 `sessionId` 字段, 避免以后版本切回 worker session 时重构过大。

### 6. 在 `debug_server()` 中处理的关键信号

当前版本真正有区分度的信号是:

- `Runtime.executionContextCreated`
- `Runtime.executionContextDestroyed`
- `Runtime.executionContextsCleared`
- `Target.targetCreated`
- `Target.targetInfoChanged`
- `Target.attachedToTarget`

其中:

- `Target.*` 主要用于确认 worker/session 不是当前目标
- `Runtime.executionContextCreated` 才是根 session 目标识别的入口

### 7. 连接重建时重置状态

当前状态全都是运行时探测结果, 所以必须在 miniapp reconnect 时清空:

```ts
const resetInjectionState = () => {
  injectionState.selectedContext = null;
  injectionState.pendingLocationProbes.clear();
  injectionState.pendingTestInjections.clear();
  injectionState.probedContexts.clear();
  injectionState.testedContexts.clear();
  injectionState.probeInjected = false;
};
```

不要把某次运行中命中的 `executionContextId = 4` 写死到代码里。这个编号只在单次运行中成立, 不能视为稳定常量。

## `PROBE_SOURCE` 怎么准备

建议不要把长脚本直接硬编码在 `src/index.ts` 里。

更稳的方式是:

1. 在 WMPFDebugger 仓库里新增一个 `scripts/` 或 `assets/` 目录
2. 启动时用 `fs.readFile` 读取 `inject_miniapp_auth_probe.js`
3. 把读到的文本原样塞进 `Runtime.evaluate.params.expression`

这样做的好处:

- probe 可以独立迭代
- 不必每次改一行脚本都改 `src/index.ts`
- 更方便把脚本拿出来单独手工验证

## 最小代码骨架

如果把当前已验证路径压缩成最小改点, 大概是这样:

```ts
const injectionState = {
  selectedContext: null,
  probeInjected: false,
  nextCommandId: 10000,
  pendingLocationProbes: new Map(),
  pendingTestInjections: new Map(),
  probedContexts: new Set(),
  testedContexts: new Set(),
};

let probeSource = "";

const sendCdpCommand = (command: Record<string, unknown>) => {
  debugMessageEmitter.emit("proxymessage", JSON.stringify(command));
};

const sendLocationProbe = (executionContextId: number) => {
  sendCdpCommand({
    id: injectionState.nextCommandId++,
    method: "Runtime.evaluate",
    params: {
      expression: "location.href",
      contextId: executionContextId,
      returnByValue: true,
      silent: true,
    },
  });
};

const sendTestInjection = (executionContextId: number) => {
  sendCdpCommand({
    id: injectionState.nextCommandId++,
    method: "Runtime.evaluate",
    params: {
      expression: TEST_INJECTION_EXPRESSION,
      contextId: executionContextId,
      returnByValue: true,
      silent: true,
    },
  });
};

const maybeInjectProbe = () => {
  if (!injectionState.selectedContext || injectionState.probeInjected) return;

  sendCdpCommand({
    id: injectionState.nextCommandId++,
    method: "Runtime.evaluate",
    params: {
      expression: probeSource,
      contextId: injectionState.selectedContext.executionContextId,
      includeCommandLineAPI: true,
      awaitPromise: false,
      returnByValue: true,
    },
  });
};
```

## 我预期它会怎么工作

理想路径应该是:

1. 运行 `npx ts-node src/index.ts`
2. Frida hook 正常附着, miniapp runtime 能连上 debug server
3. 小程序启动后, 根 session 发来多个 `Runtime.executionContextCreated`
4. WMPFDebugger 对候选 context 发 `location.href` 只读探针
5. 返回 `location is not defined` 的 context 被视为非页面候选
6. WMPFDebugger 对这些候选执行最小测试脚本
7. 只有同时具备 `wx` 和 `require` 的 context 被选为真实 appContext
8. 确认目标后, 自动发送 `Runtime.evaluate(PROBE_SOURCE)`
9. probe 在首页自动 `miniapp/login` 前成功挂上
10. 登录过程中的 `Authorization`、明文 `data`、`aesKey`、`aesIv`、密文 body、原始响应、解密结果被写入 `globalThis.__tgtProbe`

## 失败时优先排查什么

### 1. 没有自动注入

优先查:

- 是否真的收到了根 session 的 `Runtime.executionContextCreated`
- `location.href` 探针是否正确区分了页面型和非页面型 context
- 测试脚本是否在候选 context 中成功执行
- 是否真的命中了 `hasWx = true` 且 `hasRequire = true` 的 context
- `maybeInjectProbe()` 是否被调用

### 2. 注入成功但 probe 没抓到 login

优先查:

- `Runtime.evaluate` 是否打到了当前运行中动态识别出的目标 `executionContextId`
- 注入时机是否晚于首页 `login(false)`
- 目标模块 ID `43` / `46` / `47` 在该版本中是否变了
- 模块 `46` 的默认导出是否仍然是 `../util/request.js` 的请求封装入口
- `global.webpackJsonp` 抓 require 的方式在该版本是否仍有效

### 3. 自动注入后 DevTools 还能用, 但结果为空

优先查:

- `Runtime.evaluate` 是否执行成功
- `Runtime.evaluate` 响应里是否存在 `exceptionDetails`
- `globalThis.__tgtProbe` 是否创建成功
- probe 是否真的只过滤了 `/api/wx/miniapp/login`
- 模块 `46` 是否已经在成功路径里直接 resolve 了解密结果, 导致不应继续把旧版 `reject + recover` 观察当成主路径

## 当前建议

如果你下一步真要动 WMPFDebugger, 我建议按下面顺序来:

1. 保留当前动态识别逻辑, 不要硬编码某次运行中的 `executionContextId`
2. 先继续用最小测试脚本验证目标识别和执行路径稳定
3. 测试脚本稳定后, 直接使用当前这版基于模块 `46` 的 `inject_miniapp_auth_probe.js`
4. 如果正式 probe 出现兼容性问题, 优先检查模块 `46` 的请求封装形状是否变更, 再考虑回头调整脚本本体

这个顺序最稳, 出问题时也最好定位。