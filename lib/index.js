// dsh-unity-pool v2 — 会话级 Unity 服务池 + 实例级 MCP 代理。
//
// v2 相对 v1 的核心升级（实例级）：
//  - 每个服务（mcp-for-unity server）上可挂多个 Unity 编辑器实例（PluginHub session，Name@hash）；
//  - 插件从每个服务读 mcpforunity://instances 发现实例，并缓存到服务条目；
//  - 会话绑定的目标从「服务」细化为「实例」：sessionId → {serviceId, instanceId}；
//  - unity_mcp 代理工具：调用前确保本会话的 MCP session（per MCP-Session-Id）active=目标实例
//    （官方 HTTP 模式 active 按 session 隔离，两个会话可同时 target 不同实例，互不干扰），
//    然后转发 tools/call；同一服务上不同会话各自维护独立 MCP 会话，无需全局切换/排队；
//  - unity_pool_scan：触发服务重探 + 实例重读（自动扫描扫描端口段 scanPorts）。
//
// v0.3.7（2026-08-18）忙时等待 + 失败附状态：
//  - unity_mcp 转发前用 execute_code 探测 Unity 编辑器忙状态（isCompiling/isUpdating/Progress），
//    忙（编译/刷新/进度条）则按 busyWaitIntervalMs 间隔重试，总时长不超过 busyMaxWaitMs（默认 10s）；
//    探测失败视为"可能忙"（域重载窗口 execute_code 可能不可用）保守等待后继续；
//  - 调用最终失败（isError）时把最近一次探测状态附到返回 editorState，供调用方判断是否 busy 所致；
//
// v0.3.8→v0.5.1（2026-08-22 设计修正）归档语义：归档 = 会话归档（DSH session/disposed）。
//  - 实例掉线/域重载对已绑定会话是无感的——绑定保持，不做 probe 主动解绑，也不注入通知；
//    真正的实例离线只在「调用时」由 unity_mcp/umcp_* 自动重连并在超时后才返回失败原因。
//  - 唯一自动解绑入口：订阅 session/disposed → 清理该会话锁定的实例（autoUnbindOnArchive 默认开启）；
//  - 调用时实例离线：给足 callReconnectTimeoutMs（默认 20s）让官方服务端的会话重连等待完成，
//    超过才判定实例离线并返回失败原因（不再抛出，调用方可直接看到停机信息）。
//
// v0.4.0（2026-08-19）状态携带（每次发出指令携带 Unity 状态）：
//  - 总开关 stateEnabled + 8 项子开关（stateGameScreenshot/stateSceneScreenshot/stateSelection/
//    stateUiSnapshot/stateSerialized/stateConsoleAll/stateConsoleSelected/stateConsoleError），默认全关；
//  - 后台采集器（startStateTimer，stateRefreshMs 周期）对已绑定会话采集开启项到 stateCaches：
//    game/scene 视图截图（manage_camera include_image，PNG 落盘 stateDir/<sessionId>/）、
//    当前选中项（execute_code 读 Selection）、选中物体 ui-snapshot 与序列化字段
//    （mcpforunity://.../components 资源，均防超长截断）、Console 全文（read_console）与
//    Console 选中条目（反射 ConsoleWindow.m_ActiveText）；
//  - 注册 systemPrompt.context('unity-pool:state')（text 为同步函数，每次 agent request 前求值，
//    读取最近一次采集快照注入上下文；截图给文件路径供 read_image 查看）；
//  - 新增 unity_pool_state 工具（查看/强制刷新快照）；HTTP /api/state、/api/state-refresh、
//    /api/state-switch（运行时切换开关）；view.state / HTTP /api/config 同步返回开关与参数。
//
// v0.5.0（2026-08-21）原生工具注册（Claude 式工具清单）：
//  - 背景：会话「将车身总拼岛迁移A岛界面任务」复盘——code 预设下模型只能经 run_code 调 tools.*，
//    绑定脚本打印子集且字段取错（res.tools?.toolsCount，实际 tools 是顶层数组）→ 模型上下文没有
//    Unity MCP 工具清单 → 盲猜 find_objects → Unknown tool 空转。Claude 侧是 MCP tools/list 全量
//    原生注入，天然有清单；DSH 走 unity_mcp 单工具代理 + 清单靠返回文本，code 模式下再叠打印子集。
//  - 方案：绑定成功后把该服务的 MCP 工具动态注册为 DSH 原生工具（umcp_<工具名>），模型上下文
//    直接可见全部工具名/描述/参数并原生调用（execute 统一转发 proxyMcp，未绑定报错/实例激活/
//    忙等待/未知工具提示全复用）。code 预设的 tools:sdk 声明 / native 预设的工具 schema 都会列出。
//  - 配置：nativeToolsEnabled（默认开）/ nativeToolSchema（compact 省上下文默认 / full 完整 schema）；
//    注册键=服务（syncNativeTools 先清后注），跨服务同名后绑定者接管，stop() 全量注销；
//    工具集合动态变化（Unity 注册/注销、manage_tools）在 bind/重拉 tools/list 时同步刷新。
// v0.5.2（2026-09-01）错误日志携带（编译错误 + 运行时新增错误，同一管线）：
//  - 场景：改脚本触发编译后，编译错误只在 Unity Console 里，Agent 不主动 read_console 就一路盲跑；
//    运行时（Play/请求链）报错同理——两次工具调用之间冒出的红字没人看见。
//  - 方案：每次 unity_mcp/umcp_* 转发「前后各探测一次」（前探测复用忙等待循环的探测，零额外开销；
//    后探测一次 execute_code），探测顺带取 Console 计数（LogEntries.GetCountsByType 反射）；
//    错误计数相对上次上报的游标增长 → 本次调用结果直接带回新增错误明细（read_console types=['error']）；
//    检测到编译跃迁（isCompiling 1→0）时即使无新增错误也回一行「编译完成，无新增错误」。
//  - 去重：游标推进 = 只在一次工具调用中返回一次（同一批错误不会反复刷屏）；Console 被 Clear 时游标回退；
//    会话首次调用只建立基线（不回溯历史错误）；实例切换重置监视。
//  - 上限：默认前 5 条（errorWatchCount），单条 2000 字符（errorWatchMaxChars）截断标注。
// v0.5.7（2026-09-16）每调用实例路由（多实例并存时绑定不再失效）：
//  - 根因：实例选择只靠官方 session-scoped state（set_active_instance 写入、按 MCP-Session-Id 存），
//    而插件只在 client.activeInstance（本地镜像）≠ 绑定实例时才去激活。服务端 MCP 会话一旦被重建
//    （服务重启 / 会话被清理 / 编辑器 Domain Reload），本地镜像仍是陈旧的"已激活"，于是跳过激活，
//    在**没有选择**的新会话上直发 tools/call → 该服务上只有 1 个实例时官方自动选中（掩盖问题），
//    一旦并存 2 个实例就被官方守卫拦死：Multiple Unity instances are connected …（v0.5.6 实测）。
//  - 修复①（主）：每调用路由 —— 每次 tools/call 都携带 unity_instance=<绑定实例>，由官方
//    UnityInstanceMiddleware 在本次调用上直接解析（不依赖 session state）；老服务端不认识该参数时
//    自动降级为只用会话状态（supportsPerCallInstance=false 一次性判定）。
//  - 修复②：activeInstance 镜像与 MCP 会话同生共死（记下镜像属于哪个 session；会话重置即作废），
//    避免"本地以为已激活、服务端其实没有"。
//  - 修复③：unity_mcp(tool='set_active_instance') 不再短路伪造成功，真转发真结果；
//    遇到官方实例选择守卫时显式重建选择重试一次，仍失败则**如实报错**（绝不静默改投其它实例）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import { McpHttpClient, looksLikeInstanceSelectionRequired } from './mcp-client.js'

export const name = 'unity-pool'
export const inject = ['tools', 'webServer', 'systemPrompt']

// ---- 启动 Unity 编辑器（v0.5.8）的纯函数助手 ----

/** 默认 Unity 编辑器安装根目录（按平台；可用 editorRoots 覆盖）。 */
function defaultEditorRoots() {
  if (process.platform === 'win32') {
    return ['C:\\Program Files\\Unity\\Hub\\Editor', 'C:\\Program Files\\Unity\\Editor']
  }
  if (process.platform === 'darwin') return ['/Applications/Unity/Hub/Editor']
  return []
}

/** 展开 ~ 前缀（配置里的路径可能写 ~/.dsh/...）。 */
function expandHome(p) {
  const s = String(p == null ? '' : p)
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homedir(), s.slice(2))
  return s
}

/** 比较 Unity 版本串（2022.3.62f3c1 这类）：按数字段比较，非数字后缀忽略。 */
function compareUnityVersions(a, b) {
  const na = String(a || '').match(/\d+/g) || []
  const nb = String(b || '').match(/\d+/g) || []
  const n = Math.max(na.length, nb.length)
  for (let i = 0; i < n; i++) {
    const x = Number(na[i] || 0)
    const y = Number(nb[i] || 0)
    if (x !== y) return x - y
  }
  return String(a || '').localeCompare(String(b || ''))
}

/** 从编辑器安装目录名（2022.3.62f3c1）或 Unity.exe 路径推断版本号。 */
function versionFromEditorPath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d{4}\.\d+\.\d+[a-z]\d+/i.test(parts[i])) return parts[i]
  }
  return ''
}

/** 读取工程的 Unity 版本（ProjectSettings/ProjectVersion.txt）。 */
function readProjectVersion(projectPath) {
  try {
    const text = fs.readFileSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
    const m = /m_EditorVersion:\s*(\S+)/.exec(text)
    return m ? m[1] : ''
  } catch { return '' }
}

/**
 * 工程里 mcp-for-unity 的安装来源（2026-10-18 用户更正：老岛把 MCP 放在 Assets 里，PC 新版才进 manifest）：
 *  - 'packages' = Packages/manifest.json 或 packages-lock.json 声明了 com.coplaydev.unity-mcp；
 *  - 'assets'   = 源码/副本安装在 Assets（如 Assets/Plugins/CoplayDev/MCPForUnity、Assets/UnityMCP）；
 *  - null       = 未装。
 */
function detectMcpSource(projectPath) {
  for (const rel of ['Packages/manifest.json', 'Packages/packages-lock.json']) {
    try {
      if (/coplaydev|unity-mcp|mcpforunity/i.test(fs.readFileSync(path.join(projectPath, rel), 'utf8'))) return 'packages'
    } catch { /* 缺文件继续看下一个 */ }
  }
  // Assets 内安装：先看已知路径，再兜底扫 Assets 顶层与 Assets/Plugins（最多两层，避免全盘递归）
  const known = [
    'Assets/Plugins/CoplayDev/MCPForUnity',
    'Assets/MCPForUnity',
    'Assets/Plugins/MCPForUnity',
  ]
  for (const rel of known) {
    try { if (fs.statSync(path.join(projectPath, rel)).isDirectory()) return 'assets' } catch { /* 不存在继续 */ }
  }
  const roots = ['Assets', 'Assets/Plugins', 'Assets/Editor']
  for (const rel of roots) {
    let dirs = []
    try { dirs = fs.readdirSync(path.join(projectPath, rel), { withFileTypes: true }) } catch { continue }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      if (/^mcpforunity$/i.test(d.name)) return 'assets'
      if (/^coplaydev$/i.test(d.name)) {
        try {
          const inner = fs.readdirSync(path.join(projectPath, rel, d.name), { withFileTypes: true })
          if (inner.some(x => x.isDirectory() && /^mcpforunity$/i.test(x.name))) return 'assets'
        } catch { /* ignore */ }
      }
    }
  }
  return null
}

/** 工程是否带 mcp-for-unity（manifest 或 Assets 内安装，见 detectMcpSource）。 */
function projectHasMcpPackage(projectPath) {
  return detectMcpSource(projectPath) !== null
}

// ---- 模态窗（v0.5.8 增强）----
// Windows 下 Unity 的模态对话框（版本不匹配、保存场景、确认框…）是 Win32 原生 #32770 窗口。
// 用 PowerShell + Add-Type 枚举目标进程的可见 #32770 窗口，取标题/静态文本/按钮，
// 选项点击用 BM_CLICK。其它平台暂不支持（返回 supported:false）。
const WIN_DIALOG_PS = [
  'Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Text;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'public class DlgChild { public long Hwnd { get; set; } public string Text { get; set; } public string ClassName { get; set; } public int Id { get; set; } public bool Enabled { get; set; } }',
  'public class DlgInfo { public long Hwnd { get; set; } public uint Pid { get; set; } public string Title { get; set; } public string ClassName { get; set; } public List<DlgChild> Children { get; set; } }',
  'public static class DlgApi {',
  '  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
  '  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hWnd);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);',
  '  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hWnd);',
  '  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);',
  '  static string Text(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }',
  '  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }',
  '  public static List<DlgInfo> List(int[] pids) {',
  '    var set = new HashSet<uint>(); if (pids != null) foreach (var p in pids) set.Add((uint)p);',
  '    var result = new List<DlgInfo>();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      if (set.Count > 0 && !set.Contains(pid)) return true;',
  '      if (!IsWindowVisible(h)) return true;',
  '      string cls = Cls(h);',
  '      if (cls != "#32770") return true;',
  '      var info = new DlgInfo { Hwnd = h.ToInt64(), Pid = pid, Title = Text(h), ClassName = cls, Children = new List<DlgChild>() };',
  '      EnumChildWindows(h, delegate(IntPtr ch, IntPtr l2) {',
  '        string cc = Cls(ch); string t = Text(ch);',
  '        if ((cc == "Button" || cc == "Static") && !String.IsNullOrEmpty(t)) {',
  '          info.Children.Add(new DlgChild { Hwnd = ch.ToInt64(), Text = t, ClassName = cc, Id = GetDlgCtrlID(ch), Enabled = IsWindowEnabled(ch) });',
  '        }',
  '        return true;',
  '      }, IntPtr.Zero);',
  '      result.Add(info);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return result;',
  '  }',
  '  public static bool Click(long hwnd) { SendMessage((IntPtr)hwnd, 0x00F5, IntPtr.Zero, IntPtr.Zero); return true; }',
  '}',
  '\'@',
  '$pids = @(__PIDS__)',
  '$list = [DlgApi]::List([int[]]$pids)',
  'if ($list.Count -eq 0) { "[]" } else { ConvertTo-Json -InputObject $list -Depth 6 -Compress }',
].join('\n')

const WIN_CLOSE_PS = [
  'Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class DlgClose { [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); public static bool Close(long h) { PostMessage((IntPtr)h, 0x0010, IntPtr.Zero, IntPtr.Zero); return true; } }',
  '\'@',
  '[DlgClose]::Close(__HWND__) | Out-Null',
].join('\n')

const WIN_CLICK_PS = [
  'Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class DlgClick { [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); public static bool Click(long h) { SendMessage((IntPtr)h, 0x00F5, IntPtr.Zero, IntPtr.Zero); return true; } }',
  '\'@',
  '[DlgClick]::Click(__HWND__) | Out-Null',
].join('\n')

/**
 * Temp/UnityLockfile 是否被 Unity 独占持有（Windows：Unity 以独占句柄打开，能 r+ 打开 = 没人持有）。
 * 用来区分「编辑器真的开着」与「崩溃/强杀留下的陈旧锁文件」。
 */
function lockFileHeld(lockFile) {
  if (!lockFile) return false
  let fd = null
  try {
    fd = fs.openSync(lockFile, 'r+')
    return false
  } catch {
    // EBUSY/EPERM/EACCES：文件被占用（或无权打开）→ 视为有进程持有；ENOENT 也返回 true，调用方另有 existsSync
    return true
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 规范化配置里的工程清单条目（去重、展开 ~）。 */
function normalizeProjects(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '').trim()
    const p = String(item.path || '').trim()
    if (!name || !p || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      path: expandHome(p),
      version: String(item.version || '').trim(),
      serviceId: String(item.serviceId || '').trim(),
    })
  }
  return out
}

export const Config = z.object({
  /** 服务池条目：每个 mcp-for-unity server 一个服务（id 唯一、url 为 MCP 端点）。 */
  services: z.array(z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    /** v0.5.8：可选的服务启动命令（服务离线时由 unity_pool_launch 拉起，如 uvx mcp-for-unity --transport http）。 */
    startCommand: z.array(z.string()).default([]),
  })).default([
    { id: 'unity-8080', name: 'Unity 8080', url: 'http://127.0.0.1:8080/mcp' },
  ]),
  /** 会话绑定持久化文件。 */
  dataFile: z.string().default(path.join(homedir(), '.dsh', 'unity-pool-state.json')),
  /** 服务存活探测 + 实例发现间隔（毫秒）。 */
  probeIntervalMs: z.number().default(10000),
  /** 单次 MCP 请求超时（毫秒）。 */
  probeTimeoutMs: z.number().default(3000),
  /** unity_pool_scan 时额外探测的端口段（自动扫描；空则不扫）。 */
  scanPorts: z.array(z.number()).default([8080, 8081, 8082, 8083, 8084, 8090]),
  /** 单个候选端口（握手 + 实例发现）的总时长上限（毫秒；0/缺省 = 自动 = max(2000, probeTimeoutMs×2)）。
   *  端口上挂着「只回响应头不收尾」的服务时，本上限保证扫描跳过该端口而不是卡死。 */
  scanPortTimeoutMs: z.number().default(0),
  /** unity_pool_scan 工具/HTTP 接口的总时长上限（毫秒，默认 20s）：
   *  超时返回已完成部分 + timedOut 标记（绝不出现「工具调用一直运行中」）。 */
  scanTimeoutMs: z.number().default(20000),
  /** 会话首次查询/绑定未指定实例时，自动分配一个可用实例。 */
  autoAssign: z.boolean().default(true),
  /** 并行开发同一实例是正常用法：force 默认 true（默认可并行绑定，不拒绝）。
   *  enforceExclusive 仅在「显式传 force=false」时才生效：同一实例已被其他会话绑定时拒绝并行绑定。 */
  enforceExclusive: z.boolean().default(true),
  /** 连接提示：agent 如何用绑定服务+实例工作（unity_mcp 代理即连接方式）。 */
  connectHint: z.string().default(''),
  /** unity_mcp 调用前是否探测 Unity 编辑器忙状态并等待（编译/刷新期间自动等待，最长 busyMaxWaitMs）。 */
  busyWaitEnabled: z.boolean().default(true),
  /** 忙时等待总时长上限（毫秒），默认 10 秒。 */
  busyMaxWaitMs: z.number().default(10000),
  /** 忙时等待的探测间隔（毫秒）。 */
  busyWaitIntervalMs: z.number().default(500),
  /** 会话归档（DSH session/disposed）时自动解绑该会话锁定的实例（默认开启）。
   *  【设计语义】实例掉线/域重载对已绑定会话是无感的——绑定保持，不做 probe 主动解绑，也不注入通知；
   *  真正的实例离线只在「调用时」由 unity_mcp/umcp_* 自动重连并在超时后返回失败原因（见 callReconnectTimeoutMs）。 */
  autoUnbindOnArchive: z.boolean().default(true),
  /** 调用时实例离线的重连/等待时长（毫秒，默认 20s）：unity_mcp/umcp_* 路由到实例时，若实例处于
   *  域重载/掉线窗口，给足超时让官方 mcp-for-unity 服务端的会话重连等待（默认 20s）完成；
   *  超过该时长仍未连接则判定实例离线，返回调用失败原因。 */
  callReconnectTimeoutMs: z.number().default(20000),

  // ---- 启动 Unity 编辑器（v0.5.8）----
  // 目标：Agent / 客户端一条指令就能把工程打开，并等 MCP 实例出现后自动绑定。
  /** 是否允许 unity_pool_launch / 客户端「启动 Unity」入口（默认开）。 */
  launchEnabled: z.boolean().default(true),
  /** 工程清单：name = 调用/界面上的名字，path = 工程绝对路径；version/serviceId 可省略。 */
  projects: z.array(z.object({
    name: z.string(),
    path: z.string(),
    version: z.string().default(''),
    serviceId: z.string().default(''),
  })).default([]),
  /** 显式 Unity.exe 路径（优先于 editorRoots 扫描；可写多个版本）。 */
  editorPaths: z.array(z.string()).default([]),
  /** Unity Hub 编辑器安装根目录（Windows 默认 C:\Program Files\Unity\Hub\Editor）。 */
  editorRoots: z.array(z.string()).default(defaultEditorRoots()),
  /** 工程版本与已装版本不一致时是否允许用已装版本打开（默认允许；false = 直接报错）。 */
  allowVersionMismatch: z.boolean().default(true),
  /** 是否允许 projectPath 启动配置清单之外的工程（默认允许）。 */
  allowAnyProject: z.boolean().default(true),
  /** 启动日志目录（每个工程一个 -logFile 落这里；缺省 ~/.dsh/unity-pool-launch）。 */
  launchLogDir: z.string().default(path.join(homedir(), '.dsh', 'unity-pool-launch')),
  /** 启动后等待实例出现的上限（毫秒，默认 120s）；超时返回 ready:false（编辑器通常仍在导入）。 */
  launchWaitReadyMs: z.number().default(120000),
  /** 等待实例出现的轮询间隔（毫秒，默认 2000）。 */
  launchPollIntervalMs: z.number().default(2000),
  /** 追加到 Unity 命令行的额外参数（如 -force-vulkan）。 */
  launchArgs: z.array(z.string()).default([]),
  /** 启动等待期间是否检测 Unity 模态窗（版本不匹配/保存确认等），检测到就提前返回选项（默认开）。 */
  launchDialogCheckEnabled: z.boolean().default(true),
  /** 启动后多久开始查模态窗（毫秒，默认 8s；避免把启动过程中的瞬时窗口当阻塞）。 */
  launchDialogCheckAfterMs: z.number().default(8000),
  /** 后台周期扫描模态窗（默认开；只在有 Unity 运行时才真的调 PowerShell），结果进 view.dialogs。 */
  dialogWatchEnabled: z.boolean().default(true),
  /** 模态窗扫描间隔（毫秒，默认 10s）。 */
  dialogPollIntervalMs: z.number().default(10000),
  /** 自动处理规则：{match:'标题/正文包含', option:'按钮文案'} 或 {match, close:true}（默认空 = 不自动点）。 */
  autoDismissDialogs: z.array(z.object({
    match: z.string(),
    option: z.string().default(''),
    close: z.boolean().default(false),
  })).default([]),
  /** MCP 调用因掉线失败时，是否按 autoDismissDialogs 自动处理模态窗（默认关；开了只处理匹配规则）。 */
  autoDismissOnMCPFailure: z.boolean().default(false),
  /** 拉起的服务（services[].startCommand）等待监听的上限（毫秒，默认 30s；超时返回 alive:false + 日志）。 */
  serverStartWaitMs: z.number().default(30000),
  /** unity_pool_close 优雅关闭编辑器的等待上限（毫秒，默认 15s；超时返回 stillRunning，需 force=true 强杀）。 */
  closeWaitMs: z.number().default(15000),
  /** unity_pool_close 后是否停掉「在线且没有任何 Unity 实例」的服务（默认 true：收掉残留的 uvx/终端；false = 保留服务）。 */
  closeStopsServer: z.boolean().default(true),

  // ---- 状态携带（v0.4.0）----
  // 总开关 + 每项单独开关，默认全关。开启后每次 agent 指令前把对应项注入运行时上下文：
  //  game/scene 视图截图（PNG 落盘 stateDir）、当前选中项、选中物体 ui-snapshot 与序列化字段、
  //  Console 全文与选中条目。截图在上下文里给文件路径（模型可按需 read_image 查看）。
  /** 状态携带总开关：开启后采集并注入下述各项状态（默认关）。 */
  stateEnabled: z.boolean().default(false),
  /** Game 视图截图。 */
  stateGameScreenshot: z.boolean().default(false),
  /** Scene 视图截图。 */
  stateSceneScreenshot: z.boolean().default(false),
  /** Hierarchy / Project 视图当前选中项（名称/类型/instanceID/路径/资产路径）。 */
  stateSelection: z.boolean().default(false),
  /** 选中物体（GameObject）的 ui-snapshot 结构快照（需实例注册了 ui_snapshot 工具，如 LBTools）。 */
  stateUiSnapshot: z.boolean().default(false),
  /** 选中物体的序列化字段内容（components 资源，按 stateMaxChars 截断防超长）。 */
  stateSerialized: z.boolean().default(false),
  /** Console 全文（最近 stateConsoleCount 条，按 stateConsoleMaxChars 截断）。 */
  stateConsoleAll: z.boolean().default(false),
  /** Console 当前选中条目内容（反射 ConsoleWindow，按 stateConsoleMaxChars 截断）。 */
  stateConsoleSelected: z.boolean().default(false),
  /** Console 错误（仅 error 级条目，最近 stateConsoleCount 条，按 stateConsoleMaxChars 截断）。 */
  stateConsoleError: z.boolean().default(false),
  /** 状态采集间隔（毫秒）：后台对已绑定会话按开启项周期采集，写入缓存供每轮注入。 */
  stateRefreshMs: z.number().default(3000),
  /** 截图最长边分辨率上限（像素），控制 PNG 体积（默认 640）。 */
  stateScreenshotMaxRes: z.number().default(640),
  /** 状态产物（截图 PNG）落盘目录，每会话一个子目录；缺省 ~/.dsh/unity-pool-state。 */
  stateDir: z.string().default(path.join(homedir(), '.dsh', 'unity-pool-state')),
  /** 通用文本项（选中项/序列化字段）最大字符数，超出截断并标注（防超长）。 */
  stateMaxChars: z.number().default(8000),
  /** ui-snapshot 快照最大字符数（按树/引用/被引用预算分配，保证引用明细可见；默认 8000）。 */
  stateSnapshotMaxChars: z.number().default(8000),
  /** Console 文本（全文/选中）最大字符数。 */
  stateConsoleMaxChars: z.number().default(6000),
  /** Console 全文读取条数。 */
  stateConsoleCount: z.number().default(50),
  /** 截图按需刷新节流（毫秒，默认 10s）：截图会让 Unity 窗口闪烁/任务栏提醒，
   *  不参与后台 3s 轮询；改为注入（发消息）时发现截图过期（距上次截图 ≥ 本值）才异步补采一次。 */
  screenshotStaleMs: z.number().default(10000),
  /** 冷启动补齐等待上限（毫秒，默认 4000；0 = 关闭）：
   *  systemPrompt.context.text 是同步函数、只能读已有缓存，而采集是异步的——新会话 / 插件重启 /
   *  刚打开开关时缓存为空，首回合会整段没有状态块。开启后装配阶段（system-prompt/assemble 瀑布）
   *  发现有状态携带但无缓存时，有界等待一次采集再就地补上状态块。 */
  stateFirstTurnWaitMs: z.number().default(4000),
  /** 冷启动补齐的冷却（毫秒，默认 10000）：采集失败（Unity 离线/繁忙）后这段时间内不再重复等待，
   *  避免每一步都卡住。 */
  stateCollectCooldownMs: z.number().default(10000),

  // ---- 原生工具注册（v0.5.0，2026-08-21）----
  // 绑定后把该服务的 MCP 工具动态注册为 DSH 原生工具（umcp_<工具名>），
  // 模型上下文直接可见工具清单并可原生调用（Claude 式体验），不再依赖 bind 返回文本。
  // 根因（2026-08-21 会话「将车身总拼岛迁移A岛界面任务」复盘）：code 预设下模型只能经
  // run_code 调 tools.*，绑定脚本打印子集且字段取错 → 上下文没有工具清单 → 盲猜 find_objects。
  // 原生注册后 code 预设的 tools:sdk 声明 / native 预设的工具 schema 都会列出全部工具。
  /** 绑定成功后把该服务的 MCP 工具动态注册为原生工具（umcp_<tool>），默认开启。 */
  nativeToolsEnabled: z.boolean().default(true),
  /** 原生工具参数 schema 形态：compact=只带参数名+description（省上下文，参数不校验，由 Unity 侧 pydantic 裁决，默认）；
   *  full=完整 inputSchema（与 Claude 注册 MCP 工具一致，参数校验最全但上下文开销大）。 */
  nativeToolSchema: z.string().default('compact'),

  // ---- 错误日志携带（v0.5.2，2026-09-01）----
  // 每次 unity_mcp/umcp_* 调用「前后各探测一次」Unity 状态（前探测复用忙等待循环，后探测一次 execute_code）：
  // 探测顺带取 Console 各类计数；错误计数相对上次上报游标增长 → 本次调用结果直接带回新增错误明细；
  // 检测到编译跃迁（isCompiling 1→0）即使无新增错误也回一行「编译完成，无新增错误」。同一批只返回一次。
  /** 工具调用前后检查 Console 错误增量与编译事件，并把新增错误随本次调用结果返回（默认开启）。 */
  errorWatchEnabled: z.boolean().default(true),
  /** 单次最多携带的新增错误条数（默认 5：取新增批次里最早的 5 条，编译错误按报错顺序）。 */
  errorWatchCount: z.number().default(5),
  /** 单条错误文本最大字符数（默认 2000，超出截断并标注）。 */
  errorWatchMaxChars: z.number().default(2000),
  /** 拉取新增错误明细时最多读取的 Console 条数（防超大批次拖慢，默认 50）。 */
  errorWatchFetchMax: z.number().default(50),
  /** 新增错误明细是否带堆栈（默认 true：运行时错误靠堆栈定位；单条仍受 errorWatchMaxChars 截断）。 */
  errorWatchStacktrace: z.boolean().default(true),

  // ---- 工具排序（v0.5.4，2026-09-01）----
  /** 工具清单里把「本工程自定义工具」排在官方 mcp-for-unity 工具之前（默认开）。
   *  自定义工具名取自官方资源 mcpforunity://custom-tools（按当前激活实例，即本工程注册的工具）；
   *  影响：unity_pool_bind 返回的 tools、unity_pool_status 的工具名速查、umcp_* 原生工具注册顺序、
   *  未知工具错误里的可用工具名提示。老服务端没有该资源时自动退化为服务端原序。 */
  customToolsFirst: z.boolean().default(true),
})

const DEFAULT_CONNECT_HINT = '调用 unity_mcp(tool=..., params=...) 代理 MCP 工具调用；插件自动确保本会话目标实例激活。'

function normalizeUrl(url) {
  const s = String(url ?? '').trim()
  if (!s) return s
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : 'http://' + s
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 给任意 promise 加硬上限（超时 reject，err.timedOut=true）。
 * 用途：网络路径已有各自的请求超时，但「一条链路被未知的 await 挂住」这类问题会以
 * 「工具调用永远运行中」的形式暴露给用户——这里给探测/扫描等整段流程兜底，
 * 保证 unity_pool_scan 一定在预算内返回（返回已完成的部分 + timedOut 标记）。
 */
function withTimeout(promise, ms, label) {
  const budget = Number(ms) > 0 ? Number(ms) : 1
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error((label ? label + '：' : '') + '超时(' + budget + 'ms)')
        err.timedOut = true
        reject(err)
      }, budget)
      if (timer.unref) timer.unref()
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 统一的「探测 + 端口扫描」执行器（unity_pool_scan 工具与 HTTP /api/scan 共用）。
 * 总预算 = cfg.scanTimeoutMs（默认 20s）：超时返回已完成部分 + timedOut 标记，
 * 绝不出现「工具调用/接口一直运行中」。
 */
async function runPoolScan(pool) {
  const budget = Number(pool.cfg.scanTimeoutMs) > 0 ? Number(pool.cfg.scanTimeoutMs) : 20000
  let found = []
  let scanRan = false
  try {
    await withTimeout(pool.probe(), budget, '服务池探测')
    scanRan = true
    found = await withTimeout(pool.scan(), budget, '端口扫描')
    return { found, timedOut: false, error: null, scanRan }
  } catch (err) {
    return { found, timedOut: Boolean(err && err.timedOut), error: String(err?.message ?? err), scanRan }
  }
}

/** 状态携带开关键（持久化与 setStateSwitch 共用）。 */
const STATE_SWITCH_KEYS = ['stateEnabled', 'stateGameScreenshot', 'stateSceneScreenshot', 'stateSelection', 'stateUiSnapshot', 'stateSerialized', 'stateConsoleAll', 'stateConsoleSelected', 'stateConsoleError']

// Unity 把「脚本引用缺失（missing script）」按 Error 报给 mcp-for-unity，但 Console 里显示为黄色警告（warning），
// 并非真错误——consoleError 采集时按 Unity 固定文案剔除，避免把缺脚本警告混进「Console 错误」。
const UNITY_MISSING_SCRIPT_RE = /(The referenced script \([^)]*\) on this Behaviour is missing|is missing or no valid script is attached)/i

// Console 选中条目反射代码。
// 2026-08-20 实测（Unity 2022.3.62f2c1）：m_ActiveText 只在「双击激活」条目时更新，单击选中读不到——
// 改用 m_LastActiveEntryIndex（单击选中即更新）+ LogEntries.GetEntryInternal（internal，需遍历 GetMethods
// 查找；GetMethod(name, types) 对 internal 类型+ByRef 参数匹配不到）读选中行 message（含完整文本与堆栈）。
const CONSOLE_SELECTED_CODE = [
  'var sb=new System.Text.StringBuilder();',
  'try{',
  '  var asm=typeof(UnityEditor.EditorWindow).Assembly;',
  '  var cwType=asm.GetType("UnityEditor.ConsoleWindow");',
  '  if(cwType==null){sb.Append("NO_CONSOLE_WINDOW");return sb.ToString();}',
  '  var wins=UnityEngine.Resources.FindObjectsOfTypeAll(cwType);',
  '  if(wins==null||wins.Length==0){sb.Append("NO_CONSOLE_WINDOW");return sb.ToString();}',
  '  var cw=wins[0];',
  '  var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;',
  '  var fIdx=cwType.GetField("m_LastActiveEntryIndex",flags);',
  '  var idx=fIdx!=null?(int)fIdx.GetValue(cw):-1;',
  '  if(idx<0){sb.Append("(Console 未选中任何条目)");return sb.ToString();}',
  '  var leType=asm.GetType("UnityEditor.LogEntries");',
  '  var entryType=asm.GetType("UnityEditor.LogEntry");',
  '  if(leType==null||entryType==null){sb.Append("(LogEntries 类型不可用)");return sb.ToString();}',
  '  var bf=System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.Public|System.Reflection.BindingFlags.NonPublic;',
  '  System.Reflection.MethodInfo getM=null;',
  '  foreach(var m in leType.GetMethods(bf)){if(m.Name=="GetEntryInternal"){getM=m;break;}}',
  '  if(getM==null){sb.Append("(GetEntryInternal 不可用)");return sb.ToString();}',
  '  try{leType.GetMethod("StartGettingEntries",bf).Invoke(null,null);}catch{}',
  '  var entry=System.Activator.CreateInstance(entryType);',
  '  var args=new object[]{idx,entry};',
  '  bool ok=false;',
  '  try{ok=(bool)getM.Invoke(null,args);}catch{}',
  '  entry=args[1];',
  '  if(ok&&entry!=null){',
  '    var msgF=entryType.GetField("message");',
  '    var fileF=entryType.GetField("file");',
  '    var lineF=entryType.GetField("line");',
  '    var txt=msgF!=null?(string)msgF.GetValue(entry):null;',
  '    var file=fileF!=null?(string)fileF.GetValue(entry):null;',
  '    var line=lineF!=null?(int)lineF.GetValue(entry):0;',
  '    if(!string.IsNullOrEmpty(txt)){',
  '      sb.Append(txt.Length>6000?txt.Substring(0,6000):txt);',
  '      if(!string.IsNullOrEmpty(file)){sb.Append(System.Environment.NewLine).Append("(at ").Append(file).Append(":").Append(line).Append(")");}',
  '    }else{sb.Append("(条目文本为空)");}',
  '  }else{sb.Append("(Console 未选中任何条目)");}',
  '  try{leType.GetMethod("EndGettingEntries",bf).Invoke(null,null);}catch{}',
  '}catch(System.Exception ex){sb.Append("ERR: ").Append(ex.GetType().Name).Append(": ").Append(ex.Message);}',
  'return sb.ToString();',
].join('')

function formatProp(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Unity 内置组件白名单（不在白名单的组件视为业务/自定义组件，快照地图优先呈现）。 */
const BUILTIN_COMPONENTS = new Set([
  'Transform', 'RectTransform', 'CanvasRenderer', 'Canvas', 'CanvasGroup', 'GraphicRaycaster', 'CanvasScaler',
  'Image', 'RawImage', 'Text', 'TextMeshProUGUI', 'TextMeshPro', 'Button', 'Dropdown', 'ScrollRect', 'Scrollbar',
  'Mask', 'RectMask2D', 'Toggle', 'ToggleGroup', 'Slider', 'InputField', 'TMP_InputField', 'EventTrigger',
  'VerticalLayoutGroup', 'HorizontalLayoutGroup', 'GridLayoutGroup', 'LayoutElement', 'ContentSizeFitter',
  'AspectRatioFitter', 'Outline', 'Shadow', 'Graphic', 'Selectable', 'MonoBehaviour', 'Behaviour', 'Component',
  'UIMask', 'RectTransformUtility',
])

/** 引用噪音字段（资源/自引用类，地图模式聚合为计数而非逐条）。 */
const NOISE_REF_FIELDS = new Set([
  'm_Sprite', 'm_Font', 'm_Material', 'm_Image', 'm_TargetGraphic', 'm_HighlightedSprite', 'm_DisabledSprite',
  'm_PressedSprite', 'm_SelectedSprite', 'mainTexture', 'm_Texture', 'overrideSprite', 'm_Color', 'm_RaycastTarget',
  'm_Maskable', 'm_Content', 'm_Viewport', 'm_VerticalScrollbar', 'm_HorizontalScrollbar', 'm_HandleRect',
])

/**
 * 快照地图模式（v0.4.1，2026-08-20 用户设计指导：超大快照违背「一次快照+少量工具调用」初衷）：
 * 不再平铺截断树，而是基于 Library JSON 生成**分层地图**——概览 / 分支索引 / 业务引用 / 锚点索引 / 定位指引。
 * Agent 用地图定位（id/名字），再以 1~2 次定向工具调用（ui_snapshot(ids)/components）取局部细节，
 * 从而以最小上下文 + 最少探路式思考找到答案。
 */
function buildUiSnapshotMap(snap, maxChars) {
  const budget = Math.max(400, Number(maxChars) > 0 ? Number(maxChars) : 8000)
  const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
  const refs = Array.isArray(snap.refs) ? snap.refs : []
  if (nodes.length === 0) return ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map()
  for (const n of nodes) {
    const p = n.parentId
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(n)
  }
  const refsBySource = new Map()
  for (const r of refs) {
    if (!refsBySource.has(r.sourceId)) refsBySource.set(r.sourceId, [])
    refsBySource.get(r.sourceId).push(r)
  }
  const backCount = new Map()
  for (const r of refs) {
    const t = r.targetGoId ?? r.targetId
    if (t !== undefined && t !== null) backCount.set(t, (backCount.get(t) || 0) + 1)
  }

  // 子树信息：{size, outRefs, backRefs, custom:Set, depth}
  const infoMap = new Map()
  const info = (id) => {
    if (infoMap.has(id)) return infoMap.get(id)
    const kids = childrenOf.get(id) || []
    let size = 1
    let outRefs = 0
    const custom = new Set()
    for (const k of kids) {
      const ki = info(k.id)
      size += ki.size
      outRefs += ki.outRefs
      for (const c of ki.custom) custom.add(c)
    }
    const n = byId.get(id)
    if (n && Array.isArray(n.components)) {
      for (const c of n.components) if (!BUILTIN_COMPONENTS.has(c)) custom.add(c)
    }
    outRefs += (refsBySource.get(id) || []).length
    const r = { size, outRefs, custom }
    infoMap.set(id, r)
    return r
  }
  for (const n of nodes) info(n.id)

  const roots = (Array.isArray(snap.roots) ? snap.roots : []).map(r => byId.get(r)).filter(Boolean)
  const rootNames = roots.map(r => '[' + r.id + ']' + (r.name || '')).join(' / ') || '（无根）'
  // 被引用数：JSON 无 backrefs 数组，从 refs 的目标去重统计（2026-08-20 地图模式修正）
  const backTotal = new Set(refs.map(r => r.targetGoId ?? r.targetId).filter(v => v !== undefined && v !== null)).size

  // ---- 段1：概览 + 根 + 分支索引 ----
  const s1 = []
  s1.push('# UI Snapshot 地图：' + nodes.length + ' 节点 / ' + refs.length + ' 引用 / ' + backTotal + ' 被引用')
  s1.push('根: ' + rootNames)
  const topIds = roots.length > 0 ? (childrenOf.get(roots[0].id) || []).map(k => k.id) : (childrenOf.get(null) || []).map(k => k.id)
  const topNodes = topIds.map(id => byId.get(id)).filter(Boolean)
  if (topNodes.length > 0) {
    s1.push('\n分支（名称 | 节点数 | 出引用 R | 自定义组件）:')
    const ranked = topNodes.map(n => {
      const i = info(n.id)
      return { n, size: i.size, out: i.outRefs, custom: [...i.custom].sort() }
    }).sort((a, b) => b.size - a.size)
    for (const t of ranked.slice(0, 14)) {
      const customTxt = t.custom.length > 0 ? ' | ' + t.custom.join(',') : ''
      s1.push('- [' + t.n.id + '] ' + (t.n.name || '?') + ' [' + t.size + ' 节点 R:' + t.out + ']' + customTxt)
    }
    if (ranked.length > 14) s1.push('… 还有 ' + (ranked.length - 14) + ' 个分支')
  }

  // ---- 段2：业务引用（噪音优先聚合计数；自定义组件字段全量；Unity 关键行为字段保留） ----
  const s2 = []
  const bizRefs = []
  const noiseCount = new Map() // 噪音聚合：component.field -> count
  for (const r of refs) {
    const comp = r.sourceComponent || ''
    const field = r.field || ''
    const isNoise = NOISE_REF_FIELDS.has(field) || r.targetKind === 'Asset' || (field.startsWith('m_') && !/m_OnClick/.test(field))
    if (isNoise) {
      noiseCount.set(comp + '.' + field, (noiseCount.get(comp + '.' + field) || 0) + 1)
    } else {
      const isCustom = !BUILTIN_COMPONENTS.has(comp)
      if (isCustom || /m_OnClick|m_Template|m_CaptionText|m_ItemText|m_Content|m_Viewport|m_VerticalScrollbar|m_HandleRect/.test(field)) {
        bizRefs.push(r)
      } else {
        noiseCount.set(comp + '.' + field, (noiseCount.get(comp + '.' + field) || 0) + 1)
      }
    }
  }
  if (bizRefs.length > 0) {
    s2.push('业务引用（组件.字段 -> 目标）:')
    const seen = new Set()
    for (const r of bizRefs) {
      const src = byId.get(r.sourceId)
      const key = (src ? src.id : r.sourceId) + '.' + (r.sourceComponent || '') + '.' + (r.field || '') + '->' + (r.targetGoId ?? r.targetId ?? '')
      if (seen.has(key)) continue
      seen.add(key)
      const tgt = r.targetGoId ?? r.targetId
      const tgtNode = tgt !== undefined && tgt !== null ? byId.get(tgt) : null
      const targetTxt = r.targetKind === 'Asset' ? (r.assetPath || 'asset')
        : tgtNode ? tgtNode.name
          : (tgt !== undefined && tgt !== null ? '[' + tgt + '](快照外)' : '?')
      pushLine(s2, '- [' + (src ? src.id : r.sourceId) + ']' + (src ? src.name : '') + '.' + (r.sourceComponent || '') + '.' + (r.field || '') + ' -> '
        + (r.method ? '[' + (tgtNode ? tgtNode.name : (tgt !== undefined && tgt !== null ? tgt + '(快照外)' : '?')) + '] : ' + r.method : ('[' + targetTxt + ']')))
    }
  }

  // ---- 段3：噪音聚合 ----
  const s3 = []
  if (noiseCount.size > 0) {
    const topNoise = [...noiseCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    s3.push('资源/自引用聚合（' + refs.length + ' 条引用中）: ' + topNoise.map(([k, v]) => k + ' ×' + v).join(', ') + (noiseCount.size > 8 ? ' …' : ''))
  }

  // ---- 段4：锚点索引（同名同热度组聚合，label/axis 系列） ----
  const s4 = []
  const anchors = nodes.filter(n => {
    const i = info(n.id)
    const nCustom = Array.isArray(n.components) ? n.components.some(c => !BUILTIN_COMPONENTS.has(c)) : false
    return i.outRefs >= 5 || (backCount.get(n.id) || 0) >= 2 || nCustom
  }).map(n => {
    const i = info(n.id)
    return { n, out: i.outRefs, back: backCount.get(n.id) || 0, custom: (n.components || []).filter(c => !BUILTIN_COMPONENTS.has(c)) }
  }).sort((a, b) => (b.out + b.back) - (a.out + a.back))
  if (anchors.length > 0) {
    s4.push('锚点（[id] 名称 (自定义组件) R:B | 定位地址簿）:')
    const groups = new Map() // name|comps|R|B -> {name, custom, out, back, ids: []}
    for (const a of anchors) {
      const key = (a.n.name || '?') + '|' + (a.custom.join(',') || '') + '|' + a.out + '|' + a.back
      if (!groups.has(key)) groups.set(key, { name: a.n.name, custom: a.custom, out: a.out, back: a.back, ids: [] })
      groups.get(key).ids.push(a.n.id)
    }
    const groupList = [...groups.values()]
    let shown = 0
    for (const g of groupList) {
      if (shown >= 30) break
      const idList = g.ids.length > 1 ? ' ×' + g.ids.length + ' ids: ' + g.ids.join(',') : ''
      pushLine(s4, '- [' + g.ids[0] + '] ' + (g.name || '?') + (g.custom.length > 0 ? ' (' + g.custom.join(',') + ')' : '') + ' R:' + g.out + ' B:' + g.back + idList)
      shown++
    }
    if (groupList.length > 30) s4.push('… 还有 ' + (groupList.length - 30) + ' 个锚点')
  }

  // ---- 段5：定位指引 ----
  const s5 = []
  s5.push('定位: 按名 find_gameobjects(名字) / 按 id ui_snapshot(ids=[id]) / 组件值 components 资源；完整快照见 Library ' + (snap.libraryPath || ''))

  // 分段预算：概览+分支 24% / 业务引用 30% / 噪音 8% / 锚点 30% / 定位 8%（大快照下各段都可见，不再整体截断吞掉锚点/定位）
  const cut = (arr, m) => {
    const s = arr.join('\n')
    return s.length <= m ? s : s.slice(0, m) + '\n…[该段超预算已截断]'
  }
  return cut(s1, Math.floor(budget * 0.24))
    + '\n' + cut(s2, Math.floor(budget * 0.30))
    + '\n' + cut(s3, Math.floor(budget * 0.08))
    + '\n' + cut(s4, Math.floor(budget * 0.30))
    + '\n' + cut(s5, Math.floor(budget * 0.08))
}

function pushLine(arr, line) { arr.push(line) }

/** 快照地图（JSON 可用时）；失败回退文本压缩模式。 */

/**
 * ui_snapshot 文本按「树 / Refs / Backrefs」三段预算分配 + 规则压缩，保证信息密度：
 *  - 树：去掉 rect 坐标（省 ~40%）；若 ≥80% 节点未激活，聚合为头部声明并去掉行内 (inactive)；
 *    相同结构的子树（如重复的 Dropdown 模板）只保留首个，后续以「重复子树」占位（2026-08-20 用户要求提密度）；
 *  - Refs：同一来源（[id]物体.组件）的连续引用只写一次来源，后续行只保留「字段 -> 目标」；
 *  - 无引用段（小快照/旧格式）原样返回。
 */
function compactUiSnapshot(text, maxChars) {
  if (typeof text !== 'string') return ''
  const budget = Math.max(400, Number(maxChars) > 0 ? Number(maxChars) : 8000)
  const refsMark = 'Refs (outgoing):'
  const backMark = 'Backrefs (incoming'
  const refsIdx = text.indexOf(refsMark)
  const backIdx = text.indexOf(backMark)
  if (refsIdx < 0) return text
  const treePart = compactUiTree(text.slice(0, refsIdx))
  const refsPart = compactUiRefs(backIdx >= 0 ? text.slice(refsIdx, backIdx) : text.slice(refsIdx))
  const backPart = compactUiBackrefs(backIdx >= 0 ? text.slice(backIdx) : '')
  const treeMax = Math.floor(budget * 0.55)
  const refsMax = Math.floor(budget * 0.30)
  const backMax = budget - treeMax - refsMax
  const cut = (s, m) => (s.length <= m ? s : s.slice(0, m) + '\n…[该段超出预算已截断]')
  return cut(treePart, treeMax) + cut(refsPart, refsMax) + cut(backPart, backMax)
}

/** 树压缩：去 rect、聚合 (inactive)（≥80% 时头部声明）、相同子树聚合（子树 ≥3 行才聚）。header 行（# UI Snapshot/Roots/Tree:）原样保留。 */
function compactUiTree(treeText) {
  const lines = treeText.split('\n').filter(l => l.trim().length > 0)
  const header = lines.filter(l => !/^\s*-/.test(l))
  const nodeLines = lines.filter(l => /^\s*-/.test(l))
  const total = nodeLines.length
  if (total === 0) return treeText
  const inact = nodeLines.filter(l => l.includes('(inactive)')).length
  // ≥80% 未激活 → 头部聚合声明并去行内标记；否则行内 (inactive) 压缩为「·」（省 ~10 字符/行，语义无损）
  const dropInactive = inact / total >= 0.8
  const dotInactive = !dropInactive && inact > 0
  const rows = nodeLines.map(l => {
    let s = l.replace(/ rect:\[[^\]]*\]\s*$/, '')
    if (dropInactive) s = s.replace(/ \(inactive\)/, '')
    else if (dotInactive) s = s.replace(/ \(inactive\)/, ' ·')
    return s
  })
  const indents = rows.map(l => (l.match(/^\s*/) || [''])[0].length)
  // 结构签名：缩进 + 去 id + **名字数字归一**（label_0_0 / label_0_1 / axis_x0 等生成器同构叶子可聚合）
  // + 子树签名——相同结构聚合（不同 id/序号允许，显示仍保留原名）；R:B 保留在签名里（保守不误聚）
  const norm = rows.map(l => l.replace(/\[-?\d+\]/g, '[id]').replace(/(\d+)/g, 'N').trim())
  const children = rows.map(() => [])
  const stack = []
  for (let i = 0; i < rows.length; i++) {
    while (stack.length && indents[stack[stack.length - 1]] >= indents[i]) stack.pop()
    if (stack.length) children[stack[stack.length - 1]].push(i)
    stack.push(i)
  }
  const sigCache = new Map()
  const sig = (i) => {
    if (sigCache.has(i)) return sigCache.get(i)
    const s = norm[i] + '{' + children[i].map(sig).join('|') + '}'
    sigCache.set(i, s)
    return s
  }
  const sizeCache = new Map()
  const size = (i) => {
    if (sizeCache.has(i)) return sizeCache.get(i)
    const n = 1 + children[i].reduce((s, c) => s + size(c), 0)
    sizeCache.set(i, n)
    return n
  }
  const seen = new Map() // sig -> 首次行号（1 起）
  const out = []
  let skipUntil = -1
  for (let i = 0; i < rows.length; i++) {
    if (i <= skipUntil) continue
    const s = sig(i)
    const first = seen.get(s)
    const sz = size(i)
    if (first !== undefined && sz >= 3) {
      out.push(' '.repeat(indents[i]) + '…[重复子树（同第 ' + first + ' 行结构），跳过 ' + (sz - 1) + ' 行]')
      skipUntil = i + sz - 1
      continue
    }
    if (first === undefined && sz >= 3) seen.set(s, i + 1)
    out.push(rows[i])
  }
  const head = dropInactive ? '（以下节点均为未激活，inactive 标记已省略）\n' : dotInactive ? '（· 表示未激活）\n' : ''
  return header.join('\n') + (header.length ? '\n' : '') + head + out.join('\n')
}

/** Refs 压缩：同一来源（[id]物体.组件）的连续引用只保留一次来源；连续完全相同行合并为 ×N（如 BarChart.m_Font 重复 22 行）。 */
function compactUiRefs(refsText) {
  const out = []
  let prevSrc = null
  let prevOut = null
  let repeat = 0
  const push = (line) => {
    if (line === prevOut) { repeat++; return }
    if (prevOut !== null) out.push(repeat > 1 ? prevOut + ' ×' + repeat : prevOut)
    prevOut = line
    repeat = 1
  }
  for (const raw of refsText.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const arrow = l.indexOf(' -> ')
    if (arrow < 0) { push(l); prevSrc = null; continue }
    const src = l.slice(0, arrow)
    const tail = l.slice(arrow + 4)
    const dot = src.lastIndexOf('.')
    const prefix = dot > 0 ? src.slice(0, dot) : null
    const field = dot > 0 ? src.slice(dot + 1) : null
    if (prefix && field && prefix === prevSrc) push('  ' + field + ' -> ' + tail)
    else { push(l); prevSrc = prefix }
  }
  if (prevOut !== null) out.push(repeat > 1 ? prevOut + ' ×' + repeat : prevOut)
  return out.join('\n')
}

/** Backrefs 压缩：同一被引用目标（[id]物体）的多条来源合并为逗号列表。 */
function compactUiBackrefs(backText) {
  const out = []
  let pending = null // { target, sources: [] }
  const flush = () => {
    if (pending) { out.push(pending.target + ' <- ' + pending.sources.join(', ')); pending = null }
  }
  for (const raw of backText.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const arr = l.indexOf(' <- ')
    if (arr < 0) { flush(); out.push(l); continue }
    const tgt = l.slice(0, arr)
    const src = l.slice(arr + 4)
    if (pending && pending.target === tgt) pending.sources.push(src)
    else { flush(); pending = { target: tgt, sources: [src] } }
  }
  flush()
  return out.join('\n')
}

// 探测代码：查 Unity 编辑器忙状态（编译/刷新/进度条）+ Console 各类计数（v0.5.2 错误日志携带）。
// 输出 "c=<0|1>;u=<0|1>;p=<count>;e=<errors>;w=<warnings>;n=<logs>"（计数不可用时为 -1，功能自动降级为只看编译跃迁）。
const PROBE_CODE = [
  'var sb=new System.Text.StringBuilder();',
  'sb.Append("c=").Append(UnityEditor.EditorApplication.isCompiling?"1":"0");',
  'sb.Append(";u=").Append(UnityEditor.EditorApplication.isUpdating?"1":"0");',
  'try{sb.Append(";p=").Append(UnityEditor.Progress.GetCount());}catch{sb.Append(";p=-1");}',
  // Console 计数（LogEntries.GetCountsByType(ref int,ref int,ref int) 反射；老版本/签名变化 → -1 降级）
  'try{var lt=System.Type.GetType("UnityEditor.LogEntries,UnityEditor");',
  'var mi=lt.GetMethod("GetCountsByType",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.Public|System.Reflection.BindingFlags.NonPublic);',
  'var ar=new object[]{0,0,0};mi.Invoke(null,ar);',
  'sb.Append(";e=").Append(ar[0]).Append(";w=").Append(ar[1]).Append(";n=").Append(ar[2]);}',
  'catch{sb.Append(";e=-1;w=-1;n=-1");}',
  'return sb.ToString();',
].join('')

/** 编译错误特征（Console 里编译错误的行文，用于给携带的错误条目打 compile 标记）。 */
const COMPILE_ERROR_RE = /\berror\s+CS\d{3,4}\b|\.cs\(\d+,\d+\)\s*:\s*error/i

/** 官方 mcp-for-unity 内置工具名全集（v0.5.4）：服务端 mcpforunity://custom-tools 资源把
 *  「本实例注册的全部工具」（含官方内置）都列出来，需剔除官方名，剩下的才是工程自定义工具。 */
const KNOWN_OFFICIAL_TOOLS = new Set([
  'batch_execute', 'debug_request_context', 'execute_code', 'execute_custom_tool', 'execute_menu_item',
  'find_gameobjects', 'find_in_file', 'generate_audio', 'generate_image', 'generate_model', 'import_model',
  'import_model_file', 'manage_animation', 'manage_asset', 'manage_build', 'manage_camera', 'manage_components',
  'manage_editor', 'manage_gameobject', 'manage_graphics', 'manage_material', 'manage_packages', 'manage_physics',
  'manage_prefabs', 'manage_probuilder', 'manage_profiler', 'manage_scene', 'refresh_unity', 'apply_text_edits',
  'create_script', 'delete_script', 'validate_script', 'manage_script', 'manage_script_capabilities', 'get_sha',
  'manage_scriptable_object', 'manage_shader', 'manage_texture', 'manage_tools', 'manage_ui', 'manage_vfx',
  'read_console', 'run_tests', 'get_test_job', 'script_apply_edits', 'set_active_instance', 'unity_docs', 'unity_reflect',
])

/**
 * 探测 Unity 编辑器忙状态（走 client 直调 execute_code，不经 unity_mcp 工具入口，无递归）。
 * v0.5.2：顺带解析 Console 计数（counts.error/warning/log，-1 = Unity 侧不可用）与 compiling 布尔，
 * 供错误日志携带管线判断「编译跃迁」与「错误增量」，不额外增加一次 MCP 往返。
 * @returns {{ok:boolean, busy:boolean, raw:string, compiling:boolean, counts:{error:number,warning:number,log:number}|null}}
 *          ok=false 表示探测本身失败（视为可能忙，保守等待）。
 */
async function probeEditorState(client) {
  try {
    const r = await client.callTool('execute_code', { action: 'execute', code: PROBE_CODE })
    if (r.isError) return { ok: false, busy: true, compiling: false, counts: null, raw: '探测失败: ' + String(r.text ?? '').slice(0, 160) }
    const text = String(r.text ?? '')
    const m = /c=(-?\d+);u=(-?\d+);p=(-?\d+)/.exec(text)
    if (!m) return { ok: false, busy: true, compiling: false, counts: null, raw: '探测结果不可解析: ' + text.slice(0, 160) }
    const busy = m[1] !== '0' || m[2] !== '0' || Number(m[3]) > 0
    const cm = /e=(-?\d+);w=(-?\d+);n=(-?\d+)/.exec(text)
    const counts = cm ? { error: Number(cm[1]), warning: Number(cm[2]), log: Number(cm[3]) } : null
    return {
      ok: true,
      busy,
      compiling: m[1] !== '0',
      counts,
      raw: 'isCompiling=' + m[1] + ',isUpdating=' + m[2] + ',progressCount=' + m[3]
        + (counts && counts.error >= 0 ? ',consoleErrors=' + counts.error : ''),
    }
  } catch (err) {
    return { ok: false, busy: true, compiling: false, counts: null, raw: '探测异常: ' + String(err?.message ?? err).slice(0, 160) }
  }
}

/**
 * 解析 read_console 返回文本为条目数组（官方 format=plain 时 data 为字符串数组；
 * 其他形态（对象数组 / 非 JSON 整段文本）尽力归一，保证管线不因返回形态变化而空转）。
 */
function parseConsoleEntries(text) {
  const raw = String(text ?? '')
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { /* 非 JSON：整段文本兜底 */ }
  const data = parsed && (Array.isArray(parsed) ? parsed : parsed.data)
  if (Array.isArray(data)) {
    return data.map(d => {
      if (typeof d === 'string') return d
      if (d && typeof d === 'object') {
        // 官方 format=detailed：{type,message,file,line,stackTrace} → 「[Error] 文案 (at 文件:行)\n堆栈」
        const type = String(d.type ?? d.mode ?? '')
        const msg = String(d.message ?? d.text ?? '')
        const where = d.file ? ' (at ' + String(d.file) + (d.line !== undefined ? ':' + String(d.line) : '') + ')' : ''
        const stack = String(d.stackTrace ?? d.stacktrace ?? d.stack ?? '')
        return (type ? '[' + type + '] ' : '') + msg + where + (stack ? '\n' + stack : '')
      }
      return String(d)
    }).map(s => String(s).trim()).filter(Boolean)
  }
  const t = raw.trim()
  return t ? [t] : []
}

export class UnityPool {
  constructor(ctx, cfg) {
    this.ctx = ctx
    this.cfg = {
      services: cfg.services,
      dataFile: cfg.dataFile,
      probeIntervalMs: Number(cfg.probeIntervalMs) || 10000,
      probeTimeoutMs: Number(cfg.probeTimeoutMs) || 3000,
      scanPorts: Array.isArray(cfg.scanPorts) ? cfg.scanPorts : [8080, 8081, 8082, 8083, 8084, 8090],
      // 扫描预算（v0.5.5，防「unity_pool_scan 卡死」）：单端口预算缺省按 probeTimeoutMs 自动推导
      scanPortTimeoutMs: Number(cfg.scanPortTimeoutMs) > 0 ? Number(cfg.scanPortTimeoutMs) : 0,
      scanTimeoutMs: Number(cfg.scanTimeoutMs) > 0 ? Number(cfg.scanTimeoutMs) : 20000,
      autoAssign: cfg.autoAssign !== false,
      enforceExclusive: cfg.enforceExclusive !== false,
      connectHint: typeof cfg.connectHint === 'string' ? cfg.connectHint : '',
      busyWaitEnabled: cfg.busyWaitEnabled !== false,
      busyMaxWaitMs: Number(cfg.busyMaxWaitMs) > 0 ? Number(cfg.busyMaxWaitMs) : 10000,
      busyWaitIntervalMs: Number(cfg.busyWaitIntervalMs) > 0 ? Number(cfg.busyWaitIntervalMs) : 500,
      autoUnbindOnArchive: cfg.autoUnbindOnArchive !== false,
      callReconnectTimeoutMs: Number(cfg.callReconnectTimeoutMs) > 0 ? Number(cfg.callReconnectTimeoutMs) : 20000,
      // 启动 Unity 编辑器（v0.5.8）
      launchEnabled: cfg.launchEnabled !== false,
      projects: normalizeProjects(cfg.projects),
      editorPaths: Array.isArray(cfg.editorPaths) ? cfg.editorPaths.map(v => expandHome(String(v))) : [],
      editorRoots: Array.isArray(cfg.editorRoots) && cfg.editorRoots.length > 0 ? cfg.editorRoots.map(v => expandHome(String(v))) : defaultEditorRoots(),
      allowVersionMismatch: cfg.allowVersionMismatch !== false,
      allowAnyProject: cfg.allowAnyProject !== false,
      launchLogDir: typeof cfg.launchLogDir === 'string' && cfg.launchLogDir ? expandHome(cfg.launchLogDir) : path.join(homedir(), '.dsh', 'unity-pool-launch'),
      launchWaitReadyMs: Number(cfg.launchWaitReadyMs) > 0 ? Number(cfg.launchWaitReadyMs) : 120000,
      launchPollIntervalMs: Number(cfg.launchPollIntervalMs) > 0 ? Number(cfg.launchPollIntervalMs) : 2000,
      launchArgs: Array.isArray(cfg.launchArgs) ? cfg.launchArgs.map(String) : [],
      launchDialogCheckEnabled: cfg.launchDialogCheckEnabled !== false,
      launchDialogCheckAfterMs: Number(cfg.launchDialogCheckAfterMs) >= 0 ? Number(cfg.launchDialogCheckAfterMs) : 8000,
      dialogWatchEnabled: cfg.dialogWatchEnabled !== false,
      dialogPollIntervalMs: Number(cfg.dialogPollIntervalMs) > 0 ? Number(cfg.dialogPollIntervalMs) : 10000,
      autoDismissDialogs: Array.isArray(cfg.autoDismissDialogs) ? cfg.autoDismissDialogs.filter(r => r && r.match) : [],
      autoDismissOnMCPFailure: cfg.autoDismissOnMCPFailure === true,
      serverStartWaitMs: Number(cfg.serverStartWaitMs) > 0 ? Number(cfg.serverStartWaitMs) : 30000,
      closeWaitMs: Number(cfg.closeWaitMs) > 0 ? Number(cfg.closeWaitMs) : 15000,
      closeStopsServer: cfg.closeStopsServer !== false,
      // 状态携带（v0.4.0）：默认全关
      stateEnabled: cfg.stateEnabled === true,
      stateGameScreenshot: cfg.stateGameScreenshot === true,
      stateSceneScreenshot: cfg.stateSceneScreenshot === true,
      stateSelection: cfg.stateSelection === true,
      stateUiSnapshot: cfg.stateUiSnapshot === true,
      stateSerialized: cfg.stateSerialized === true,
      stateConsoleAll: cfg.stateConsoleAll === true,
      stateConsoleSelected: cfg.stateConsoleSelected === true,
      stateConsoleError: cfg.stateConsoleError === true,
      stateRefreshMs: Number(cfg.stateRefreshMs) > 0 ? Number(cfg.stateRefreshMs) : 3000,
      stateScreenshotMaxRes: Number(cfg.stateScreenshotMaxRes) > 0 ? Number(cfg.stateScreenshotMaxRes) : 640,
      stateDir: typeof cfg.stateDir === 'string' && cfg.stateDir ? cfg.stateDir : path.join(homedir(), '.dsh', 'unity-pool-state'),
      stateMaxChars: Number(cfg.stateMaxChars) > 0 ? Number(cfg.stateMaxChars) : 8000,
      stateSnapshotMaxChars: Number(cfg.stateSnapshotMaxChars) > 0 ? Number(cfg.stateSnapshotMaxChars) : 8000,
      stateConsoleMaxChars: Number(cfg.stateConsoleMaxChars) > 0 ? Number(cfg.stateConsoleMaxChars) : 6000,
      stateConsoleCount: Number(cfg.stateConsoleCount) > 0 ? Number(cfg.stateConsoleCount) : 50,
      screenshotStaleMs: Number(cfg.screenshotStaleMs) > 0 ? Number(cfg.screenshotStaleMs) : 10000,
      // 冷启动补齐（v0.5.6）：缺省 4000ms，显式传 0 = 关闭；冷却防「Unity 离线时每步都等」
      stateFirstTurnWaitMs: cfg.stateFirstTurnWaitMs === undefined ? 4000 : (Number(cfg.stateFirstTurnWaitMs) > 0 ? Number(cfg.stateFirstTurnWaitMs) : 0),
      stateCollectCooldownMs: Number(cfg.stateCollectCooldownMs) > 0 ? Number(cfg.stateCollectCooldownMs) : 10000,
      // 原生工具注册（v0.5.0）
      nativeToolsEnabled: cfg.nativeToolsEnabled !== false,
      nativeToolSchema: cfg.nativeToolSchema === 'full' ? 'full' : 'compact',
      // 错误日志携带（v0.5.2）
      errorWatchEnabled: cfg.errorWatchEnabled !== false,
      errorWatchCount: Number(cfg.errorWatchCount) > 0 ? Number(cfg.errorWatchCount) : 5,
      errorWatchMaxChars: Number(cfg.errorWatchMaxChars) > 0 ? Number(cfg.errorWatchMaxChars) : 2000,
      errorWatchFetchMax: Number(cfg.errorWatchFetchMax) > 0 ? Number(cfg.errorWatchFetchMax) : 50,
      errorWatchStacktrace: cfg.errorWatchStacktrace !== false,
      // 工具排序（v0.5.4）
      customToolsFirst: cfg.customToolsFirst !== false,
    }
    this.services = this.cfg.services.map(s => ({
      id: String(s.id),
      name: String(s.name || s.id),
      url: normalizeUrl(s.url),
      startCommand: Array.isArray(s.startCommand) ? s.startCommand.map(String) : [],
      alive: null,
      aliveAt: 0,
      lastError: null,
      instances: [],
      discoveredAt: 0,
      instancesValid: false, // 最近一次实例发现是否成功（false=发现失败，列表可能过期，不据此判离线）
      offlineStreak: 0,      // 连续离线探测次数（在线时归零）
    }))
    this.bindings = Object.create(null) // sessionId -> { serviceId, instanceId, boundAt }
    this.sessionClients = new Map()     // sessionId -> { serviceId, client: McpHttpClient }
    this.discoveryClients = new Map()   // serviceId -> McpHttpClient（探测/实例发现用）
    this.probeTimer = null
    this.lastScanSkipped = []           // 最近一次扫描跳过的端口（单端口预算内未完成，v0.5.5）
    // 启动 Unity 编辑器（v0.5.8）：pid -> 启动记录；已装编辑器扫描缓存（30s）
    this.launches = new Map()
    this._editorsCache = null
    this._editorsCacheAt = 0
    // 由本插件 startCommand 拉起的服务进程：serviceId -> { pid, logFile, startedAt, command }
    // 关闭编辑器且服务上没有其他实例时，用它 + 端口占用者把服务（及其终端子进程）一起收掉。
    this.serverProcesses = new Map()
    // 模态窗（v0.5.8）：后台定时扫描缓存 + 定时器
    this.dialogsCache = null
    this.dialogTimer = null
    this.stateTimer = null              // 状态采集定时器（仅 stateEnabled 时启）
    this.stateCaches = new Map()        // sessionId -> { at, instanceId, entries: [{key,label,ok,text?,file?,error?}] }
    this._stateCollecting = false       // 采集防重入标志
    this._stateCollectingPromise = null // 在飞采集 Promise（防重入时共享给等待方；v0.5.6 冷启动补齐）
    this._stateWaitAt = new Map()       // sessionId -> 上次冷启动等待时间（冷却，防 Unity 离线时每步都等）
    this._stateTurnMap = new Map()      // sessionId -> 最近一次已注入的回合号（每回合只注入一次状态）
    this.stateSwitchLog = []             // 开关操作流水（诊断用，最多 40 条）
    // 错误日志携带（v0.5.2）：sessionId::instance -> { cursor, latest, compiling, compileFinished, lastReport }
    //   cursor  = 上次已上报的 Console 错误计数（游标；推进 = 同一批只报一次）
    //   latest  = 最近一次探测看到的错误计数
    //   compiling / compileFinished = 编译跃迁跟踪（isCompiling 1→0 视为一次编译完成）
    this.errorWatches = new Map()
    // 状态开关按会话独立（v0.4.2，2026-08-21 用户纠正「全会话共享 + 只有绑定才能控制 → 不成闭环」）：
    //   cfg.stateXxx = 配置默认层（构造后不再被运行时修改）
    //   _stateSwitchesBase = 旧版全局平铺持久化（v0.4.1 及之前），作为全局默认层迁移兼容
    //   _stateSwitchesBySession = 每会话覆盖层 { [sessionId]: { key: bool } }（含"关"，磁盘持久化）
    //   生效值 = cfg 默认 ← base ← per-session 覆盖（getStateSwitches）
    this._stateSwitchesBase = null
    this._stateSwitchesBySession = Object.create(null)
    this._load()

    // ---- 原生工具注册（v0.5.0）----
    // nativeDisposers: serviceId -> Map<umcpName, disposer>（DSH tools.register 返回的注销函数）
    // nativeToolOwner: umcpName -> serviceId（同名工具跨服务时后绑定者接管）
    this.nativeDisposers = new Map()
    this.nativeToolOwner = new Map()
    this._toolRegistry = (ctx && ctx.tools && typeof ctx.tools.register === 'function') ? ctx.tools : null

    // ---- 会话归档（session/disposed）驱动解绑（v0.5.1 设计修正）----
    // 归档的语义是「会话被归档（DSH session/disposed）」→ 清理该会话锁定的实例；
    // 实例掉线/域重载是无感的——绑定保持、不主动解绑、不注入通知，实例离线只在调用时由
    // unity_mcp/umcp_* 自动重连并在超时（callReconnectTimeoutMs）后返回失败原因。
    this._disposedUnbindDisposer = null
    if (ctx && typeof ctx.on === 'function') {
      this._disposedUnbindDisposer = ctx.on('session/disposed', (session) => this._onSessionDisposed(session))
    }
  }

  /** 会话归档（DSH session/disposed）时清理该会话锁定的实例（autoUnbindOnArchive 默认开启）。 */
  _onSessionDisposed(session) {
    if (this.cfg.autoUnbindOnArchive === false) return
    const sid = session && session.id
    if (sid && this.bindings[String(sid)]) this.unbind(String(sid))
  }

  // ---- 持久化 ----

  _load() {
    try {
      const raw = fs.readFileSync(this.cfg.dataFile, 'utf8')
      const data = JSON.parse(raw)
      const bindings = (data && typeof data.bindings === 'object' && data.bindings) || {}
      // v0.5.7：不再按「构造时已知的服务 id」过滤 —— 扫描发现的端口段服务（scan-N）不在配置里，
      //   旧行为会在每次插件热重载后把绑到 scan-N 的会话悄悄解绑（实测：绑 8090 的会话重载后 binding=null）。
      //   现在一律保留；服务若暂时不在池中，bindingOf 会返回 null 并给出可读错误，重扫后自动恢复。
      for (const [sid, b] of Object.entries(bindings)) {
        const bv = (b && typeof b === 'object') ? b : {}
        if (typeof bv.serviceId === 'string') {
          this.bindings[sid] = {
            serviceId: bv.serviceId,
            instanceId: typeof bv.instanceId === 'string' ? bv.instanceId : null,
            boundAt: Number(bv.boundAt) || Date.now(),
          }
        }
      }
      // 状态开关持久化（v0.4.1 旧版全局平铺 → v0.4.2 按会话）：
      // 旧 stateSwitches 作为全局默认层（base，迁移兼容）；新 stateSwitchesBySession 按会话覆盖
      const sw = (data && typeof data.stateSwitches === 'object' && data.stateSwitches) || null
      this._stateSwitchesBase = sw && Object.keys(sw).length > 0 ? sw : null
      const bySession = (data && typeof data.stateSwitchesBySession === 'object' && data.stateSwitchesBySession) || null
      if (bySession) {
        for (const [sid, s] of Object.entries(bySession)) {
          if (s && typeof s === 'object') this._stateSwitchesBySession[sid] = s
        }
      }
    } catch { /* 首次运行或文件损坏 */ }
  }

  _save() {
    try {
      const file = this.cfg.dataFile
      const payload = JSON.stringify({
        bindings: this.bindings,
        stateSwitches: this._stateSwitchesBase,
        stateSwitchesBySession: this._stateSwitchesBySession,
      }, null, 2)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      this.ctx?.logger?.warn?.('[unity-pool] 持久化绑定失败: ' + String(err?.message ?? err))
    }
  }

  /**
   * 取某会话的状态携带开关（v0.4.2 按会话独立）：
   * 合并顺序 = 配置默认（cfg.stateXxx）← 旧全局持久化层（_stateSwitchesBase，迁移兼容）
   *          ← 本会话覆盖层（_stateSwitchesBySession[sessionId]，含"关"）。
   * 未切换过的会话 = 配置默认 + base（全局默认层）。
   */
  getStateSwitches(sessionId) {
    const out = {}
    for (const key of STATE_SWITCH_KEYS) out[key] = this.cfg[key] === true
    const base = this._stateSwitchesBase
    if (base && typeof base === 'object') {
      for (const key of STATE_SWITCH_KEYS) {
        if (typeof base[key] === 'boolean') out[key] = base[key]
      }
    }
    const own = this._stateSwitchesBySession[sessionId]
    if (own && typeof own === 'object') {
      for (const key of STATE_SWITCH_KEYS) {
        if (typeof own[key] === 'boolean') out[key] = own[key]
      }
    }
    return out
  }

  // ---- 服务与实例 ----

  serviceById(id) {
    return this.services.find(s => s.id === id) || null
  }

  discoveryClient(service) {
    let c = this.discoveryClients.get(service.id)
    // URL 变了（同 id 换了端点，如扫描候选端口复用了 scan-N 这个 id）→ 重建客户端，
    // 否则会拿旧地址的 client 去探测新地址（错端口 → 误判）。
    if (c && c.url !== service.url) {
      try { c.close() } catch { /* ignore */ }
      this.discoveryClients.delete(service.id)
      c = null
    }
    if (!c) {
      c = new McpHttpClient(service.url, { timeoutMs: this.cfg.probeTimeoutMs, logger: this.ctx?.logger })
      this.discoveryClients.set(service.id, c)
    }
    return c
  }

  /** 丢弃某服务的发现客户端（自愈）：探测超时说明其内部串行链可能被挂起的请求占住，下次探测重建。 */
  dropDiscoveryClient(service) {
    const c = this.discoveryClients.get(service.id)
    if (!c) return
    try { c.close() } catch { /* ignore */ }
    this.discoveryClients.delete(service.id)
  }

  /** 单服务「探活 + 实例发现」的总预算（毫秒）：各请求自有超时，这里再兜一层，防未知 await 挂住整池。 */
  probeServiceBudgetMs() {
    return Math.max(5000, Number(this.cfg.probeTimeoutMs) * 6)
  }

  /** 单个候选端口的扫描预算（毫秒）：显式配置优先，缺省 = max(2000, probeTimeoutMs × 2)。 */
  scanPortBudgetMs() {
    const explicit = Number(this.cfg.scanPortTimeoutMs)
    if (explicit > 0) return explicit
    return Math.max(2000, Number(this.cfg.probeTimeoutMs) * 2)
  }

  /** 单服务：探活 + 实例发现（带总预算；超时自愈：丢弃客户端，下次重建）。 */
  async probeService(service) {
    try {
      await withTimeout(this._probeServiceOnce(service), this.probeServiceBudgetMs(), '服务探测[' + (service.name || service.id) + ']')
    } catch (err) {
      if (!err || !err.timedOut) throw err
      // 总预算用尽（某个 await 没回来）：标记本次发现失败并丢弃该客户端，避免毒化的串行链
      // 让后续每一次探测/扫描都排队等死（2026-09-09 unity_pool_scan 卡死同类故障）。
      service.lastError = '探测超时：' + String(err?.message ?? err)
      if (service.alive !== true) service.alive = false
      service.instancesValid = false
      if (service.alive === false) service.offlineStreak = (service.offlineStreak || 0) + 1
      this.dropDiscoveryClient(service)
    }
  }

  /** 单服务探测实现（不含总预算，由 probeService 包裹）。 */
  async _probeServiceOnce(service) {
    if (!service.url) {
      service.alive = false
      service.lastError = 'empty url'
      return
    }
    try {
      const res = await fetch(service.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(500, this.cfg.probeTimeoutMs)),
        headers: { accept: 'application/json, text/plain, */*' },
      })
      // 探活只看状态码，不看 body；但必须显式取消响应体——否则 SSE 保活/长连接的
      // 响应体会一直占着连接与流（并让 fetch 的 abort 计时器到点才释放）。
      try { res.body?.cancel?.().catch?.(() => {}) } catch { /* ignore */ }
      service.alive = true
      service.aliveAt = Date.now()
      service.lastError = null
      service.offlineStreak = 0
    } catch (err) {
      service.alive = false
      service.lastError = String((err && err.name === 'AbortError') ? 'timeout' : (err?.message ?? err))
      service.offlineStreak = (service.offlineStreak || 0) + 1
      // 服务离线：实例必然不可达，清空列表（归档判定走 alive=false 分支）
      service.instances = []
      service.instancesValid = false
      return
    }
    // 实例发现（best-effort）：读 mcpforunity://instances
    try {
      const client = this.discoveryClient(service)
      const instances = await client.listInstances()
      service.instances = instances
      service.discoveredAt = Date.now()
      service.instancesValid = true
    } catch (err) {
      // 发现失败≠实例消失：保留上次成功发现的列表，标记 instancesValid=false，
      // 归档判定只在 instancesValid=true（本次发现成功）时进行，避免误判。
      service.lastError = 'instances: ' + String(err?.message ?? err)
      service.instancesValid = false
      if (err && (err.timedOut || /timeout/i.test(String(err?.message ?? '')))) this.dropDiscoveryClient(service)
    }
  }

  async probe() {
    // 探测只负责服务存活 + 实例发现（刷新视图），不做任何自动解绑——
    // 归档的语义是「会话归档（session/disposed）」，实例掉线/域重载对已绑定会话是无感的（见 _onSessionDisposed）。
    // allSettled：单个服务探测异常不影响其他服务，也不会抛成 unhandled rejection（probe 定时器不 await）。
    await Promise.allSettled(this.services.map(s => this.probeService(s)))
  }

  /**
   * 扫描额外端口，把新发现的 MCP 服务并入池（幂等：同 url 不重复）。
   * 每个候选端口有独立预算（scanPortBudgetMs）：端口上挂着「只回响应头不收尾」的服务
   * （SSE 保活/非 MCP 服务）时跳过该端口并记入 lastScanSkipped，绝不把整次扫描挂死。
   * @returns 本次新并入池的服务数组（跳过的端口见 this.lastScanSkipped）
   */
  async scan() {
    const found = []
    const skipped = []
    const urls = new Set(this.services.map(s => s.url))
    const existingIds = new Set(this.services.map(s => s.id))
    const budget = this.scanPortBudgetMs()
    let index = 1
    for (const port of this.cfg.scanPorts) {
      const url = 'http://127.0.0.1:' + Number(port) + '/mcp'
      if (urls.has(url)) continue
      const candidate = { id: 'scan-' + (index++), name: 'Scan-' + port, url, alive: false, aliveAt: 0, lastError: null, instances: [], discoveredAt: 0, instancesValid: false, offlineStreak: 0 }
      try {
        await withTimeout((async () => {
          await this.probeService(candidate)
          if (candidate.alive) {
            const ok = await this.tryInitialize(candidate)
            if (!ok) { candidate.alive = false; candidate.lastError = 'not an MCP server' }
          }
        })(), budget, '扫描端口 ' + port)
      } catch (err) {
        candidate.alive = false
        candidate.lastError = String(err?.message ?? err)
        skipped.push({ port, url, reason: candidate.lastError })
        this.dropDiscoveryClient(candidate) // 自愈：丢弃可能被挂起请求占住的客户端
      }
      if (candidate.alive) {
        if (!existingIds.has(candidate.id)) {
          this.services.push(candidate)
          found.push({ id: candidate.id, name: candidate.name, url: candidate.url, instanceCount: candidate.instances.length })
        }
      }
    }
    this.lastScanSkipped = skipped
    return found
  }

  async tryInitialize(service) {
    try {
      const client = this.discoveryClient(service)
      await client.ensureInit()
      return true
    } catch { return false }
  }

  // ---- 启动 Unity 编辑器（v0.5.8）----
  // 设计：只负责「拉起编辑器 + 等实例出现 + 绑定本会话」，不启动/停止 mcp-for-unity 的 HTTP 服务。
  // Unity 侧的 MCP 包（com.coplaydev.unity-mcp）在 Auto-Start on Editor Load 开启时会自己拉起 HTTP 服务
  // （本机 EditorPrefs 已开），因此启动编辑器通常就能让服务池发现新实例；工程没有 MCP 包时仅启动编辑器
  // （返回 hasMcpPackage:false 的提示）。

  /** 已安装的 Unity 编辑器列表（editorPaths 优先，其余扫描 editorRoots；缓存 30s）。 */
  installedEditors(refresh = false) {
    const now = Date.now()
    if (!refresh && this._editorsCache && now - this._editorsCacheAt < 30000) return this._editorsCache
    const list = []
    const seen = new Set()
    const push = (exe) => {
      if (!exe || seen.has(exe)) return
      let isFile = false
      try { isFile = fs.statSync(exe).isFile() } catch { isFile = false }
      if (!isFile) return
      seen.add(exe)
      list.push({ exe, version: versionFromEditorPath(exe) || versionFromEditorPath(path.dirname(exe)) })
    }
    for (const p of this.cfg.editorPaths) push(path.resolve(p))
    for (const root of this.cfg.editorRoots) {
      let dirs = []
      try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        // Windows/Linux: <root>/<version>/Editor/Unity[.exe]；macOS: <root>/<version>/Unity.app/Contents/MacOS/Unity
        for (const rel of [
          path.join(root, d.name, 'Editor', process.platform === 'win32' ? 'Unity.exe' : 'Unity'),
          path.join(root, d.name, 'Unity.app', 'Contents', 'MacOS', 'Unity'),
        ]) {
          try { if (fs.statSync(rel).isFile()) { push(rel); break } } catch { /* 不是该平台布局 */ }
        }
      }
    }
    list.sort((a, b) => compareUnityVersions(b.version, a.version))
    this._editorsCache = list
    this._editorsCacheAt = now
    return list
  }

  /** 解析目标工程：project（配置清单名）或 projectPath（任意工程路径）。 */
  resolveProject(input = {}) {
    const wanted = input.project ? String(input.project).trim() : ''
    const rawPath = input.projectPath ? String(input.projectPath).trim() : ''
    let entry = null
    if (wanted) {
      entry = this.cfg.projects.find(p => p.name === wanted || p.path === wanted) || null
      if (!entry) {
        throw new Error('工程清单里没有 [' + wanted + ']（已配置: ' + (this.cfg.projects.map(p => p.name).join('、') || '无') + '；也可直接传 projectPath）')
      }
    }
    if (!entry && !rawPath) {
      throw new Error('需要 project（cordis.patch.yml projects 清单里的工程名）或 projectPath（Unity 工程绝对路径）；已配置工程: ' + (this.cfg.projects.map(p => p.name).join('、') || '无'))
    }
    const abs = path.resolve(expandHome(entry ? entry.path : rawPath))
    if (!entry && this.cfg.allowAnyProject === false) {
      throw new Error('只允许启动配置清单内的工程（allowAnyProject:false）：' + abs)
    }
    const missing = []
    if (!fs.existsSync(abs)) missing.push('目录不存在')
    else {
      if (!fs.existsSync(path.join(abs, 'Assets'))) missing.push('Assets/')
      if (!fs.existsSync(path.join(abs, 'ProjectSettings'))) missing.push('ProjectSettings/')
    }
    if (missing.length > 0) throw new Error('不是有效的 Unity 工程（缺少 ' + missing.join('、') + '）：' + abs)
    const projectVersion = (entry && entry.version) || readProjectVersion(abs) || ''
    const mcpSource = detectMcpSource(abs)
    return {
      name: entry ? entry.name : path.basename(abs),
      path: abs,
      version: projectVersion,
      serviceId: (entry && entry.serviceId) || '',
      fromConfig: Boolean(entry),
      hasMcpPackage: mcpSource !== null,
      mcpSource,
    }
  }

  /** 解析 Unity 编辑器可执行文件：editorPath 优先，否则按工程版本匹配已装版本。 */
  resolveEditor({ editorPath, version } = {}) {
    if (editorPath) {
      const abs = path.resolve(expandHome(String(editorPath)))
      if (!fs.existsSync(abs)) throw new Error('editorPath 不存在: ' + abs)
      return {
        exe: abs,
        version: versionFromEditorPath(abs),
        requestedVersion: version ? String(version) : '',
        mismatch: Boolean(version) && versionFromEditorPath(abs) !== String(version),
      }
    }
    const editors = this.installedEditors(true)
    if (editors.length === 0) {
      throw new Error('未找到 Unity 编辑器：请配置 editorPaths（Unity.exe 路径）或 editorRoots（安装根目录）；当前查询: ' + this.cfg.editorRoots.join('、'))
    }
    const want = version ? String(version) : ''
    if (want) {
      const exact = editors.find(e => e.version === want)
      if (exact) return { exe: exact.exe, version: exact.version, requestedVersion: want, mismatch: false }
      if (this.cfg.allowVersionMismatch === false) {
        throw new Error('工程需要 Unity ' + want + '，本机未安装（已装: ' + editors.map(e => e.version).join('、') + '）；可配置 allowVersionMismatch:true 用已装版本打开')
      }
    }
    const picked = editors[0]
    return {
      exe: picked.exe,
      version: picked.version,
      requestedVersion: want,
      mismatch: Boolean(want) && picked.version !== want,
    }
  }

  /**
   * 工程是否已被打开：
   *  ① 本插件启动记录里的进程仍活着（最可靠）；
   *  ② Temp/UnityLockfile 存在**且被独占持有**（Unity 用独占句柄打开它）→ 运行中；
   *  ③ 锁文件存在但能正常 r+ 打开 = 陈旧锁（崩溃/强杀残留）→ 清理并判「未运行」。
   * ②③ 修复了「P4 明明没开编辑器却显示运行中」——旧实现只看文件存在。
   */
  projectRunning(projectPath) {
    for (const rec of this.launches.values()) {
      if (rec.projectPath === projectPath && this.isPidAlive(rec.pid)) return { pid: rec.pid, source: 'launch', record: rec }
    }
    const lockFile = path.join(projectPath, 'Temp', 'UnityLockfile')
    if (!fs.existsSync(lockFile)) return null
    if (lockFileHeld(lockFile)) return { pid: null, source: 'lockfile', lockFile }
    // 陈旧锁：能打开说明没有 Unity 持有；mtime > 10s 才删（避开刚创建/刚释放的瞬间）
    try {
      const st = fs.statSync(lockFile)
      if (Date.now() - st.mtimeMs > 10000) fs.unlinkSync(lockFile)
    } catch { /* 删除失败不影响判定 */ }
    return null
  }

  /** 进程是否活着（signal 0；EPERM 视为活着）。 */
  isPidAlive(pid) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return false
    try { process.kill(n, 0); return true } catch (err) { return Boolean(err && err.code === 'EPERM') }
  }

  /** 跑一个短命令并收 stdout（带超时/大小上限；失败返回已收集文本）。 */
  _execText(file, args, timeoutMs = 15000) {
    return new Promise(resolve => {
      let out = ''
      let done = false
      let child = null
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(out) }
      const timer = setTimeout(() => { try { child && child.kill() } catch { /* ignore */ } finish() }, Math.max(1000, Number(timeoutMs) || 15000))
      try {
        // PowerShell 默认按控制台代码页（本机 GBK）输出，Node 按 UTF-8 解会乱码——
        // 模态窗标题/按钮常是中文，必须在命令前强制 stdout 用 UTF-8。
        let useArgs = args
        if (/powershell(?:\.exe)?$|pwsh(?:\.exe)?$/i.test(String(file || '')) && Array.isArray(args)) {
          const idx = args.indexOf('-Command')
          if (idx >= 0 && args[idx + 1] !== undefined) {
            useArgs = args.slice()
            useArgs[idx + 1] = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[Console]::OutputEncoding; ' + useArgs[idx + 1]
          }
        }
        child = spawn(file, useArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch { finish(); return }
      child.stdout.on('data', d => { if (out.length < 1024 * 1024) out += d.toString('utf8') })
      child.on('error', finish)
      child.on('close', finish)
    })
  }

  /**
   * 查「打开了某个工程的 Unity 进程」PID（用于关闭不由本插件启动的编辑器）。
   * Windows 走 Get-CimInstance（wmic 不保证存在）；其他平台走 ps。查不到返回 []。
   */
  async findEditorPids(projectPath) {
    const abs = String(projectPath || '')
    if (!abs) return []
    const norm = s => String(s || '').replace(/\//g, '\\').toLowerCase()
    const target = norm(abs)
    if (process.platform === 'win32') {
      const cmd = "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
      const text = await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], 15000)
      let data = null
      try { data = JSON.parse(text.trim()) } catch { return [] }
      const rows = Array.isArray(data) ? data : [data]
      const pids = []
      for (const r of rows) {
        if (!r || r.ProcessId == null) continue
        if (norm(r.CommandLine).includes(target)) pids.push(Number(r.ProcessId))
      }
      return pids.filter(Boolean)
    }
    const text = await this._execText('ps', ['-axo', 'pid=,command='], 8000)
    const pids = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.toLowerCase().includes(target)) continue
      const m = /^\s*(\d+)\s+/.exec(line)
      if (m) pids.push(Number(m[1]))
    }
    return pids
  }

  /** 所有运行中的 Unity.exe PID（模态窗默认扫描范围）。 */
  async findUnityPids() {
    if (process.platform !== 'win32') return []
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"
    const text = await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], 8000)
    let data = null
    try { data = JSON.parse(text.trim()) } catch { return [] }
    const rows = Array.isArray(data) ? data : [data]
    return rows.map(Number).filter(Boolean)
  }

  /**
   * 枚举 Unity 进程的模态对话框（Windows 原生 #32770）：标题、正文（Static 文本）、按钮选项。
   * @param projectPath 可只查某个工程的编辑器；不传则查所有 Unity 进程
   * @param opts.pids 直接指定 PID 列表
   * @returns {{supported:boolean, pids:number[], dialogs:Array}}
   */
  async findModalDialogs(projectPath, opts = {}) {
    if (process.platform !== 'win32') {
      return { supported: false, pids: [], dialogs: [], hint: '模态窗检测目前仅实现 Windows（Win32 #32770）' }
    }
    let pids = Array.isArray(opts.pids) ? opts.pids.map(Number).filter(Boolean) : []
    if (pids.length === 0 && projectPath) {
      const rec = [...this.launches.values()].find(r => r.projectPath === projectPath && this.isPidAlive(r.pid))
      if (rec) pids.push(Number(rec.pid))
      for (const p of await this.findEditorPids(projectPath).catch(() => [])) {
        if (!pids.includes(Number(p))) pids.push(Number(p))
      }
    }
    if (pids.length === 0) pids = await this.findUnityPids().catch(() => [])
    if (pids.length === 0) return { supported: true, pids: [], dialogs: [], hint: '没有运行中的 Unity 进程' }
    const script = WIN_DIALOG_PS.replace('__PIDS__', pids.join(','))
    const text = await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 12000)
    let data = null
    try { data = JSON.parse(String(text || '').trim() || '[]') } catch {
      return { supported: true, pids, dialogs: [], error: '模态窗输出解析失败', raw: String(text || '').slice(0, 200) }
    }
    const rows = Array.isArray(data) ? data : [data]
    const dialogs = rows.map(d => {
      const children = Array.isArray(d.Children) ? d.Children : []
      const buttons = children.filter(c => c && c.ClassName === 'Button' && c.Text)
      const statics = children.filter(c => c && c.ClassName === 'Static' && c.Text)
      return {
        hwnd: d.Hwnd,
        pid: d.Pid,
        title: String(d.Title || '').trim(),
        message: statics.map(s => String(s.Text || '').trim()).filter(Boolean).join('\n'),
        className: d.ClassName,
        options: buttons.map((b, i) => ({ index: i, text: String(b.Text || '').trim(), id: b.Id, hwnd: b.Hwnd, enabled: b.Enabled !== false })),
      }
    })
    return { supported: true, pids, dialogs }
  }

  /**
   * 选择模态窗里的选项并点击（BM_CLICK）。
   * @param opts.hwnd 目标对话框句柄（缺省取第一个）；opts.option = 序号/文案（缺省第一个可用按钮）
   * @param opts.projectPath 只在该工程的编辑器上找；opts.pid 直接指定
   */
  async clickModalDialogOption(opts = {}) {
    if (process.platform !== 'win32') {
      return { supported: false, clicked: false, hint: '模态窗操作目前仅实现 Windows' }
    }
    const scope = opts.pid ? { pids: [Number(opts.pid)] } : {}
    const found = await this.findModalDialogs(opts.projectPath, scope).catch(() => ({ dialogs: [] }))
    const dialogs = Array.isArray(found.dialogs) ? found.dialogs : []
    const dialog = opts.hwnd
      ? dialogs.find(d => Number(d.hwnd) === Number(opts.hwnd)) || null
      : dialogs[0] || null
    if (!dialog) return { supported: true, clicked: false, dialogs, hint: '没有找到模态窗' }
    let option = null
    if (opts.option !== undefined && opts.option !== null && String(opts.option) !== '') {
      const raw = String(opts.option)
      if (/^\d+$/.test(raw)) option = dialog.options[Number(raw)] || null
      else {
        const want = raw.toLowerCase()
        option = dialog.options.find(o => o.text.toLowerCase() === want)
          || dialog.options.find(o => o.text.toLowerCase().includes(want))
          || null
      }
    }
    if (!option) option = dialog.options.find(o => o.enabled !== false) || dialog.options[0] || null
    if (!option) return { supported: true, clicked: false, dialogs, dialog, hint: '模态窗没有可点击的按钮' }
    const script = WIN_CLICK_PS.replace('__HWND__', String(option.hwnd))
    const out = await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 10000)
    await this._sleep(300)
    const after = await this.findModalDialogs(opts.projectPath, scope).catch(() => ({ dialogs: [] }))
    const remaining = Array.isArray(after.dialogs) ? after.dialogs : []
    return {
      supported: true,
      clicked: true,
      dialog: { hwnd: dialog.hwnd, title: dialog.title, message: dialog.message },
      option,
      remaining,
      raw: String(out || '').trim().slice(0, 200),
    }
  }

  /** 关闭模态窗（WM_CLOSE，等价于点取消/关闭；用于「关闭模态窗」而不选具体按钮）。 */
  async closeModalDialog(opts = {}) {
    if (process.platform !== 'win32') return { supported: false, closed: false, hint: '模态窗操作目前仅实现 Windows' }
    const scope = opts.pid ? { pids: [Number(opts.pid)] } : {}
    const found = await this.findModalDialogs(opts.projectPath, scope).catch(() => ({ dialogs: [] }))
    const dialogs = Array.isArray(found.dialogs) ? found.dialogs : []
    const dialog = opts.hwnd ? dialogs.find(d => Number(d.hwnd) === Number(opts.hwnd)) || null : dialogs[0] || null
    if (!dialog) return { supported: true, closed: false, dialogs, hint: '没有找到模态窗' }
    await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_CLOSE_PS.replace('__HWND__', String(dialog.hwnd))], 10000)
    await this._sleep(300)
    const after = await this.findModalDialogs(opts.projectPath, scope).catch(() => ({ dialogs: [] }))
    return {
      supported: true,
      closed: true,
      dialog: { hwnd: dialog.hwnd, title: dialog.title, message: dialog.message },
      remaining: Array.isArray(after.dialogs) ? after.dialogs : [],
    }
  }

  /** 按 autoDismissDialogs 规则自动选择/关闭匹配的模态窗（只匹配 title/message 子串）。 */
  async dismissMatchingDialogs(opts = {}) {
    const rules = Array.isArray(opts.rules) ? opts.rules : this.cfg.autoDismissDialogs
    if (!Array.isArray(rules) || rules.length === 0) return { clicked: [], closed: [] }
    const scope = opts.pid ? { pids: [Number(opts.pid)] } : {}
    const found = await this.findModalDialogs(opts.projectPath, scope).catch(() => ({ dialogs: [] }))
    const out = { clicked: [], closed: [] }
    for (const d of Array.isArray(found.dialogs) ? found.dialogs : []) {
      const hay = ((d.title || '') + '\n' + (d.message || '')).toLowerCase()
      for (const r of rules) {
        const match = String((r && r.match) || '').toLowerCase()
        if (!match || !hay.includes(match)) continue
        if (r.close) {
          const c = await this.closeModalDialog({ projectPath: opts.projectPath, pid: opts.pid, hwnd: d.hwnd }).catch(() => null)
          if (c && c.closed) out.closed.push({ hwnd: d.hwnd, title: d.title })
        } else {
          const c = await this.clickModalDialogOption({ projectPath: opts.projectPath, pid: opts.pid, hwnd: d.hwnd, option: r.option }).catch(() => null)
          if (c && c.clicked) out.clicked.push({ hwnd: d.hwnd, title: d.title, option: c.option && c.option.text })
        }
        break
      }
    }
    return out
  }

  /** 是否有 Unity 在运行（决定要不要周期性查模态窗，避免无谓 PowerShell）。 */
  unityExpected() {
    if ([...this.launches.values()].some(r => this.isPidAlive(r.pid))) return true
    if (this.services.some(s => Array.isArray(s.instances) && s.instances.length > 0)) return true
    return this.cfg.projects.some(p => {
      try { return Boolean(this.projectRunning(p.path)) } catch { return false }
    })
  }

  /** 刷新模态窗缓存（后台定时器/失败时调用）；按 autoDismissDialogs 自动处理。 */
  async refreshDialogs() {
    if (process.platform !== 'win32') {
      this.dialogsCache = { at: Date.now(), supported: false, dialogs: [], pids: [], hint: '仅 Windows 支持' }
      return this.dialogsCache
    }
    if (!this.unityExpected()) {
      this.dialogsCache = { at: Date.now(), supported: true, dialogs: [], pids: [], skipped: 'no-unity' }
      return this.dialogsCache
    }
    const res = await this.findModalDialogs().catch(() => ({ dialogs: [], pids: [] }))
    this.dialogsCache = {
      at: Date.now(),
      supported: res.supported !== false,
      dialogs: Array.isArray(res.dialogs) ? res.dialogs : [],
      pids: Array.isArray(res.pids) ? res.pids : [],
      ...(res.hint ? { hint: res.hint } : {}),
      ...(res.error ? { error: res.error } : {}),
    }
    if (this.dialogsCache.dialogs.length > 0 && Array.isArray(this.cfg.autoDismissDialogs) && this.cfg.autoDismissDialogs.length > 0) {
      const dismissed = await this.dismissMatchingDialogs().catch(() => null)
      if (dismissed && (dismissed.clicked.length > 0 || dismissed.closed.length > 0)) {
        const again = await this.findModalDialogs().catch(() => null)
        this.dialogsCache = {
          at: Date.now(),
          supported: true,
          dialogs: again && Array.isArray(again.dialogs) ? again.dialogs : [],
          pids: again && Array.isArray(again.pids) ? again.pids : [],
          dismissed,
        }
      }
    }
    return this.dialogsCache
  }

  startDialogTimer() {
    if (this.cfg.dialogWatchEnabled === false) return
    if (this.dialogTimer) return
    this.refreshDialogs().catch(() => {})
    this.dialogTimer = setInterval(() => { this.refreshDialogs().catch(() => {}) }, Math.max(3000, this.cfg.dialogPollIntervalMs))
    if (this.dialogTimer.unref) this.dialogTimer.unref()
  }

  stopDialogTimer() {
    if (this.dialogTimer) { clearInterval(this.dialogTimer); this.dialogTimer = null }
  }

  /** 结束一个进程：默认优雅（taskkill 不带 /F / SIGTERM），force=true 才强杀；tree=true 连子进程一起。 */
  async _killPid(pid, force = false, tree = false) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return false
    if (process.platform === 'win32') {
      const args = []
      if (tree) args.push('/T')
      if (force) args.push('/F')
      args.push('/PID', String(n))
      await this._execText('taskkill.exe', args, 10000)
      return true
    }
    if (tree) {
      try { process.kill(-n, force ? 'SIGKILL' : 'SIGTERM'); return true } catch { /* 进程组不存在时回退 */ }
    }
    try { process.kill(n, force ? 'SIGKILL' : 'SIGTERM'); return true } catch { return false }
  }

  /** 查监听某个端口的进程 PID（用于停掉不是本插件拉起的 mcp-for-unity 服务/终端）。 */
  async findPortOwnerPids(port) {
    const n = Number(port)
    if (!Number.isInteger(n) || n <= 0) return []
    if (process.platform === 'win32') {
      const cmd = 'Get-NetTCPConnection -LocalPort ' + n + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ConvertTo-Json -Compress'
      const text = await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], 8000)
      let data = null
      try { data = JSON.parse(text.trim()) } catch { return [] }
      const rows = Array.isArray(data) ? data : [data]
      return rows.map(Number).filter(x => x > 0)
    }
    const text = await this._execText('lsof', ['-nP', '-iTCP:' + n, '-sTCP:LISTEN', '-t'], 8000)
    return text.split(/\s+/).map(Number).filter(x => x > 0)
  }

  /**
   * 找 Unity 侧「Start Server」拉起的终端窗口 PID（Windows: cmd.exe /k 运行
   * Library/MCPForUnity/TerminalScripts/mcp-terminal.cmd）。这种窗口在服务进程退出后仍停留
   * （cmd /k）——就是用户看到的「启动的终端被残留」。
   */
  async findServerTerminalPids() {
    if (process.platform !== 'win32') return []
    const cmd = "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match 'mcp-terminal\\.cmd' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"
    const text = await this._execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], 8000)
    let data = null
    try { data = JSON.parse(text.trim()) } catch { return [] }
    const rows = Array.isArray(data) ? data : [data]
    return rows.map(Number).filter(x => x > 0)
  }

  /**
   * 停掉某个服务：优先本插件记录的服务 PID，其次查端口占用者（覆盖 Unity 侧 Auto-Start 拉起的服务），
   * 并顺手关掉 Unity 侧的服务终端窗口（cmd /k 残留）。
   * 用 taskkill /T /F 连子进程（uvx → python）一起收；服务进程是后台进程，强杀安全。
   */
  async stopServerForService(service) {
    if (!service) return null
    let port = 0
    try {
      const u = new URL(service.url)
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    } catch { port = 0 }
    const pids = new Set()
    const tracked = this.serverProcesses.get(service.id)
    if (tracked && this.isPidAlive(tracked.pid)) pids.add(Number(tracked.pid))
    if (port > 0) {
      for (const p of await this.findPortOwnerPids(port).catch(() => [])) pids.add(Number(p))
    }
    for (const p of await this.findServerTerminalPids().catch(() => [])) pids.add(Number(p))
    if (pids.size === 0) {
      if (tracked) this.serverProcesses.delete(service.id)
      return { serviceId: service.id, port, stopped: false, reason: 'no-server-process', pids: [] }
    }
    const killed = []
    for (const pid of pids) {
      await this._killPid(pid, true, true).catch(() => false)
      killed.push(pid)
    }
    this.serverProcesses.delete(service.id)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && [...pids].some(p => this.isPidAlive(p))) await this._sleep(300)
    return { serviceId: service.id, port, stopped: true, pids: killed }
  }

  /** 停掉所有「在线且没有任何 Unity 实例」的服务（关闭编辑器后的收尾，避免残留终端/uvx）。 */
  async stopIdleServers() {
    const out = []
    await this.probe().catch(() => {})
    // 刚关编辑器时服务端可能还没感知实例断开：短暂重探几次再判定「空闲」
    for (let i = 0; i < 3; i++) {
      if (!this.services.some(s => s.alive === true && (s.instances || []).length > 0)) break
      await this._sleep(700)
      await this.probe().catch(() => {})
    }
    for (const s of this.services) {
      if (Array.isArray(s.instances) && s.instances.length > 0) continue
      // 离线服务也可能残留 Unity 侧「MCP Server」终端（cmd /k），有记录时一并清理
      if (s.alive !== true && !this.serverProcesses.has(s.id)) continue
      const r = await this.stopServerForService(s).catch(() => null)
      if (r && r.stopped) out.push(r)
    }
    // 服务全离线 / 没有实例时，兜底清一次 Unity 侧服务终端（不依赖端口是否在监听）
    if (!this.services.some(s => Array.isArray(s.instances) && s.instances.length > 0)) {
      const terminals = await this.findServerTerminalPids().catch(() => [])
      if (terminals.length > 0) {
        for (const pid of terminals) await this._killPid(pid, true, true).catch(() => false)
        out.push({ serviceId: null, port: 0, stopped: true, pids: terminals, reason: 'server-terminal' })
      }
    }
    return out
  }

  /**
   * 关闭某个工程的 Unity 编辑器（配套「启动」的能力）。
   * 默认优雅退出；若默认等待（closeWaitMs）内没退，返回 stillRunning + 提示，需显式 force=true 强杀。
   * 工程未运行时会顺手清理陈旧 Temp/UnityLockfile。
   */
  async closeProject(sessionId, opts = {}) {
    const explicitPid = Number(opts.pid) > 0 ? Number(opts.pid) : null
    const project = explicitPid ? null : this.resolveProject(opts)
    const targetPath = project ? project.path : ''
    const pids = []
    if (explicitPid) pids.push(explicitPid)
    else {
      const rec = [...this.launches.values()].find(r => r.projectPath === targetPath && this.isPidAlive(r.pid))
      if (rec) pids.push(rec.pid)
      const found = await this.findEditorPids(targetPath).catch(() => [])
      for (const p of found) if (!pids.includes(p)) pids.push(p)
    }
    const lockFile = targetPath ? path.join(targetPath, 'Temp', 'UnityLockfile') : ''
    const hadLock = Boolean(lockFile && fs.existsSync(lockFile))
    if (pids.length === 0) {
      let removed = false
      if (hadLock && !lockFileHeld(lockFile)) {
        try { fs.unlinkSync(lockFile); removed = true } catch { /* ignore */ }
      }
      // 编辑器已不在：顺手收掉「在线但没有任何实例」的服务（残留 uvx/终端）
      const stopServers = opts.stopServer !== false && this.cfg.closeStopsServer !== false
      const serverStopped = stopServers ? await this.stopIdleServers().catch(() => []) : []
      const hints = []
      if (removed) hints.push('已清理陈旧锁文件（之前显示「运行中」就是它导致的）')
      hints.push('工程未在运行（未发现 Unity 进程）')
      if (serverStopped.length > 0) hints.push('已停掉空闲的 MCP 服务（' + serverStopped.map(x => x.serviceId + '@' + x.port).join('、') + '）')
      return {
        ok: true,
        closed: false,
        alreadyClosed: true,
        sessionId,
        project: project ? { name: project.name, path: project.path } : (opts.pid ? { pid: explicitPid } : null),
        pids: [],
        staleLockfileRemoved: removed,
        serverStopped,
        hint: hints.join('；'),
      }
    }
    const force = opts.force === true
    const started = Date.now()
    for (const pid of pids) await this._killPid(pid, force).catch(() => false)
    const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : this.cfg.closeWaitMs
    const deadline = started + Math.max(1000, waitMs)
    let alives = pids.filter(p => this.isPidAlive(p))
    while (alives.length > 0 && Date.now() < deadline) {
      await this._sleep(500)
      alives = pids.filter(p => this.isPidAlive(p))
    }
    // 优雅失败且未显式 force：保留进程，返回提示（避免默认强杀丢未保存场景）
    if (alives.length > 0) {
      let dialogs = null
      if (project) {
        const d = await this.findModalDialogs(project.path).catch(() => null)
        if (d && Array.isArray(d.dialogs) && d.dialogs.length > 0) dialogs = d.dialogs
      }
      const hints = ['编辑器在 ' + Math.round((Date.now() - started) / 1000) + 's 内未退出（可能有未保存改动/保存弹窗）。']
      if (dialogs) hints.push('检测到模态窗：' + dialogs.map(d => d.title || '(无标题)').join('、') + '；用 unity_pool_dialog 选择选项（如 Don\'t Save / OK），或确认可丢弃改动后传 force=true 再关闭。')
      else hints.push('确认可以丢弃改动后传 force=true 再关闭。')
      return {
        ok: true,
        closed: false,
        alreadyClosed: false,
        stillRunning: true,
        sessionId,
        project: project ? { name: project.name, path: project.path } : null,
        pids,
        alivePids: alives,
        forced: false,
        waitedMs: Date.now() - started,
        dialogs,
        hint: hints.join(' '),
      }
    }
    for (const rec of this.launches.values()) {
      if (rec.projectPath === targetPath && pids.includes(Number(rec.pid)) && !this.isPidAlive(rec.pid)) rec.closedAt = Date.now()
    }
    // 关闭后锁文件可能残留（Windows 句柄释放慢）：确认没有存活 PID 再删
    let removed = false
    if (lockFile && fs.existsSync(lockFile) && !lockFileHeld(lockFile)) {
      try { fs.unlinkSync(lockFile); removed = true } catch { /* ignore */ }
    }
    // 关闭后服务上已无实例 → 停掉服务（避免残留 uvx/终端）；其他编辑器仍连着则保留
    const stopServers = opts.stopServer !== false && this.cfg.closeStopsServer !== false
    const serverStopped = stopServers ? await this.stopIdleServers().catch(() => []) : []
    return {
      ok: true,
      closed: true,
      alreadyClosed: false,
      sessionId,
      project: project ? { name: project.name, path: project.path } : null,
      pids,
      forced: force,
      waitedMs: Date.now() - started,
      staleLockfileRemoved: removed,
      serverStopped,
      hint: serverStopped.length > 0 ? '已停掉空闲的 MCP 服务（' + serverStopped.map(x => x.serviceId + '@' + x.port).join('、') + '）' : null,
    }
  }

  /** 启动计划（工程/编辑器/日志/参数），无副作用；测试可直接断言。 */
  planLaunch(opts = {}) {
    if (this.cfg.launchEnabled === false) throw new Error('启动 Unity 编辑器已禁用（launchEnabled:false）')
    const project = this.resolveProject(opts)
    const editor = this.resolveEditor({ editorPath: opts.editorPath, version: opts.version || project.version })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = String(project.name || 'unity').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
    const logFile = path.join(this.cfg.launchLogDir, safeName + '-' + stamp + '.log')
    const args = ['-projectPath', project.path, '-logFile', logFile].concat(this.cfg.launchArgs)
    return {
      project,
      editor,
      logFile,
      args,
      serviceId: opts.serviceId ? String(opts.serviceId) : (project.serviceId || ''),
      projectName: project.name,
    }
  }

  /**
   * 子进程环境：去掉 no_proxy 里 httpx 无法解析的方括号 IPv6 项（如 `[::1]`）。
   * 实测：本机 DSH 进程 env 的 no_proxy 含 `[::1]`，Unity 自动拉起 mcp-for-unity 时
   * httpx 解析 NO_PROXY 会抛 `Invalid port: ':1]'` 直接退出——把这项剔掉即可。
   */
  _childEnv() {
    const env = { ...process.env }
    for (const key of ['no_proxy', 'NO_PROXY']) {
      const v = env[key]
      if (typeof v === 'string' && v.includes('[')) {
        env[key] = v.split(',').map(s => s.trim()).filter(s => s && !s.includes('[')).join(',')
      }
    }
    return env
  }

  /** 真正拉起编辑器（独立进程，不占宿主；测试可替换本方法）。 */
  _spawnEditor(exe, args) {
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(exe),
      env: this._childEnv(),
    })
    child.unref()
    return child
  }

  /** 拉起一个服务（services[].startCommand），stdout/stderr 落启动日志目录（测试可替换本方法）。 */
  _spawnServer(command, logFile) {
    const fd = fs.openSync(logFile, 'a')
    try {
      const child = spawn(command[0], command.slice(1), {
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: this._childEnv(),
      })
      child.unref()
      return child
    } finally {
      try { fs.closeSync(fd) } catch { /* 子进程已复制 fd */ }
    }
  }

  /**
   * 启动编辑器前确保目标服务在线：目标服务全离线且配了 startCommand 时按命令拉起，
   * 并在 serverStartWaitMs 内轮询等服务监听（不阻断编辑器启动失败时的报错路径）。
   * @returns 服务启动摘要；未配置/已有在线服务时返回 null
   */
  async ensureServerForLaunch(plan) {
    const targets = plan.serviceId ? this.services.filter(s => s.id === plan.serviceId) : this.services
    const candidates = targets.filter(s => Array.isArray(s.startCommand) && s.startCommand.length > 0)
    if (candidates.length === 0) return null
    await this.probe().catch(() => {})
    const alive = targets.find(s => s.alive === true)
    if (alive) return { started: false, reason: 'service-alive', serviceId: alive.id }
    const svc = candidates[0]
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeId = String(svc.id).replace(/[^\w.-]+/g, '_')
    const logFile = path.join(this.cfg.launchLogDir, 'server-' + safeId + '-' + stamp + '.log')
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }) } catch (err) {
      return { started: false, serviceId: svc.id, error: '无法创建服务日志目录：' + String(err?.message ?? err) }
    }
    let child
    try {
      child = this._spawnServer(svc.startCommand, logFile)
    } catch (err) {
      return { started: false, serviceId: svc.id, error: '拉起服务失败：' + String(err?.message ?? err), logFile }
    }
    const pid = child && child.pid
    const startedAt = Date.now()
    // 记下「本插件拉起的服务」，关闭编辑器时据此连同 uvx/python 子进程树一起收掉
    if (pid) this.serverProcesses.set(svc.id, { pid: Number(pid), logFile, startedAt, command: svc.startCommand })
    const deadline = startedAt + Math.max(1000, this.cfg.serverStartWaitMs)
    while (Date.now() < deadline) {
      await this.probe().catch(() => {})
      if (svc.alive === true) {
        return { started: true, serviceId: svc.id, pid, logFile, alive: true, waitedMs: Date.now() - startedAt, command: svc.startCommand }
      }
      await this._sleep(Math.min(1000, Math.max(200, this.cfg.launchPollIntervalMs)))
    }
    return {
      started: true,
      serviceId: svc.id,
      pid,
      logFile,
      alive: false,
      waitedMs: Date.now() - startedAt,
      command: svc.startCommand,
      hint: '已按 services[].startCommand 拉起 mcp-for-unity 服务，但 ' + Math.round((Date.now() - startedAt) / 1000) + 's 内未监听；看日志 ' + logFile,
    }
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))) }

  /** 池内实例扁平列表（可按服务过滤）；launch 就绪判定用。 */
  _instancesForLaunch(serviceId) {
    const out = []
    for (const s of this.services) {
      if (serviceId && s.id !== serviceId) continue
      for (const i of s.instances || []) out.push({ serviceId: s.id, serviceName: s.name, instance: i })
    }
    return out
  }

  /** 按工程名找实例（Unity MCP 的实例名通常就是工程目录名）；找不到返回 null。 */
  findInstanceByProject(projectName, serviceId) {
    const name = String(projectName || '')
    const all = this._instancesForLaunch(serviceId)
    const exact = all.find(x => x.instance && x.instance.name === name)
    if (exact) return exact
    return all.find(x => x.instance && x.instance.name && name && (x.instance.name.includes(name) || name.includes(x.instance.name))) || null
  }

  /**
   * 等待工程实例出现并（可选）绑定本会话。
   * 匹配顺序：实例名 == 工程名 → 名称互相包含 → 启动后新出现且仅一个的新实例（兜底工程名与实例名不一致）。
   * @returns 就绪信息（ready/instance/binding）或超时标记
   */
  async waitForLaunch(plan, rec, sessionId, opts = {}) {
    const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : this.cfg.launchWaitReadyMs
    const pollMs = Math.max(200, Number(this.cfg.launchPollIntervalMs) || 2000)
    const deadline = Date.now() + Math.max(0, waitMs)
    const started = Date.now()
    const before = opts.before instanceof Set ? opts.before : null
    const dialogEnabled = this.cfg.launchDialogCheckEnabled !== false
    const dialogAfter = Math.max(0, Number(this.cfg.launchDialogCheckAfterMs) || 0)
    let lastDialogCheck = 0
    while (true) {
      await this.probe().catch(() => {})
      let hit = this.findInstanceByProject(plan.projectName, plan.serviceId)
      let matchedBy = hit ? 'name' : null
      if (!hit && before) {
        const fresh = this._instancesForLaunch(plan.serviceId).filter(x => !before.has(x.serviceId + '::' + x.instance.id))
        if (fresh.length === 1) { hit = fresh[0]; matchedBy = 'new-instance' }
      }
      if (hit) {
        rec.ready = true
        rec.serviceId = hit.serviceId
        rec.instanceId = hit.instance.id
        rec.readyAt = Date.now()
        rec.matchedBy = matchedBy
        let binding = null
        let bindError = null
        if (opts.bind !== false) {
          try {
            binding = await this.bind(sessionId, { instance: hit.instance.id, serviceId: hit.serviceId, force: opts.force !== false })
            rec.boundAt = Date.now()
          } catch (err) { bindError = String(err?.message ?? err) }
        }
        return { ready: true, waitedMs: Date.now() - started, matchedBy, ...hit, binding, bindError }
      }
      const now = Date.now()
      if (now >= deadline) {
        rec.ready = false
        return { ready: false, waitedMs: now - started, timedOut: true }
      }
      // 版本不匹配/保存确认等模态窗会阻塞导入：检测到就提前返回选项（默认启动 8s 后开始查，4s 一次）
      if (dialogEnabled && now - started >= dialogAfter && now - lastDialogCheck >= 4000) {
        lastDialogCheck = now
        const d = await this.findModalDialogs(plan.project.path, { pids: rec.pid ? [Number(rec.pid)] : undefined }).catch(() => null)
        if (d && Array.isArray(d.dialogs) && d.dialogs.length > 0) {
          rec.ready = false
          return { ready: false, waitedMs: now - started, timedOut: false, dialogBlocked: true, dialogs: d.dialogs }
        }
      }
      await this._sleep(pollMs)
    }
  }

  /**
   * 启动 Unity 编辑器，等待实例出现并（默认）自动绑定本会话。
   * @param sessionId 调用方 DSH 会话 id（用于绑定）
   * @param opts project / projectPath / editorPath / version / serviceId / waitReady / waitMs / bind / force
   */
  async launch(sessionId, opts = {}) {
    const plan = this.planLaunch(opts)
    const force = opts.force === true
    // v0.5.8：目标服务全离线且配了 startCommand → 先拉起 mcp-for-unity 服务（Unity 侧 Auto-Start 被
    // 安全策略/代理 env 挡住时也能连上；服务已在线则跳过）
    const server = await this.ensureServerForLaunch(plan)
    const running = this.projectRunning(plan.project.path)
    if (running && !force) {
      await this.probe().catch(() => {})
      const hit = this.findInstanceByProject(plan.projectName, plan.serviceId)
      let binding = null
      let bindError = null
      if (hit && opts.bind !== false) {
        try { binding = await this.bind(sessionId, { instance: hit.instance.id, serviceId: hit.serviceId, force: true }) }
        catch (err) { bindError = String(err?.message ?? err) }
      }
      return {
        ok: true,
        launched: false,
        alreadyRunning: true,
        sessionId,
        project: { name: plan.project.name, path: plan.project.path, version: plan.project.version, hasMcpPackage: plan.project.hasMcpPackage, mcpSource: plan.project.mcpSource },
        editor: { exe: plan.editor.exe, version: plan.editor.version, requestedVersion: plan.editor.requestedVersion, mismatch: plan.editor.mismatch },
        running: { pid: running.pid, source: running.source, lockFile: running.lockFile || null },
        ready: Boolean(hit),
        instance: hit ? { id: hit.instance.id, name: hit.instance.name, hash: hit.instance.hash, serviceId: hit.serviceId, serviceName: hit.serviceName } : null,
        binding: binding ? { serviceId: binding.serviceId, instanceId: binding.instanceId, toolsCount: binding.toolsCount, toolsError: binding.toolsError || null, activateError: binding.activateError || null } : null,
        bindError,
        server,
        hint: [hit ? '该工程已在运行，已直接绑定现有实例（未重复启动）。' : '该工程已在运行（Temp/UnityLockfile 存在），未重复启动；等实例出现在池中后可 unity_pool_bind。', server && server.hint].filter(Boolean).join(' '),
        view: this.view(sessionId),
      }
    }
    // 日志目录必须存在：Unity 的 -logFile 在目录不存在时可能直接退出
    try { fs.mkdirSync(path.dirname(plan.logFile), { recursive: true }) } catch (err) {
      throw new Error('无法创建启动日志目录 ' + path.dirname(plan.logFile) + '：' + String(err?.message ?? err))
    }
    const before = new Set(this._instancesForLaunch(plan.serviceId).map(x => x.serviceId + '::' + x.instance.id))
    let child
    try {
      child = this._spawnEditor(plan.editor.exe, plan.args)
    } catch (err) {
      throw new Error('启动 Unity 失败（' + plan.editor.exe + '）：' + String(err?.message ?? err))
    }
    const pid = child && child.pid
    const rec = {
      pid,
      projectName: plan.projectName,
      projectPath: plan.project.path,
      projectVersion: plan.project.version,
      editorExe: plan.editor.exe,
      editorVersion: plan.editor.version,
      logFile: plan.logFile,
      serviceId: plan.serviceId || null,
      sessionId,
      startedAt: Date.now(),
      ready: false,
      instanceId: null,
      boundAt: null,
    }
    if (pid) this.launches.set(pid, rec)
    const waitReady = opts.waitReady !== false
    let wait = { ready: false, waitedMs: 0, timedOut: false }
    if (waitReady) wait = await this.waitForLaunch(plan, rec, sessionId, { ...opts, before })
    const hintParts = []
    if (plan.editor.mismatch) hintParts.push('工程版本 ' + (plan.project.version || '未知') + ' 与已装编辑器 ' + plan.editor.version + ' 不一致，Unity 可能提示升级/切换版本。')
    if (!plan.project.hasMcpPackage) hintParts.push('该工程未发现 mcp-for-unity（Packages/manifest.json 或 Assets/Plugins/CoplayDev/MCPForUnity），启动后不会出现在服务池（需先装 MCP 包）。')
    if (waitReady && !wait.ready) hintParts.push('编辑器已启动但 ' + Math.round(wait.waitedMs / 1000) + 's 内未发现实例（可能仍在首次导入/编译）。稍后调 unity_pool_status 或 unity_pool_scan 再看；启动日志: ' + plan.logFile)
    // 超时仍未就绪时再兜底查一次模态窗（版本/保存确认会一直阻塞导入）
    let dialogs = Array.isArray(wait.dialogs) ? wait.dialogs : null
    if (waitReady && !wait.ready && !dialogs && this.cfg.launchDialogCheckEnabled !== false) {
      const d = await this.findModalDialogs(plan.project.path, { pids: pid ? [Number(pid)] : undefined }).catch(() => null)
      if (d && Array.isArray(d.dialogs) && d.dialogs.length > 0) dialogs = d.dialogs
    }
    if (wait.dialogBlocked) hintParts.push('检测到模态窗（可能阻塞导入），已提前停止等待；用 unity_pool_dialog 查看并选择选项（如 Continue / Don\'t Save / OK）。')
    else if (dialogs) hintParts.push('检测到模态窗：' + dialogs.map(d => d.title || '(无标题)').join('、') + '；用 unity_pool_dialog 查看/选择选项。')
    if (server && server.hint) hintParts.push(server.hint)
    if (server && server.started && server.alive === false) hintParts.push('若 Unity 侧 MCP 窗口的 Local URL 不是回环地址（如 http://192.168.x.x:8080），Auto-Start 会被安全策略拒绝，需改成 http://127.0.0.1:8080。')
    if (!pid) hintParts.push('未能取得编辑器进程 PID（进程可能已立即退出，见启动日志）。')
    return {
      ok: true,
      launched: true,
      alreadyRunning: false,
      sessionId,
      project: { name: plan.project.name, path: plan.project.path, version: plan.project.version, hasMcpPackage: plan.project.hasMcpPackage, mcpSource: plan.project.mcpSource },
      editor: { exe: plan.editor.exe, version: plan.editor.version, requestedVersion: plan.editor.requestedVersion, mismatch: plan.editor.mismatch },
      serviceId: plan.serviceId || null,
      pid,
      logFile: plan.logFile,
      ready: wait.ready === true,
      waitedMs: wait.waitedMs,
      matchedBy: wait.matchedBy || null,
      instance: wait.ready ? { id: wait.instance.id, name: wait.instance.name, hash: wait.instance.hash, serviceId: wait.serviceId, serviceName: wait.serviceName } : null,
      binding: wait.binding ? { serviceId: wait.binding.serviceId, instanceId: wait.binding.instanceId, toolsCount: wait.binding.toolsCount, toolsError: wait.binding.toolsError || null, activateError: wait.binding.activateError || null } : null,
      bindError: wait.bindError || null,
      dialogBlocked: Boolean(wait.dialogBlocked),
      dialogs: dialogs || null,
      server,
      hint: hintParts.join(' ') || null,
      view: this.view(sessionId),
    }
  }

  /** 启动能力摘要（工程清单 + 最近启动记录），供 unity_pool_status / 客户端读取。 */
  launchStatus() {
    const projects = this.cfg.projects.map(p => {
      const abs = path.resolve(expandHome(p.path))
      const exists = fs.existsSync(abs)
      const valid = exists && fs.existsSync(path.join(abs, 'Assets')) && fs.existsSync(path.join(abs, 'ProjectSettings'))
      const version = p.version || (exists ? readProjectVersion(abs) : '')
      const running = exists ? this.projectRunning(abs) : null
      let editor = null
      try { editor = this.resolveEditor({ version }) } catch { editor = null }
      const mcpSource = exists ? detectMcpSource(abs) : null
      return {
        name: p.name,
        path: abs,
        version,
        serviceId: p.serviceId || '',
        exists,
        valid,
        hasMcpPackage: mcpSource !== null,
        mcpSource,
        running: Boolean(running),
        runningPid: running && running.pid ? running.pid : null,
        editor: editor ? { exe: editor.exe, version: editor.version, mismatch: editor.mismatch } : null,
      }
    })
    const launches = [...this.launches.values()].slice(-10).map(r => ({
      pid: r.pid,
      projectName: r.projectName,
      projectPath: r.projectPath,
      editorVersion: r.editorVersion,
      startedAt: r.startedAt,
      ready: r.ready === true,
      instanceId: r.instanceId,
      alive: this.isPidAlive(r.pid),
      logFile: r.logFile,
    }))
    return {
      enabled: this.cfg.launchEnabled !== false,
      waitReadyMs: this.cfg.launchWaitReadyMs,
      pollIntervalMs: this.cfg.launchPollIntervalMs,
      allowAnyProject: this.cfg.allowAnyProject !== false,
      allowVersionMismatch: this.cfg.allowVersionMismatch !== false,
      editorRoots: this.cfg.editorRoots,
      projects,
      launches,
    }
  }

  start() {
    if (this.probeTimer) return
    this.probe()
    this.probeTimer = setInterval(() => { this.probe() }, Math.max(1000, this.cfg.probeIntervalMs))
    if (this.probeTimer.unref) this.probeTimer.unref()
    this.startStateTimer()
    this.startDialogTimer()
  }

  stop() {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
    if (this._disposedUnbindDisposer) { try { this._disposedUnbindDisposer() } catch { /* ignore */ } this._disposedUnbindDisposer = null }
    this.stopStateTimer()
    this.stopDialogTimer()
    this.disposeAllNativeTools()
  }

  // ---- 原生工具注册（v0.5.0，2026-08-21）----
  // 绑定后把该服务的 MCP 工具动态注册为 DSH 原生工具（umcp_<工具名>），模型上下文直接可见可调。
  // 设计：
  //  - 注册键 = 服务：syncNativeTools(serviceId) 先注销该服务旧注册，再按最新 tools/list 全量重注册；
  //  - 跨服务同名（两个 mcp-for-unity 服务都有 manage_scene）→ 后绑定者接管（先注销旧占用方同名工具）；
  //  - 解绑不注销（其他会话可能绑定同一服务）；stop() 时全量注销（ctx.tools.register 返回的 disposer）；
  //  - schema 形态：compact（默认，参数名+description，省上下文）/ full（完整 inputSchema，Claude 同款）；
  //  - execute 统一转发 pool.proxyMcp（未绑定报错/实例激活/忙等待/未知工具提示全部复用）。

  /** 已注册原生工具摘要（view 用）：按服务返回 {serviceId, count, names}。 */
  nativeToolsSummary() {
    const out = []
    for (const [serviceId, regs] of this.nativeDisposers) {
      if (!regs || regs.size === 0) continue
      out.push({
        serviceId,
        count: regs.size,
        names: [...regs.keys()], // 注册顺序（v0.5.4：自定义工具在前）
      })
    }
    return out
  }

  /** 注销某服务的全部原生工具（旧注册；同名刷新时先清后注）。 */
  _disposeNativeServiceTools(serviceId) {
    const regs = this.nativeDisposers.get(serviceId)
    if (!regs) return
    for (const [umcpName, d] of regs) {
      try { d() } catch { /* 注销失败不影响继续 */ }
      if (this.nativeToolOwner.get(umcpName) === serviceId) this.nativeToolOwner.delete(umcpName)
    }
    this.nativeDisposers.delete(serviceId)
  }

  /** 注销全部服务的原生工具（插件 stop 时调用）。 */
  disposeAllNativeTools() {
    for (const serviceId of [...this.nativeDisposers.keys()]) {
      this._disposeNativeServiceTools(serviceId)
    }
  }

  /**
   * 按某服务最新 tools/list 同步注册原生工具（幂等：先清旧再全量重注册）。
   * tools 为 MCP 工具数组（name/description/inputSchema）；空数组 = 只清空。
   * 未启用 nativeToolsEnabled 或当前 ctx 无 tools 注册器时直接跳过。
   */
  syncNativeTools(serviceId, tools, customNames) {
    if (this.cfg.nativeToolsEnabled === false) return
    if (!this._toolRegistry) return // createPool 的测试 ctx 可能无 tools
    const list = Array.isArray(tools) ? tools : []
    // v0.5.4：注册顺序 = 传入顺序（调用方已按「自定义工具优先」重排）→ 模型工具清单里自定义排前面
    const customSet = new Set(Array.isArray(customNames) ? customNames : [])
    this._disposeNativeServiceTools(serviceId)
    if (list.length === 0) return
    const regs = new Map()
    for (const t of list) {
      const origName = t && typeof t.name === 'string' ? t.name : null
      if (!origName) continue
      const umcpName = 'umcp_' + origName.replace(/[^A-Za-z0-9_-]/g, '_')
      // 跨服务同名接管：注销旧占用方（若有）
      const prevOwner = this.nativeToolOwner.get(umcpName)
      if (prevOwner && prevOwner !== serviceId) {
        const pold = this.nativeDisposers.get(prevOwner)
        if (pold && pold.has(umcpName)) {
          try { pold.get(umcpName)() } catch { /* ignore */ }
          pold.delete(umcpName)
        }
        this.nativeToolOwner.delete(umcpName)
      }
      try {
        const disposer = this._registerNativeTool(serviceId, umcpName, origName, t, customSet.has(origName))
        regs.set(umcpName, disposer)
        this.nativeToolOwner.set(umcpName, serviceId)
      } catch (err) {
        this.ctx?.logger?.warn?.('[unity-pool] 注册原生工具 ' + umcpName + ' 失败: ' + String(err?.message ?? err))
      }
    }
    if (regs.size > 0) this.nativeDisposers.set(serviceId, regs)
  }

  /** 注册单个原生工具（umcp_<原名> → proxyMcp 转发）。返回 DSH tools.register 的 disposer。 */
  _registerNativeTool(serviceId, umcpName, origName, mcpTool, isCustom) {
    const pool = this
    const full = this.cfg.nativeToolSchema === 'full'
    const rawDesc = String(mcpTool.description ?? '').trim()
    const desc = '（unity-pool 原生代理 ' + serviceId + '：'
      + (isCustom ? '★本工程自定义工具 ' : 'Unity MCP 工具 ') + origName + '）'
      + (rawDesc ? (full ? '\n' + rawDesc : '\n' + (rawDesc.length > 300 ? rawDesc.slice(0, 300) + '…' : rawDesc)) : '')
      + ' 调用前需先用 unity_pool_bind 锁定本会话目标实例；本工具等价于 unity_mcp(tool="' + origName + '", params=...) 的直接调用。'
    const parameters = this._mcpParamsToSpec(mcpTool.inputSchema)
    return this._toolRegistry.register(defineTool({
      name: umcpName,
      description: desc,
      parameters,
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: typeof v.text === 'string' ? v.text : JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        return await pool.proxyMcp(sessionId, origName, args, undefined)
      },
    }))
  }

  /** MCP inputSchema（标准 JSON Schema object root）→ DSH defineTool parameters（property map）。 */
  _mcpParamsToSpec(inputSchema) {
    if (!inputSchema || typeof inputSchema !== 'object') return {}
    const props = inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {}
    const required = Array.isArray(inputSchema.required) ? new Set(inputSchema.required) : new Set()
    const spec = {}
    for (const [key, v] of Object.entries(props)) {
      if (!v || typeof v !== 'object') continue
      const p = this._mcpValueToSpec(v)
      if (!p) continue
      if (required.has(key)) p.required = true
      spec[key] = p
    }
    return spec
  }

  /** MCP 属性 JSON Schema → DSH ValueSchemaSpec。
   *  compact（默认）：基础标量类型保留（string/number/integer/boolean），复杂/嵌套（array/object/anyOf/未知）
   *    降级宽松 json（不校验，由 Unity 侧 pydantic 裁决），description 截断 —— 省上下文且不误拒合法参数；
   *  full：完整 inputSchema 逐级映射（Claude 注册 MCP 工具同款）。 */
  _mcpValueToSpec(s) {
    if (!s || typeof s !== 'object') return null
    const desc = typeof s.description === 'string' ? s.description : ''
    const extra = Array.isArray(s.enum) && s.enum.length > 0 ? ' 可选值: ' + JSON.stringify(s.enum) : ''
    const t = Array.isArray(s.type) ? s.type[0] : s.type
    if (this.cfg.nativeToolSchema !== 'full') {
      const d = (desc + extra).slice(0, 200)
      switch (t) {
        case 'string': return { type: 'string', description: d }
        case 'number': return { type: 'number', description: d }
        case 'integer': return { type: 'integer', description: d }
        case 'boolean': return { type: 'boolean', description: d }
        default: return { type: 'json', description: d }
      }
    }
    switch (t) {
      case 'string':
        return { type: 'string', description: desc, ...(Array.isArray(s.enum) ? { enum: s.enum.filter(x => typeof x === 'string') } : {}) }
      case 'number':
        return { type: 'number', description: desc }
      case 'integer':
        return { type: 'integer', description: desc }
      case 'boolean':
        return { type: 'boolean', description: desc }
      case 'array':
        return { type: 'array', items: this._mcpValueToSpec(Array.isArray(s.items) ? s.items[0] : s.items) ?? { type: 'json' }, description: desc }
      case 'object': {
        const inner = this._mcpParamsToSpec(s)
        return { type: 'object', properties: inner, additionalProperties: true, description: desc }
      }
      default:
        return { type: 'json', description: desc }
    }
  }

  // ---- 绑定（实例级） ----

  sessionsTargeting(instanceId) {
    return Object.entries(this.bindings)
      .filter(([, b]) => b.instanceId === instanceId)
      .map(([sid]) => sid)
  }

  bindingOf(sessionId) {
    const b = this.bindings[sessionId]
    if (!b) return null
    const svc = this.serviceById(b.serviceId)
    if (!svc) return null
    const inst = svc.instances.find(i => i.id === b.instanceId) || (b.instanceId ? { id: b.instanceId, name: b.instanceId, hash: '' } : null)
    return { serviceId: b.serviceId, instanceId: b.instanceId, boundAt: b.boundAt, service: svc, instance: inst }
  }

  // ---- 状态携带（v0.4.0）----

  /** 是否为本会话启用状态携带（总开关开 + 至少一项子开关开；v0.4.2 按会话读开关）。 */
  stateCarryEnabled(sessionId) {
    const sw = this.getStateSwitches(sessionId)
    if (sw.stateEnabled !== true) return false
    return sw.stateGameScreenshot || sw.stateSceneScreenshot || sw.stateSelection
      || sw.stateUiSnapshot || sw.stateSerialized || sw.stateConsoleAll
      || sw.stateConsoleSelected || sw.stateConsoleError
  }

  /** 截断助手：超长文本截断并标注（防超长注入）。 */
  static truncate(text, maxChars, label) {
    const s = String(text ?? '')
    if (s.length <= maxChars) return s
    return s.slice(0, maxChars) + '\n…[已截断 ' + s.length + ' 字符，仅显示前 ' + maxChars + ' 字符]'
  }

  /** Console 专用截断：read_console 返回旧→新数组，这里优先保留「最新」条目。
   *  从尾部向前按行累加，尽量整条保留；单条超预算时掐该条尾部。
   *  前缀标注省略的旧条数（行感知，避免此前 slice(0,maxChars) 把最新日志全裁掉→ 只见旧不见新）。 */
  static truncateConsole(entries, maxChars, label = 'Console') {
    const items = (Array.isArray(entries) ? entries : [String(entries ?? '')]).map(x => String(x)).filter(Boolean)
    if (!items.length) return ''
    const full = items.join('\n')
    if (full.length <= maxChars) return full
    const kept = []
    let used = 0
    for (let i = items.length - 1; i >= 0; i--) {
      const sep = kept.length ? 1 : 0
      const s = items[i]
      const room = maxChars - used - sep
      if (room <= 0) break
      if (s.length <= room) {
        kept.unshift(s); used += sep + s.length
      } else {
        const cutRoom = Math.max(0, room - 1)
        kept.unshift('…' + s.slice(s.length - cutRoom)); used += sep + 1 + cutRoom
        break
      }
    }
    const dropped = items.length - kept.length
    const note = '\n…[' + label + ' 超预算：显示最新 ' + kept.length + ' 条，省略 ' + dropped + ' 条更早日志（原 ' + items.length + ' 条 / ' + full.length + ' 字符）]'
    return note + '\n' + kept.join('\n')
  }

  /** 会话状态目录（截图 PNG 落盘，按会话隔离）。 */
  stateDirOf(sessionId) {
    const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
    return path.join(this.cfg.stateDir, safe)
  }

  /**
   * 采集一个会话的状态快照（异步走该会话 MCP client，各开关项独立容错，单项失败不阻断整体）。
   * 结果写入 this.stateCaches[sessionId]；截图 PNG 落盘到 stateDirOf(sessionId)。
   */
  async collectState(sessionId, opts = {}) {
    // 全局防重入：已有采集在跑 → 返回**同一个在飞 Promise**（调用方 await 到它结束），而不是 null——
    // 冷启动补齐（ensureStateTextForTurn）正是靠等待「消息/开关触发的采集」完成（v0.5.6）。
    if (this._stateCollecting) return this._stateCollectingPromise || null
    this._stateCollecting = true
    const run = this._collectStateOnce(sessionId, opts)
    this._stateCollectingPromise = run
    try {
      return await run
    } finally {
      this._stateCollecting = false
      this._stateCollectingPromise = null
    }
  }

  /** 单次采集实现（防重入与在飞登记由 collectState 负责）。 */
  async _collectStateOnce(sessionId, opts = {}) {
    try {
      const sw = this.getStateSwitches(sessionId) // v0.4.2：按会话读开关（各自控制自己的采集项）
      const binding = this.bindingOf(sessionId)
      if (!binding || !binding.serviceId) return null
      const service = this.serviceById(binding.serviceId)
      if (!service) return null
      const instance = binding.instanceId
      if (!instance) return null
      const client = this.sessionClient(sessionId, service)
      // v0.5.7：状态采集同样走「每调用路由」——绑定实例随每次 tools/call 下发
      client.pinnedInstance = instance
      await client.ensureInit()
      if (client.activeInstance !== instance) await client.setActive(instance)

      // 忙时跳过（v0.4.1，2026-08-20 用户第 3 次遇到「Unity 反复读条」）：Unity 编译/刷新/进度条期间
      // 不采集（保留旧缓存），避免采集路径撞主线程加剧读条。此前只给 unity_mcp 代理加了忙时等待，
      // 采集路径（collectState）漏了——且 ui_snapshot force_refresh 每次全量重扫让问题放大。
      try {
        const probe = await probeEditorState(client)
        if (!probe.ok || probe.busy) return null
      } catch { return null }

      const entries = []
      const at = Date.now()

      // Game / Scene 视图截图（PNG 落盘，上下文给路径）
      const shot = async (key, label, captureSource, fileName) => {
        try {
          const res = await client.callTool('manage_camera', {
            action: 'screenshot',
            capture_source: captureSource,
            include_image: true,
            max_resolution: this.cfg.stateScreenshotMaxRes,
          })
          if (res.isError) throw new Error(res.text || 'manage_camera failed')
          const img = Array.isArray(res.content) ? res.content.find(b => b && b.type === 'image' && typeof b.data === 'string') : null
          if (!img) {
            entries.push({ key, label, ok: false, error: '截图响应没有图片块（include_image 未生效？）' })
            return
          }
          const buf = Buffer.from(img.data, 'base64')
          const dir = this.stateDirOf(sessionId)
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, fileName)
          fs.writeFileSync(file, buf)
          // updatedAt：状态块里显示「更新 HH:MM:SS」，截图刷新后文本变化 → 宿主去重重新注入
          entries.push({ key, label, ok: true, file, updatedAt: Date.now(), width: Number(res.structuredContent?.data?.imageWidth) || undefined })
        } catch (err) {
          entries.push({ key, label, ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // 当前选中项（Hierarchy / Project 统一读取 UnityEditor.Selection）
      const SELECTION_CODE = [
        'var sb=new System.Text.StringBuilder();',
        'var objs=UnityEditor.Selection.objects;',
        'sb.Append("count=").Append(objs!=null?objs.Length:0);',
        'if(objs!=null){foreach(var o in objs){',
        '  if(o==null){sb.Append(System.Environment.NewLine).Append("- null");continue;}',
        '  sb.Append(System.Environment.NewLine).Append("- ").Append(o.name).Append(" | type=").Append(o.GetType().Name);',
        '  var go=o as GameObject;',
        '  if(go!=null){sb.Append(" | id=").Append(go.GetInstanceID());',
        '    var parts=new System.Collections.Generic.List<string>();var t=go.transform;',
        '    while(t!=null){parts.Insert(0,t.name);t=t.parent;}',
        '    sb.Append(" | path=").Append(string.Join("/",parts.ToArray()));}',
        '  var p=UnityEditor.AssetDatabase.GetAssetPath(o);',
        '  if(!string.IsNullOrEmpty(p))sb.Append(" | asset=").Append(p);',
        '}}',
        'return sb.ToString();',
      ].join('')

      let selectionText = ''
      const execSelection = async () => {
        const res = await client.callTool('execute_code', { action: 'execute', code: SELECTION_CODE, safety_checks: true })
        if (res.isError) throw new Error(res.text || 'execute_code failed')
        try {
          const parsed = typeof res.structuredContent?.data?.result === 'string'
            ? res.structuredContent.data.result
            : JSON.parse(res.text).data?.result
          return String(parsed ?? res.text)
        } catch { return String(res.text) }
      }

      if (sw.stateSelection) {
        try {
          selectionText = await execSelection()
          entries.push({ key: 'selection', label: '当前选中项', ok: true, text: UnityPool.truncate(selectionText, this.cfg.stateMaxChars, '选中项') })
        } catch (err) {
          entries.push({ key: 'selection', label: '当前选中项', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      } else if (sw.stateUiSnapshot || sw.stateSerialized) {
        // ui-snapshot / 序列化字段依赖选中 GameObject：即使 selection 开关关，也内部取一次选中项
        try { selectionText = await execSelection() } catch { /* 忽略，后续项会报错 */ }
      }

      // 选中 GameObject 第一个 id（供 ui-snapshot / 序列化字段使用）。
      // 注意：场景内 GameObject 的 InstanceID 是负数（正数是资源资产），正则必须支持负号——
      // 曾用 id=(\d+) 导致场景物体永远解析失败、误报“不是 GameObject”（2026-08-20 实测）。
      const firstGoId = (() => {
        const m = /- ([^\n]+) \| type=GameObject \| id=(-?\d+)/.exec(selectionText)
        return m ? Number(m[2]) : null
      })()
      // 选中项摘要（失败注入时附带，让 Agent/用户不用读就能知道选中了什么）
      const selBriefText = selectionText && selectionText.includes('count=')
        ? UnityPool.truncate(selectionText.split('\n').slice(0, 2).join('\n'), 400, '选中项')
        : ''

      // 选中物体 ui-snapshot 快照（自定义工具，未注册则报错提示）
      if (sw.stateUiSnapshot) {
        try {
          if (!firstGoId) throw new Error(selectionText.includes('count=0') ? '当前没有选中物体' : '选中项不是 GameObject（无法做 ui-snapshot）')
          const res = await client.callTool('ui_snapshot', {
            ids: [firstGoId],
            include_children: true,
            // 必须包含未激活物体：选中项常是隐藏的 UI 面板（inactive），
            // 传 false 会把根物体整个排除、返回 0 nodes 空快照（2026-08-20 实测：健康-弹窗2（半面板）inactive）
            include_inactive: true,
            // 引用/被引用带名字（默认只显示实例ID；用户需要引用明细可读，2026-08-20）
            names_in_refs: true,
            max_nodes: 120,
            max_refs: 120,
            // 工具侧给足预算（避免工具先截断），插件再按「树/引用/被引用」预算分配保证引用部分可见
            max_chars: 20000,
            // 缓存优先（v0.4.1，2026-08-20 用户第 3 次遇到「Unity 反复读条」的根因之一）：
            // force_refresh=true 让每次采集（含 3s 轮询）都全量重建快照——8933 节点快照重扫打满主线程。
            // 工具缓存按 ids 键控：同一选中反复采集命中缓存（零重扫）；换选中 = 新 ids 自动新生成。
            force_refresh: false,
          })
          if (res.isError) throw new Error(res.text || 'ui_snapshot failed')
          let text = res.text
          let mapText = null
          try {
            const parsed = JSON.parse(res.text)
            if (parsed && typeof parsed.data?.text === 'string') text = parsed.data.text
            else if (parsed && typeof parsed.data?.summary?.nodeCount === 'number') {
              text = '节点 ' + parsed.data.summary.nodeCount + ' 个 / 引用 ' + parsed.data.summary.refCount + ' 个（完整快照见 Library ' + (parsed.data.summary.libraryPath || '') + '）'
            }
            // 快照地图模式（v0.4.1，2026-08-20 用户设计指导）：解析 Library JSON（同机绝对路径）生成
            // 分层地图（概览/分支/业务引用/锚点/定位指引）——超大快照下比平铺截断树信息密度高得多；
            // JSON 解析失败回退下方 md/data.text 压缩流程。
            if (parsed?.data?.summary?.absolutePath) {
              try {
                const jsonPath = String(parsed.data.summary.absolutePath)
                const snap = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''))
                if (Array.isArray(snap.nodes) && Array.isArray(snap.refs) && snap.nodes.length > 0) {
                  snap.libraryPath = parsed.data.summary.libraryPath || ''
                  mapText = buildUiSnapshotMap(snap, this.cfg.stateSnapshotMaxChars)
                }
              } catch { /* 读不到 JSON：走文本压缩 */ }
            }
            if (mapText === null && parsed?.data?.summary?.absolutePath) {
              // 大快照优化（2026-08-20）：工具 data.text 受 max_chars 截断（1849 节点只给前 120），
              // 读 Library 完整 markdown 补全树（md 的 Refs/Backrefs 不带物体名 → 只取 Tree 段，
              // Refs/Backrefs 仍用 data.text 带名字；strip UTF-8 BOM）。
              try {
                const mdPath = String(parsed.data.summary.absolutePath).replace(/\.json$/i, '.md')
                const md = fs.readFileSync(mdPath, 'utf8').replace(/^\uFEFF/, '')
                const mdRefs = md.indexOf('Refs (outgoing):')
                if (mdRefs > 0 && md.includes('Tree:')) {
                  const dataRefs = text.indexOf('Refs (outgoing):')
                  text = md.slice(0, mdRefs) + (dataRefs >= 0 ? text.slice(dataRefs) : md.slice(mdRefs))
                }
              } catch { /* 文件缺失/不可读：保持 data.text */ }
            }
          } catch { /* 文本原样 */ }
          // 地图模式优先；否则树/引用/被引用按预算分块压缩（曾因整体截断把引用明细全裁掉，2026-08-20）
          const finalText = mapText !== null
            ? mapText
            : compactUiSnapshot(text, this.cfg.stateSnapshotMaxChars)
          entries.push({ key: 'uiSnapshot', label: '选中项 ui-snapshot', ok: true, text: UnityPool.truncate(finalText, this.cfg.stateSnapshotMaxChars, 'ui-snapshot') })
        } catch (err) {
          // 失败也把选中项基本信息带上（注入块直接可见“选中了什么”，而不是只有误导性报错）
          entries.push({ key: 'uiSnapshot', label: '选中项 ui-snapshot', ok: false, error: String(err?.message ?? err).slice(0, 200) + (selBriefText ? '；选中项：' + selBriefText : '') })
        }
      }

      // 选中物体序列化字段（components 资源，防超长截断）
      if (sw.stateSerialized) {
        try {
          if (!firstGoId) throw new Error(selectionText.includes('count=0') ? '当前没有选中物体' : '选中项不是 GameObject（无法读取序列化字段）')
          const res = await client.call('resources/read', { uri: 'mcpforunity://scene/gameobject/' + firstGoId + '/components' })
          let text = ''
          for (const c of (res && res.contents) || []) {
            if (typeof c?.text === 'string') { text = c.text; break }
          }
          if (!text) throw new Error('components 资源返回空')
          // 精简：提取组件名 + 属性（过滤大字段噪音），仍受 maxChars 保护
          try {
            const parsed = JSON.parse(text)
            const comps = parsed?.data?.components || []
            const lines = comps.map(comp => {
              const props = comp?.properties || {}
              const keys = Object.keys(props)
              const brief = keys.slice(0, 24).map(k => k + '=' + formatProp(props[k])).join(', ')
              const extra = keys.length > 24 ? ' …(还有 ' + (keys.length - 24) + ' 个字段)' : ''
              return '-' + (comp.typeName || '?') + ' [' + keys.length + ' 字段]: ' + brief + extra
            })
            text = '组件数 ' + comps.length + '\n' + lines.join('\n')
          } catch { /* 保留原始 JSON 文本 */ }
          entries.push({ key: 'serialized', label: '选中物体序列化字段', ok: true, text: UnityPool.truncate(text, this.cfg.stateMaxChars, '序列化字段') })
        } catch (err) {
          entries.push({ key: 'serialized', label: '选中物体序列化字段', ok: false, error: String(err?.message ?? err).slice(0, 200) + (selBriefText ? '；选中项：' + selBriefText : '') })
        }
      }

      // Console 全文（read_console，count + 截断防超长）
      if (sw.stateConsoleAll) {
        try {
          const res = await client.callTool('read_console', {
            action: 'get',
            types: ['all'],
            count: String(this.cfg.stateConsoleCount),
            format: 'plain',
            include_stacktrace: false,
          })
          if (res.isError) throw new Error(res.text || 'read_console failed')
          let text = res.text
          let consoleArr = null
          try {
            const parsed = JSON.parse(res.text)
            if (Array.isArray(parsed?.data)) { consoleArr = parsed.data; text = parsed.data.join('\n') }
            else if (parsed?.data && typeof parsed.data === 'object') text = JSON.stringify(parsed.data)
          } catch { /* 原样 */ }
          entries.push({ key: 'consoleAll', label: 'Console 全文', ok: true, text: UnityPool.truncateConsole(consoleArr || [text], this.cfg.stateConsoleMaxChars, 'Console') })
        } catch (err) {
          entries.push({ key: 'consoleAll', label: 'Console 全文', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // Console 错误（仅 error 级，read_console types=['error']，count + 截断防超长）
      if (sw.stateConsoleError) {
        try {
          const res = await client.callTool('read_console', {
            action: 'get',
            types: ['error'],
            count: String(this.cfg.stateConsoleCount),
            format: 'plain',
            include_stacktrace: false,
          })
          if (res.isError) throw new Error(res.text || 'read_console failed')
          let text = res.text
          let consoleArr = null
          try {
            const parsed = JSON.parse(res.text)
            if (Array.isArray(parsed?.data)) {
              // 剔除 Unity 缺脚本/缺 Behaviour 的黄色警告（mcp-for-unity 误标为 Error）
              consoleArr = parsed.data.filter(x => !UNITY_MISSING_SCRIPT_RE.test(String(x?.message ?? x ?? '')))
              text = consoleArr.join('\n')
            }
            else if (parsed?.data && typeof parsed.data === 'object') text = JSON.stringify(parsed.data)
          } catch { /* 原样 */ }
          entries.push({ key: 'consoleError', label: 'Console 错误', ok: true, text: UnityPool.truncateConsole(consoleArr || [text], this.cfg.stateConsoleMaxChars, 'Console 错误') })
        } catch (err) {
          entries.push({ key: 'consoleError', label: 'Console 错误', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // Console 选中条目（反射 ConsoleWindow.m_ActiveText）
      if (sw.stateConsoleSelected) {
        try {
          const res = await client.callTool('execute_code', { action: 'execute', code: CONSOLE_SELECTED_CODE, safety_checks: true })
          if (res.isError) throw new Error(res.text || 'execute_code failed')
          let text = ''
          try {
            text = typeof res.structuredContent?.data?.result === 'string' ? res.structuredContent.data.result : JSON.parse(res.text).data?.result
          } catch { text = res.text }
          if (/^NO_CONSOLE_WINDOW/.test(text)) throw new Error('Console 窗口未打开')
          entries.push({ key: 'consoleSelected', label: 'Console 选中条目', ok: true, text: UnityPool.truncate(text, this.cfg.stateConsoleMaxChars, 'Console 选中') })
        } catch (err) {
          entries.push({ key: 'consoleSelected', label: 'Console 选中条目', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // 截图（最后采集，避免拖慢文本项）；opts.skipScreenshots=true（后台轮询）时跳过——
      // 截图会让 Unity 窗口闪烁/任务栏提醒，只由「开关切换 / unity_pool_state 刷新 / 注入时按需触发」采集
      if (!opts?.skipScreenshots) {
        if (sw.stateGameScreenshot) await shot('gameShot', 'Game 视图截图', 'game_view', 'game.png')
        if (sw.stateSceneScreenshot) await shot('sceneShot', 'Scene 视图截图', 'scene_view', 'scene.png')
      }

      this.stateCaches.set(sessionId, { at, instanceId: instance, entries })
      return this.stateCaches.get(sessionId)
    } catch (err) {
      this.ctx?.logger?.warn?.('[unity-pool] 状态采集失败: ' + String(err?.message ?? err))
      return null
    }
  }

  /**
   * 取 agent 会话最近一次回合号（turn/start 事件）：agent-loop 每处理一轮
   * 用户输入就 append 一次 turn/start（packages/core/agent-loop，turn 单调递增）。
   * 返回 -1 表示拿不到回合号（无法去重）。
   */
  stateTurnOf(agent) {
    const session = agent && agent.session
    const events = session && Array.isArray(session.events) ? session.events : null
    if (!events) return -1
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') return ev.data.turn
    }
    return 0
  }

  /**
   * 每回合状态只注入一次（v0.4.0 UX）：按回合号去重——同一回合（一次用户输入
   * + 其工具循环）内所有 agent request 的回合号相同：首个 request 注入并记录
   * 回合号，后续 request 回合号未变则跳过不重复注入；用户再次发消息 → 回合号
   * +1 → 自动携带最新快照。
   */
  stateInjectOnce(sessionId, turn) {
    const key = String(sessionId)
    if (turn <= 0) return true // 无法去重（无回合号），保持原行为
    const prev = this._stateTurnMap.get(key) || 0
    if (turn === prev) return false
    this._stateTurnMap.set(key, turn)
    return true
  }

  /**
   * 按回合返回状态块文本（v0.4.1 注入策略，2026-08-20 用户纠正设计）：
   * 回合首步生成并缓存文本，同回合所有 step 返回同一份——快照整段稳定 → 宿主整段去重 → 零重复注入；
   * 用户发新消息（回合号 +1）才重新生成（携带当时最新状态）并注入一次。
   * 无回合号（turn <= 0，非回合装配/子 agent）退化为每次重新生成。
   */
  stateTextForTurn(sessionId, turn) {
    const sid = String(sessionId)
    const key = turn > 0 ? turn : 0
    const cur = this._stateTurnTexts?.get(sid)
    if (cur && cur.turn === key) return cur.text
    const text = this.stateContextText(sessionId)
    // 只有有回合号才写缓存；无回合号（非回合装配）每次重新生成，且不得覆盖回合缓存。
    // v0.5.6：**空文本不入缓存**——缓存为空时首步必然为空，若把空串也缓存进本回合，
    // 采集在本回合内完成也补不进去（冷启动补齐的装配瀑布另有就地替换，这里是第二道保险）。
    if (turn > 0 && text) {
      this._stateTurnTexts ??= new Map()
      this._stateTurnTexts.set(sid, { turn: key, text })
    }
    return text
  }

  /**
   * 等待某会话的状态缓存就绪（v0.5.6）：已有缓存立即返回 true；
   * 否则等待在飞采集 / 触发一次采集（全局防重入下共享同一个 Promise），最多 budgetMs。
   */
  async waitForStateCache(sessionId, budgetMs) {
    const sid = String(sessionId)
    const hasCache = () => {
      const c = this.stateCaches.get(sid)
      return Boolean(c && Array.isArray(c.entries) && c.entries.length > 0)
    }
    if (hasCache()) return true
    const deadline = Date.now() + Math.max(0, Number(budgetMs) || 0)
    // 最多两轮：第一轮等（可能是别的会话在采 → 防重入返回的共享 Promise），
    // 缓存仍空且已无在飞采集时再自己发起一轮。
    for (let attempt = 0; attempt < 2; attempt++) {
      const remain = deadline - Date.now()
      if (remain <= 0) break
      const p = Promise.resolve(this.collectState(sid)).catch(() => null)
      try { await withTimeout(p, remain, "状态采集（冷启动补齐）") } catch { break }
      if (hasCache()) return true
    }
    return hasCache()
  }

  /**
   * 冷启动补齐（v0.5.6，2026-09-09 用户报「新会话绑定后开启状态、发消息没注入上下文」）：
   * systemPrompt.context.text 是**同步**函数，只能读已有缓存；而采集是异步的（MCP 往返 1~3s）。
   * 新会话 / 插件热重载 / 刚打开开关时缓存为空 → 首回合求值拿到空串（并按回合缓存空串）→ 整回合没有状态块。
   * 本方法在装配阶段被调用：缓存已有则返回空串（走常规注入路径，零开销）；
   * 否则有界等待一次采集，成功后返回最新状态块文本（并写入回合缓存，保证同回合各 step 一致）。
   */
  async ensureStateTextForTurn(sessionId, turn) {
    const sid = String(sessionId)
    const budget = Number(this.cfg.stateFirstTurnWaitMs)
    if (!(budget > 0)) return "" // 显式关闭冷启动补齐
    if (!this.stateCarryEnabled(sid)) return ""
    const cache = this.stateCaches.get(sid)
    if (cache && Array.isArray(cache.entries) && cache.entries.length > 0) return ""
    const now = Date.now()
    const cooldown = Math.max(1000, Number(this.cfg.stateCollectCooldownMs) > 0 ? Number(this.cfg.stateCollectCooldownMs) : 10000)
    const last = this._stateWaitAt.get(sid) || 0
    if (now - last < cooldown) return "" // 冷却中：不重复等待（采集刚失败过）
    this._stateWaitAt.set(sid, now)
    await this.waitForStateCache(sid, budget)
    const fresh = this.stateCaches.get(sid)
    if (!fresh || !Array.isArray(fresh.entries) || fresh.entries.length === 0) return ""
    const text = this.stateContextText(sid)
    if (text && turn > 0) {
      this._stateTurnTexts ??= new Map()
      this._stateTurnTexts.set(sid, { turn, text })
    }
    return text
  }

  /** 同步读取会话状态快照文本（context 注入用，绝不做异步 MCP 调用）。v0.4.2：按会话读开关。 */
  stateContextText(sessionId) {
    const sid = String(sessionId)
    const sw = this.getStateSwitches(sid)
    if (sw.stateEnabled !== true) return ''
    const cache = this.stateCaches.get(sid)
    if (!cache || !Array.isArray(cache.entries) || cache.entries.length === 0) return ''
    const lines = []
    for (const e of cache.entries) {
      if (e.ok) {
        if (e.file) lines.push('- [' + e.label + '] ' + e.file + (e.width ? '（宽 ' + e.width + 'px）' : '') + (e.updatedAt ? '（更新 ' + new Date(e.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) + '）' : '') + '（可用 read_image 工具查看）')
        else lines.push('- [' + e.label + '] ' + (e.text || '（无内容）'))
      } else {
        lines.push('- [' + e.label + '] 采集失败: ' + (e.error || 'unknown'))
      }
    }
    // 消息驱动兜底（v0.4.1，2026-08-20 用户纠正「只在发消息的时候采集」）：无后台轮询——
    // 回合首步求值发现缓存过期（距上次采集 ≥ stateRefreshMs）→ 异步补采一次（fire-and-forget），
    // 用户消息到达的事件监听（apply 注册）已先行触发，这里兜底。采集完成下轮注入带新状态。
    // 注意：不注入通用采集时间戳——它是每 3s 变化源，会让整段快照每轮变化、破坏宿主去重
    // （权限/沙箱快照被状态块拖累每轮重发，2026-08-20 实测根因）。
    const refreshMs = Math.max(1000, Number(this.cfg.stateRefreshMs) > 0 ? Number(this.cfg.stateRefreshMs) : 3000)
    if (Date.now() - (cache.at || 0) >= refreshMs) {
      this.requestStateCollect(sid)
    }
    // 截图按需刷新（v0.4.1）：截图让 Unity 窗口闪烁/任务栏提醒，不参与后台轮询；
    // 注入（发消息）时发现截图已过期（距上次截图 ≥ screenshotStaleMs）→ 异步补采一次（fire-and-forget），
    // 当前注入返回旧图，采集完成后下轮注入带新图（updatedAt 变化 → 宿主整段去重重新注入）。
    if (sw.stateGameScreenshot || sw.stateSceneScreenshot) {
      const newestShot = (cache.entries || []).reduce((m, e) => (e.ok && e.updatedAt ? Math.max(m, e.updatedAt) : m), 0)
      const stale = Number(this.cfg.screenshotStaleMs) > 0 ? Number(this.cfg.screenshotStaleMs) : 10000
      if (Date.now() - newestShot >= stale) {
        const last = this._screenshotReqAt?.get(sid) || 0
        if (Date.now() - last >= stale) {
          this._screenshotReqAt ??= new Map()
          this._screenshotReqAt.set(sid, Date.now())
          this.requestStateCollect(sid) // 完整采集（含截图）
        }
      }
    }
    return '<unity_pool_state>\nUnity 状态（' + cache.instanceId + '）：\n' + lines.join('\n') + '\n</unity_pool_state>'
  }

  /**
   * 消息驱动采集入口（v0.4.1，2026-08-20 用户纠正「只在发消息的时候采集，不需要轮询」）：
   * 不再有后台周期轮询——采集只在三类时机发生：
   *  ① 用户消息到达（apply 里监听 session/event 的 user/message，见下方注册）；
   *  ② 回合首步注入求值（stateContextText）发现缓存过期；
   *  ③ 开关切换 / bind / unity_pool_state 刷新。
   * 幂等 + 全局防重入（collectState 内部 _stateCollecting），重复触发只跑一次。
   */
  requestStateCollect(sid) {
    if (!this.stateCarryEnabled(sid)) return
    this.collectState(sid).catch(() => {})
  }

  /** 兼容旧名（不再启动周期轮询；保留函数避免外部引用失效）。 */
  startStateTimer() {
    // v0.4.1：轮询已移除（曾每 stateRefreshMs 采集一次，含 ui_snapshot force_refresh 全量重扫，
    // 大快照下让 Unity 反复读条——用户第 3 次遇到）。采集改由消息/注入/开关驱动。
  }

  /** 停止状态采集定时器（无轮询后为空操作）。 */
  stopStateTimer() {
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null }
  }

  /** 切换某会话的状态携带开关（运行时，HTTP /api/state-switch 用）。key 如 'stateEnabled' / 'stateGameScreenshot'。
   *  v0.4.2 按会话独立：写入 _stateSwitchesBySession[sessionId]（含"关"），不再改全局 cfg。 */
  setStateSwitch(sessionId, key, value) {
    const sid = String(sessionId || '')
    if (!sid) throw new Error('sessionId required（状态开关按会话独立）')
    if (!STATE_SWITCH_KEYS.includes(key)) throw new Error('未知状态开关: ' + key + '（可选: ' + STATE_SWITCH_KEYS.join(', ') + '）')
    const bool = value === true || value === 'true' || value === 1 || value === '1'
    let own = this._stateSwitchesBySession[sid]
    if (!own) { own = {}; this._stateSwitchesBySession[sid] = own }
    own[key] = bool
    // 诊断流水：记录每次开关写入（含时间戳与会话），排查“开关被莫名改回”时直接看 view.state.switchLog
    this.stateSwitchLog.push({ at: Date.now(), sessionId: sid, key, value: bool })
    if (this.stateSwitchLog.length > 40) this.stateSwitchLog.shift()
    // 采集由 HTTP 路由（stateCarryEnabled 判断）触发，不再启动周期轮询（v0.4.1）
    this._save() // 持久化开关状态（v0.4.1）：重启后恢复上次设置，而不是配置默认
    return bool
  }

  /** 全局实例查找：按 Name@hash / hash 前缀 / 服务内实例 id。 */
  findInstance(instance, serviceId) {
    const value = String(instance ?? '').trim()
    if (!value) return null
    const pool = serviceId ? [this.serviceById(serviceId)].filter(Boolean) : this.services
    if (value.includes('@')) {
      for (const s of pool) {
        const hit = s.instances.find(i => i.id === value)
        if (hit) return { service: s, instance: hit }
      }
      return null
    }
    const lower = value.toLowerCase()
    const matches = []
    for (const s of pool) {
      for (const i of s.instances) {
        if (i.hash && i.hash.toLowerCase().startsWith(lower)) matches.push({ service: s, instance: i })
      }
    }
    if (matches.length === 1) return matches[0]
    return null
  }

  /** 自动分配：优先「可用且未被其他会话锁定」的实例（存活服务优先）。 */
  autoAssign(sessionId) {
    const targeted = new Set(Object.values(this.bindings).map(b => b.instanceId).filter(Boolean))
    const list = []
    for (const s of this.services) {
      if (s.alive === false) continue
      for (const i of s.instances) {
        list.push({ service: s, instance: i, taken: targeted.has(i.id) })
      }
    }
    const free = list.find(x => !x.taken)
    const any = list[0]
    const chosen = free || any
    if (!chosen) return null
    return { serviceId: chosen.service.id, instanceId: chosen.instance.id }
  }

  /**
   * 锁定会话目标实例：sessionId → {serviceId, instanceId}。
   * 每次绑定都拉取目标服务上的 MCP 工具列表（tools/list）随结果返回
   * （同服务重复绑定也重拉，保证动态工具集合新鲜；拉取失败回退缓存并附 toolsError，不阻断绑定）。
   * @param opts {instance?, serviceId?, force?}
   */
  async bind(sessionId, opts = {}) {
    // v0.5.1：force 默认为 true —— 并行开发同一实例是正常用法，默认不被 enforceExclusive 拒绝；
    // 仅当显式传 force=false（且 enforceExclusive=true）时才拒绝并行绑定。
    const force = opts.force !== false
    const instance = opts.instance !== undefined ? String(opts.instance) : undefined
    const serviceId = opts.serviceId !== undefined ? String(opts.serviceId) : undefined

    let target
    if (instance) {
      target = this.findInstance(instance, serviceId)
      if (!target) {
        const avail = this.services.flatMap(s => s.instances.map(i => s.id + ':' + i.id))
        throw new Error('实例 [' + instance + '] 未发现（可用: ' + (avail.join(', ') || 'none') + '；可先 unity_pool_scan 重新扫描）')
      }
    } else if (serviceId) {
      const svc = this.serviceById(serviceId)
      if (!svc) throw new Error('服务 [' + serviceId + '] 不存在')
      if (svc.instances.length === 0) throw new Error('服务 [' + svc.name + '] 上暂无实例（可先 unity_pool_scan）')
      target = { service: svc, instance: svc.instances[0] }
    } else {
      const picked = this.autoAssign(sessionId)
      if (!picked) throw new Error('没有可用实例（服务池为空或全部离线/无实例；可 unity_pool_scan 扫描）')
      target = { service: this.serviceById(picked.serviceId), instance: { id: picked.instanceId, name: picked.instanceId, hash: '' } }
    }

    if (this.cfg.enforceExclusive && !force) {
      const others = this.sessionsTargeting(target.instance.id).filter(sid => sid !== sessionId)
      if (others.length > 0) {
        throw new Error('实例 [' + target.instance.id + '] 正被其他会话并行使用（enforceExclusive 默认开启；并行开发同一实例属正常用法）。如需同时绑定可传 force=true（Unity 侧会排队，非错误）')
      }
    }

    const boundAt = Date.now()
    this.bindings[sessionId] = { serviceId: target.service.id, instanceId: target.instance.id, boundAt }
    this._save()
    const result = {
      sessionId,
      serviceId: target.service.id,
      instanceId: target.instance.id,
      boundAt,
      service: { id: target.service.id, name: target.service.name, url: target.service.url },
      instance: target.instance,
    }
    // 每次绑定都附该服务的 MCP 工具列表（best-effort，失败不阻断绑定，附 toolsError）。
    // 教训（2026-08-20 会话「重命名健康度构成面板多文本组件」）：曾只在首次绑定/跨服务切换时附带，
    // 会话第二次绑定拿不到列表 → Agent 只能盲猜工具名（read_editor_state）→ Unknown tool 空转；
    // 现在每次绑定都拉最新 tools/list（同服务重复绑定也重拉，保证动态工具集合新鲜）。
    try {
      const client = this.sessionClient(sessionId, target.service)
      // v0.5.7：把绑定实例钉在这个 client 上 —— 之后每次 tools/call 都带 unity_instance（每调用路由），
      // 服务端会话状态丢失（服务重启/会话被清理）时也不会退化成"没选实例"。
      client.pinnedInstance = target.instance.id
      await client.ensureInit()
      // v0.5.4：先把本会话 MCP 会话激活到目标实例，custom-tools 资源才是「本工程」的自定义工具
      // （激活失败不阻断绑定：实例可能在域重载，proxyMcp 首次调用会再激活一次）
      if (client.activeInstance !== target.instance.id) {
        try { await client.setActive(target.instance.id) } catch (err) {
          // v0.5.7：不再无声吞掉——激活失败会如实附在绑定结果里（绑定本身仍成功，靠每调用路由兜底）
          result.activateError = String(err?.message ?? err)
        }
      }
      await client.listTools()
      await this.refreshCustomTools(client, target.instance.id)
      client.tools = this.orderTools(client.tools, client)
      const tools = client.tools
      result.tools = tools
      result.toolsCount = tools.length
      const customNames = this.customToolNamesOf(client)
      if (customNames.length > 0) {
        result.customToolsCount = customNames.length
        result.customTools = customNames
      }
      // v0.5.0：绑定后把该服务工具动态注册为原生工具（umcp_*），模型上下文直接可见可调
      try { this.syncNativeTools(target.service.id, tools, customNames) } catch (err) {
        this.ctx?.logger?.warn?.('[unity-pool] 绑定后同步原生工具失败: ' + String(err?.message ?? err))
      }
    } catch (err) {
      // 拉取失败：回退该会话同服务已缓存的列表（若有），仍不阻断绑定
      const sc = this.sessionClients.get(sessionId)
      const cached = sc && Array.isArray(sc.client.tools) ? sc.client.tools : []
      result.tools = cached
      result.toolsCount = cached.length
      result.toolsError = String(err?.message ?? err)
    }
    // 状态携带开启时，绑定后立即采集一次（首个注入即可用）
    if (this.stateCarryEnabled(sessionId)) {
      this.collectState(sessionId).catch(() => {})
    }
    return result
  }

  unbind(sessionId) {
    const had = this.bindings[sessionId]
    if (had) {
      const serviceId = had.serviceId
      delete this.bindings[sessionId]
      this._save()
      // v0.5.0 收敛：该服务不再被任何会话绑定时，注销其原生工具（umcp_*）
      // —— 避免「绑过的服务无限累积注册」推高模型工具清单与上下文成本；
      // 手动解绑与会话归档自动解绑（_onSessionDisposed 也走本方法）共用此路径。
      if (this.cfg.nativeToolsEnabled !== false && serviceId) {
        const stillBound = Object.values(this.bindings).some(b => b.serviceId === serviceId)
        if (!stillBound) this._disposeNativeServiceTools(serviceId)
      }
    }
    if (this.stateCaches.has(sessionId)) this.stateCaches.delete(sessionId)
    if (this._stateTurnTexts) this._stateTurnTexts.delete(sessionId)
    // v0.5.6：清掉冷启动冷却，重绑后可立即补齐
    this._stateWaitAt.delete(sessionId)
    // v0.5.2：解绑清掉该会话的错误监视游标（下次绑定重新建立基线，不回溯历史错误）
    for (const key of [...this.errorWatches.keys()]) {
      if (key.startsWith(String(sessionId) + '::')) this.errorWatches.delete(key)
    }
    const sc = this.sessionClients.get(sessionId)
    if (sc) {
      try { sc.client.close() } catch { /* ignore */ }
      this.sessionClients.delete(sessionId)
    }
    return { sessionId, unbound: Boolean(had) }
  }

  /** 会话专用 MCP client（惰性创建，维护独立 MCP-Session-Id）。 */
  sessionClient(sessionId, service) {
    let sc = this.sessionClients.get(sessionId)
    if (!sc || sc.serviceId !== service.id) {
      if (sc) { try { sc.client.close() } catch { /* ignore */ } }
      sc = { serviceId: service.id, client: new McpHttpClient(service.url, { timeoutMs: Math.max(5000, this.cfg.probeTimeoutMs * 3), logger: this.ctx?.logger }) }
      this.sessionClients.set(sessionId, sc)
    }
    return sc.client
  }

  // ---- 工具排序：本工程自定义工具优先（v0.5.4）----
  // 官方资源 mcpforunity://custom-tools 给出「当前激活实例」注册的工程自定义工具（gfind/ui_snapshot/tsvp_diag…），
  // 据此把自定义工具排到官方工具之前：清单一眼看到本工程专属能力，模型也更倾向先用它们。

  /** 刷新该会话客户端的自定义工具名缓存（读官方 custom-tools 资源；失败/老服务端返回 null，不抛）。
   *  服务端该资源把「本实例注册的全部工具」（含官方内置）都列出来，需剔除官方名才是工程自定义工具。 */
  async refreshCustomTools(client, instance) {
    if (this.cfg.customToolsFirst === false) return null
    try {
      const all = await client.listCustomTools()
      const custom = Array.isArray(all)
        ? all.filter(n => !KNOWN_OFFICIAL_TOOLS.has(n))
        : []
      client.customToolNames = custom
      client.customToolsInstance = instance || client.activeInstance || null
      try { this.ctx?.logger?.info?.('[unity-pool][v0.5.4] listCustomTools all=' + (Array.isArray(all) ? all.length : '-') + ' custom=' + JSON.stringify(custom) + ' instance=' + String(instance) + ' active=' + String(client.activeInstance)) } catch { /* ignore */ }
      return custom
    } catch (err) {
      try { this.ctx?.logger?.warn?.('[unity-pool][v0.5.4] listCustomTools FAIL: ' + String(err?.message ?? err)) } catch { /* ignore */ }
      return null
    }
  }

  /** 按「自定义工具优先」重排工具列表（组内保持服务端原序）；无自定义名单时原样返回。 */
  orderTools(list, client) {
    if (!Array.isArray(list)) return list
    if (this.cfg.customToolsFirst === false) return list
    const names = client && Array.isArray(client.customToolNames) ? client.customToolNames : null
    if (!names || names.length === 0) return list
    const custom = new Set(names)
    const first = []
    const rest = []
    for (const t of list) (t && custom.has(t.name) ? first : rest).push(t)
    return first.concat(rest)
  }

  /** 该客户端上「属于本工程的自定义工具」名单（与服务端工具列表求交，避免列出未暴露的注册项）。 */
  customToolNamesOf(client) {
    const names = client && Array.isArray(client.customToolNames) ? client.customToolNames : []
    if (names.length === 0) return []
    const exposed = new Set((Array.isArray(client.tools) ? client.tools : []).map(t => t && t.name).filter(Boolean))
    return names.filter(n => exposed.has(n))
  }

  /** 本会话已绑服务的工具名速查（缓存快照；未绑定或无缓存返回 null）。v0.5.4：自定义工具排前面并单列。 */
  toolsSummary(sessionId) {
    const sc = this.sessionClients.get(sessionId)
    if (!sc || !Array.isArray(sc.client.tools) || sc.client.tools.length === 0) return null
    const customNames = this.customToolNamesOf(sc.client)
    return {
      serviceId: sc.serviceId,
      count: sc.client.tools.length,
      names: sc.client.tools.map(t => t && t.name).filter(Boolean),
      ...(customNames.length > 0 ? { customCount: customNames.length, customNames } : {}),
    }
  }

  /** 会话视角完整状态视图。 */
  view(sessionId) {
    const binding = this.bindingOf(sessionId)
    return {
      sessionId,
      binding,
      // 本会话已绑服务的工具名速查（bind 的 tools 字段是完整列表；这里给名字速查，随时可拿）
      tools: this.toolsSummary(sessionId),
      // v0.5.0：已注册的原生工具摘要（按服务）
      nativeTools: this.nativeToolsSummary(),
      services: this.services.map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        alive: s.alive,
        aliveAt: s.aliveAt,
        lastError: s.lastError,
        instancesValid: s.instancesValid,   // 最近一次实例发现是否成功（false=发现失败，列表可能过期）
        offlineStreak: s.offlineStreak || 0,
        instances: s.instances.map(i => ({
          id: i.id,
          name: i.name,
          hash: i.hash,
          ...(i.unityVersion ? { unityVersion: i.unityVersion } : {}),
          active: Boolean(binding && binding.serviceId === s.id && binding.instanceId === i.id),
        })),
        active: Boolean(binding && binding.serviceId === s.id),
      })),
      rules: {
        autoAssign: this.cfg.autoAssign,
        enforceExclusive: this.cfg.enforceExclusive,
        perSessionActiveInstance: true,
        autoUnbindOnArchive: this.cfg.autoUnbindOnArchive !== false,
        callReconnectTimeoutMs: this.cfg.callReconnectTimeoutMs,
        nativeToolsEnabled: this.cfg.nativeToolsEnabled !== false,
        nativeToolSchema: this.cfg.nativeToolSchema === 'full' ? 'full' : 'compact',
        errorWatchEnabled: this.cfg.errorWatchEnabled !== false,
        errorWatchCount: this.cfg.errorWatchCount,
        errorWatchMaxChars: this.cfg.errorWatchMaxChars,
        customToolsFirst: this.cfg.customToolsFirst !== false,
        // v0.5.5：扫描预算（防 unity_pool_scan 卡死）——单端口/整体超时上限
        scanPortTimeoutMs: this.scanPortBudgetMs(),
        scanTimeoutMs: Number(this.cfg.scanTimeoutMs) > 0 ? Number(this.cfg.scanTimeoutMs) : 20000,
        // v0.5.8：启动 Unity 编辑器能力开关（工程清单见 view.launch）
        launchEnabled: this.cfg.launchEnabled !== false,
        closeWaitMs: this.cfg.closeWaitMs,
        closeStopsServer: this.cfg.closeStopsServer !== false,
        dialogSupported: process.platform === 'win32',
        dialogWatchEnabled: this.cfg.dialogWatchEnabled !== false,
        dialogPollIntervalMs: this.cfg.dialogPollIntervalMs,
        autoDismissDialogs: this.cfg.autoDismissDialogs,
        autoDismissOnMCPFailure: this.cfg.autoDismissOnMCPFailure === true,
      },
      // v0.5.2：本会话错误携带监视摘要（游标/编译跟踪/最近一次上报）
      errorWatch: (() => {
        const b = this.bindingOf(sessionId)
        const w = b && b.instanceId ? this.errorWatches.get(String(sessionId) + '::' + b.instanceId) : null
        if (!w) return null
        return { cursor: w.cursor, latest: w.latest, compiling: w.compiling === true, pendingCompile: w.compileFinished === true, lastReport: w.lastReport || null }
      })(),
      lastAutoUnbind: this.lastAutoUnbind || null,
      connectHint: this.cfg.connectHint || DEFAULT_CONNECT_HINT,
      // v0.5.8：启动 Unity 编辑器（工程清单 + 最近启动记录）；客户端「启动 Unity」入口从这里读
      launch: this.launchStatus(),
      // v0.5.8：后台扫描到的模态窗（有 Unity 运行时每 dialogPollIntervalMs 刷新一次）
      dialogs: this.dialogsCache
        ? {
            at: this.dialogsCache.at,
            supported: this.dialogsCache.supported !== false,
            pids: this.dialogsCache.pids || [],
            dialogs: (this.dialogsCache.dialogs || []).slice(0, 5),
            ...(this.dialogsCache.skipped ? { skipped: this.dialogsCache.skipped } : {}),
            ...(this.dialogsCache.hint ? { hint: this.dialogsCache.hint } : {}),
            ...(this.dialogsCache.dismissed ? { dismissed: this.dialogsCache.dismissed } : {}),
          }
        : null,
      state: (() => {
        const sw = this.getStateSwitches(sessionId) // v0.4.2：view 按会话返回开关
        return {
          enabled: sw.stateEnabled === true,
          switches: {
            stateEnabled: sw.stateEnabled === true,
            stateGameScreenshot: sw.stateGameScreenshot === true,
            stateSceneScreenshot: sw.stateSceneScreenshot === true,
            stateSelection: sw.stateSelection === true,
            stateUiSnapshot: sw.stateUiSnapshot === true,
            stateSerialized: sw.stateSerialized === true,
            stateConsoleAll: sw.stateConsoleAll === true,
            stateConsoleSelected: sw.stateConsoleSelected === true,
            stateConsoleError: sw.stateConsoleError === true,
          },
          refreshMs: this.cfg.stateRefreshMs,
          maxChars: this.cfg.stateMaxChars,
          snapshotMaxChars: this.cfg.stateSnapshotMaxChars,
          consoleMaxChars: this.cfg.stateConsoleMaxChars,
          consoleCount: this.cfg.stateConsoleCount,
          screenshotMaxRes: this.cfg.stateScreenshotMaxRes,
          screenshotStaleMs: this.cfg.screenshotStaleMs,
          // v0.5.6：冷启动补齐预算（装配阶段等待采集的上限 / 失败冷却）
          firstTurnWaitMs: this.cfg.stateFirstTurnWaitMs,
          collectCooldownMs: this.cfg.stateCollectCooldownMs,
          dir: this.cfg.stateDir,
          switchLog: (this.stateSwitchLog || []).slice(-20).map(e => ({ at: e.at, sessionId: e.sessionId, key: e.key, value: e.value })),
          cache: this.stateCaches.get(sessionId)
            ? {
                at: this.stateCaches.get(sessionId).at,
                instanceId: this.stateCaches.get(sessionId).instanceId,
                entries: (this.stateCaches.get(sessionId).entries || []).map(e => ({
                  key: e.key, label: e.label, ok: e.ok, ...(e.file ? { file: e.file } : {}), ...(e.text !== undefined ? { textLength: e.text.length } : {}), ...(e.error ? { error: e.error } : {}),
                })),
              }
            : null,
        }
      })(),
    }
  }

  // ---- 错误日志携带（v0.5.2）----
  // 管线：工具调用前后各探测一次（前探测复用忙等待循环）→ 探测顺带取 Console 错误计数 →
  // 相对上次上报游标有增量（或检测到编译跃迁）→ 本次调用结果带回前 N 条新增错误明细 → 游标推进（只报一次）。

  /** 取（或初始化）某会话+实例的错误监视状态；实例切换视为新监视（基线重置，不回溯别的实例的错误）。 */
  errorWatchOf(sessionId, instance) {
    const key = String(sessionId) + '::' + String(instance)
    let w = this.errorWatches.get(key)
    if (!w) {
      w = { key, cursor: null, latest: null, compiling: false, compileFinished: false, lastReport: null }
      this.errorWatches.set(key, w)
    }
    return w
  }

  /**
   * 用一次探测结果更新错误监视：编译跃迁（isCompiling 1→0 记一次编译完成）+ Console 错误计数游标。
   * 首次探测只建立基线（不回溯会话开始前的历史错误）；Console 被 Clear（计数回落）时游标回退。
   */
  observeProbe(watch, probe) {
    if (!watch || !probe || probe.ok !== true) return watch
    if (probe.compiling === true) watch.compiling = true
    else if (watch.compiling === true) { watch.compiling = false; watch.compileFinished = true }
    const e = probe.counts && Number.isFinite(probe.counts.error) ? probe.counts.error : -1
    if (e < 0) return watch // Unity 侧计数不可用（版本差异/反射失败）：降级为只跟踪编译跃迁
    if (watch.cursor === null) { watch.cursor = e; watch.latest = e; return watch } // 基线
    if (e < watch.cursor) { watch.cursor = e; watch.latest = e; return watch }      // Console 被清空
    watch.latest = e
    return watch
  }

  /**
   * 结算一次错误携带：有新增错误（或刚编译完）就拉明细并推进游标（同一批只在一次工具调用中返回）。
   * @returns {{data:object, text:string}|null} 无新增且无编译事件时返回 null（调用结果保持原样）。
   */
  async drainErrorWatch(watch, client) {
    if (!watch) return null
    const cursor = watch.cursor
    const latest = watch.latest
    const newCount = (cursor !== null && latest !== null && latest > cursor) ? latest - cursor : 0
    const compileFinished = watch.compileFinished === true
    if (newCount === 0 && !compileFinished) return null
    const maxShow = this.cfg.errorWatchCount
    const maxChars = this.cfg.errorWatchMaxChars
    const fetchMax = this.cfg.errorWatchFetchMax
    let entries = []
    let fetchError = null
    let dropped = 0          // 窗口没覆盖到的、更早的新增错误条数（漂移过大时才会 > 0）
    let reportCount = newCount
    let endCount = latest
    if (newCount > 0) {
      // 漂移余量：read_console 回的是「最新 N 条」，读明细期间 Console 又冒出新错误会把窗口整体后移，
      // 直接按 newCount 取就会漏掉本批最早那几条（真机实测过）。多取 margin 条 + 读完再探一次当下计数，
      // 按全局下标把窗口对齐回本批起点。
      const margin = Math.min(Math.max(maxShow, 5), fetchMax)
      const fetchCount = Math.min(newCount + margin, fetchMax)
      try {
        const res = await client.callTool('read_console', {
          action: 'get',
          types: ['error'],
          count: String(fetchCount),
          // detailed 才带 file/line/stackTrace（运行时错误靠它定位）；关闭堆栈时用 plain 省字符
          format: this.cfg.errorWatchStacktrace !== false ? 'detailed' : 'plain',
          include_stacktrace: this.cfg.errorWatchStacktrace !== false,
        })
        if (res.isError) throw new Error(res.text || 'read_console failed')
        const win = parseConsoleEntries(res.text)
        const p2 = await probeEditorState(client).catch(() => null)
        const nowCount = p2 && p2.ok && p2.counts && Number.isFinite(p2.counts.error) && p2.counts.error >= 0
          ? p2.counts.error : latest
        endCount = Math.max(nowCount, latest)      // 漂移期间冒出的错误一并纳入本批（不留到下次重复刷）
        const winStart = endCount - win.length     // 窗口首条的全局下标
        const offset = cursor - winStart
        if (offset > 0) entries = win.slice(offset)
        else { entries = win; dropped = Math.max(0, -offset) }
        reportCount = Math.max(endCount - cursor, newCount)
      } catch (err) {
        fetchError = String(err?.message ?? err).slice(0, 200)
      }
    }
    // 明细拿不到也推进游标：宁可漏报一次，也不要同一批错误每次调用重复刷屏
    if (endCount !== null) { watch.cursor = endCount; watch.latest = endCount }
    watch.compileFinished = false
    const shown = entries.slice(0, maxShow).map(t => UnityPool.truncate(String(t), maxChars, '错误'))
    const compileHit = shown.some(t => COMPILE_ERROR_RE.test(t))
    const data = {
      newErrorCount: reportCount,
      compileDetected: compileFinished,
      compileErrors: compileHit,
      shown: shown.length,
      maxCharsPerEntry: maxChars,
      entries: shown,
      ...(dropped > 0 ? { droppedEarlier: dropped } : {}),
      ...(fetchError ? { fetchError } : {}),
    }
    const lines = []
    if (reportCount > 0) {
      lines.push('【Unity 新增错误日志 ' + reportCount + ' 条'
        + (compileFinished ? '（本次调用前后发生了编译' + (compileHit ? '，含编译错误' : '') + '）' : '')
        + '｜调用前后自动检查，只在本次调用返回一次】')
      shown.forEach((t, i) => lines.push((i + 1) + '. ' + t))
      if (reportCount > shown.length) {
        lines.push('（仅显示前 ' + shown.length + ' 条，另有 ' + (reportCount - shown.length) + ' 条新增错误，需要时用 read_console 自查；单条超 ' + maxChars + ' 字符已截断）')
      }
      if (dropped > 0) lines.push('（本批还有更早的 ' + dropped + ' 条超出读取窗口 errorWatchFetchMax，未取到明细）')
      if (fetchError) lines.push('（错误明细读取失败：' + fetchError + '）')
    } else {
      lines.push('【Unity 编译完成】本次调用前后检测到编译，Console 无新增错误。')
    }
    watch.lastReport = { at: Date.now(), newErrorCount: reportCount, compileDetected: compileFinished, shown: shown.length }
    return { data, text: lines.join('\n') }
  }

  /**
   * unity_mcp 代理：确保本会话 MCP session 的目标实例激活后转发工具调用。
   * @returns {{success, activeInstance, tool, text, structuredContent?, isError?}}
   */
  async proxyMcp(sessionId, tool, params, instanceOverride) {
    const binding = this.bindingOf(sessionId)
    if (!binding || !binding.serviceId) {
      // v0.5.7：区分「没绑过」与「绑过的服务暂时不在池里」——陈旧绑定必须给可读原因，不能含糊
      const raw = this.bindings[sessionId]
      if (raw && typeof raw.serviceId === 'string') {
        throw new Error('本会话绑定的服务 [' + raw.serviceId + '] 当前不在服务池中（可能已下线或正在重扫）。'
          + '可 unity_pool_scan 重新扫描；确认实例在线后 unity_pool_bind(instance="Name@hash") 重新绑定。')
      }
      throw new Error('本会话未锁定目标实例：先调用 unity_pool_bind(instance=...) 或 unity_pool_status 查看可用实例')
    }
    const service = this.serviceById(binding.serviceId)
    if (!service) throw new Error('绑定服务不存在: ' + binding.serviceId)
    const instance = instanceOverride !== undefined && String(instanceOverride) !== '' ? String(instanceOverride) : binding.instanceId
    if (!instance) throw new Error('绑定未锁定实例：请 unity_pool_bind(instance="Name@hash")')
    const client = this.sessionClient(sessionId, service)
    // v0.5.7：把绑定实例钉到该 client —— 之后每次 tools/call 都携带 unity_instance（每调用路由），
    // 由官方 middleware 在**本次调用**上解析实例，不再只依赖会丢失的 session-scoped state。
    client.pinnedInstance = instance
    await client.ensureInit()
    // 调用时实例离线的重连/等待时长（默认 20s）：给足超时让官方服务端的会话重连等待完成，
    // 超过才判定实例离线并返回失败原因（见 callReconnectTimeoutMs）。
    const reconnectTimeout = Number(this.cfg.callReconnectTimeoutMs) > 0 ? Number(this.cfg.callReconnectTimeoutMs) : 20000
    let sessionActivateError = null
    if (client.activeInstance !== instance) {
      try {
        await client.setActive(instance, { timeoutMs: reconnectTimeout })
      } catch (err) {
        // v0.5.7：会话状态激活失败不再直接失败返回 —— 每调用路由（unity_instance）仍可能打通；
        // 若真失败，下面会把原因一并返回，不再"看起来成功"。
        sessionActivateError = String(err?.message ?? err)
      }
    }
    if (tool === 'set_active_instance') {
      // v0.5.7：不再短路伪造成功。旧实现在这里直接返回 'active instance set to X'，
      // 让「选择其实没生效」看起来像成功 —— 正是本次缺陷最误导人的一环。现在真转发、真结果。
      try {
        const res = await client.callTool(tool, params, { timeoutMs: reconnectTimeout })
        return { success: !res.isError, activeInstance: instance, tool, text: res.text, ...(res.isError ? { isError: true } : {}) }
      } catch (err) {
        return { success: false, activeInstance: instance, tool, isError: true, text: '调用失败（实例离线/重连超时）：' + String(err?.message ?? err) }
      }
    }
    if (tool === 'unity_instances' || tool === 'list_instances' || tool === 'instances') {
      const list = await client.listInstances()
      return { success: true, activeInstance: instance, tool, text: JSON.stringify(list, null, 2), instances: list }
    }
    // 轻量一致性：请求的工具不在已缓存的 tools/list 里时自动重拉一次
    // （官方工具集合是动态的：Unity 可随时注册/注销自定义工具、manage_tools 开关工具组），
    // 重拉失败不阻断转发（tools/call 结果由服务端裁决）。
    const cachedTools = client.tools
    if (!Array.isArray(cachedTools) || !cachedTools.some(t => t && t.name === tool)) {
      const now = Date.now()
      if (!client.toolsListedAt || now - client.toolsListedAt > 10000) {
        try {
          await client.listTools() // 内部更新 client.tools
          client.toolsListedAt = now
          // v0.5.4：实例变了或还没读过自定义工具名单时重读一次，再按「自定义优先」重排
          if (client.customToolsInstance !== instance || !Array.isArray(client.customToolNames)) {
            await this.refreshCustomTools(client, instance)
          }
          client.tools = this.orderTools(client.tools, client)
          // v0.5.0：工具集合变化（Unity 动态注册/注销、manage_tools 开关）后同步原生工具注册
          try { this.syncNativeTools(binding.serviceId, client.tools, this.customToolNamesOf(client)) } catch { /* 同步失败不阻断转发 */ }
        } catch { /* 忽略，继续转发 */ }
      }
    }
    // 忙时等待（B）：Unity 编译/刷新/进度条期间 MCP 调用会撞主线程导致超时。
    // 转发前用 execute_code 探测，忙则按间隔重试，总时长不超过 busyMaxWaitMs（默认 10s）。
    // 探测失败视为"可能忙"（域重载窗口 execute_code 可能不可用），保守等待后继续。
    const busyWait = this.cfg.busyWaitEnabled !== false
    // 错误日志携带（v0.5.2）：调用前后各检查一次（前检查复用忙等待循环的探测，不额外增加往返）
    const errorWatch = this.cfg.errorWatchEnabled !== false ? this.errorWatchOf(sessionId, instance) : null
    let lastProbe = null
    if (busyWait) {
      const maxWaitMs = Number(this.cfg.busyMaxWaitMs) > 0 ? Number(this.cfg.busyMaxWaitMs) : 10000
      const intervalMs = Number(this.cfg.busyWaitIntervalMs) > 0 ? Number(this.cfg.busyWaitIntervalMs) : 500
      const deadline = Date.now() + maxWaitMs
      while (Date.now() < deadline) {
        const probe = await probeEditorState(client)
        lastProbe = probe
        this.observeProbe(errorWatch, probe) // 每次探测都喂给监视：编译在等待窗口内起止也能捕获
        if (probe.ok && !probe.busy) break   // 空闲：立即转发
        const remain = deadline - Date.now()
        if (remain <= 0) break
        await sleep(Math.min(intervalMs, remain))
      }
    } else if (errorWatch) {
      // 关闭忙等待但开启错误携带：仍需一次「调用前」检查建立基线/捕获调用间隙冒出的错误
      lastProbe = await probeEditorState(client).catch(() => null)
      this.observeProbe(errorWatch, lastProbe)
    }
    try {
      let res = await client.callTool(tool, params, { timeoutMs: reconnectTimeout })
      // v0.5.7：官方「实例选择守卫」= 路由没生效（服务端会话状态丢失/多实例歧义）。
      // 显式在当前 MCP 会话里重建选择后重试一次；仍失败就**如实报错**，
      // 绝不静默改投其它实例（静默错路由比报错更坏）。
      let routed = looksLikeInstanceSelectionRequired(res.text)
      if (routed) {
        try {
          client.activeInstance = null
          await client.setActive(instance, { timeoutMs: reconnectTimeout })
        } catch (err) { sessionActivateError = String(err?.message ?? err) }
        res = await client.callTool(tool, params, { timeoutMs: reconnectTimeout })
        routed = looksLikeInstanceSelectionRequired(res.text)
      }
      const base = {
        success: !res.isError && !routed,
        activeInstance: instance,
        tool,
        text: res.text,
        ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
        ...(res.isError ? { isError: true } : {}),
      }
      if (routed) {
        // 路由未生效：如实报错（不静默改投实例），并说明「本次调用没有在任何 Unity 上执行」
        base.isError = true
        base.text = '【路由未生效】调用没有落到绑定实例 ' + instance + ' 上 —— 官方实例选择守卫判定本会话未选定实例。'
          + '本次调用**未被转发到任何实例**（不存在静默改投）。'
          + (sessionActivateError ? '\n会话激活失败：' + sessionActivateError : '')
          + '\n处理：重试一次；仍失败可 unity_pool_bind(instance="' + instance + '") 重新绑定，或 unity_pool_scan 确认实例是否在线。'
          + '\n原始返回：' + String(res.text ?? '').slice(0, 800)
      }
      if (res.isError || routed) {
        // 失败附状态（A）：把最近一次探测状态附到返回 editorState，供调用方判断是否 busy 所致
        const state = lastProbe ?? await probeEditorState(client).catch(() => null)
        if (state) base.editorState = state.raw
        // 未知工具（B）：附当前可用工具名列表 + 相似工具提示，避免 Agent 继续盲猜工具名空转
        // （教训：2026-08-20 会话「重命名健康度构成面板多文本组件」猜 read_editor_state 后原地打转）
        if (/unknown tool/i.test(res.text || '')) {
          const hint = toolsHintText(client.tools, tool)
          if (hint) base.text = (base.text || '') + '\n\n' + hint
        }
      }
      // 错误日志携带（v0.5.2）：调用「后」再检查一次 → 有新增错误/刚编译完就随本次结果返回（只返回一次）
      if (errorWatch) {
        const afterProbe = await probeEditorState(client).catch(() => null)
        this.observeProbe(errorWatch, afterProbe)
        if (afterProbe && afterProbe.ok) base.editorStateAfter = afterProbe.raw
        const report = await this.drainErrorWatch(errorWatch, client).catch(() => null)
        if (report) {
          base.errorWatch = report.data
          base.text = (base.text || '') + (base.text ? '\n\n' : '') + report.text
        }
      }
      return base
    } catch (err) {
      // 实例掉线/域重载超时/服务不可达：以失败原因返回（不再抛出），调用方可直接看到停机信息。
      // 不再补一次探测（避免实例离线时 execute_code 也挂起、拖慢失败返回），只带最近一次探测状态。
      // v0.5.8：模态窗会阻塞 Unity 主线程导致 MCP 掉线——失败时查一次并附在结果里。
      let dialogs = null
      try {
        const dc = this.cfg.dialogWatchEnabled !== false ? await this.refreshDialogs() : await this.findModalDialogs()
        if (dc && Array.isArray(dc.dialogs) && dc.dialogs.length > 0) dialogs = dc.dialogs
      } catch { /* 检测失败不影响失败返回 */ }
      let text = '调用失败（实例离线/重连超时）：' + String(err?.message ?? err) + '。若实例在域重载或掉线中，请等待其重连后重试；若已关闭，请先 unity_pool_unbind 再 unity_pool_bind。'
      if (dialogs) {
        text += '\n\n检测到 Unity 模态窗（会阻塞编辑器主线程，导致 MCP 暂时掉线）：'
          + dialogs.map(d => (d.title || '(无标题)') + (Array.isArray(d.options) && d.options.length ? '（' + d.options.map(o => o.text).join(' / ') + '）' : '')).join('；')
          + '。用 unity_pool_dialog 选择选项或 action=close 关闭，处理后重试本调用。'
        if (this.cfg.autoDismissOnMCPFailure === true) {
          const acted = await this.dismissMatchingDialogs().catch(() => null)
          if (acted && (acted.clicked.length > 0 || acted.closed.length > 0)) {
            text += '\n已按 autoDismissDialogs 自动处理模态窗：' + JSON.stringify(acted.clicked.concat(acted.closed)) + '；请重试。'
          }
        }
      }
      return {
        success: false,
        activeInstance: instance,
        tool,
        isError: true,
        ...(lastProbe ? { editorState: lastProbe.raw } : {}),
        ...(dialogs ? { dialogs } : {}),
        text,
      }
    }
  }
}

export function createPool(ctx, cfg) {
  const resolved = { ...cfg, dataFile: cfg.dataFile || path.join(homedir(), '.dsh', 'unity-pool-state.json') }
  return new UnityPool(ctx || { logger: { info() {}, warn() {} } }, resolved)
}

function requireSession(exec) {
  const agent = exec && exec.agent
  const sessionId = agent && (agent.id || (agent.session && agent.session.id))
  if (!sessionId) throw new Error('该工具需要会话上下文（Agent-backed session）')
  return String(sessionId)
}

export function apply(ctx, config) {
  const pool = new UnityPool(ctx, {
    services: (config && Array.isArray(config.services) && config.services.length > 0)
      ? config.services : [{ id: 'unity-8080', name: 'Unity 8080', url: 'http://127.0.0.1:8080/mcp' }],
    dataFile: config?.dataFile || path.join(homedir(), '.dsh', 'unity-pool-state.json'),
    probeIntervalMs: config?.probeIntervalMs,
    probeTimeoutMs: config?.probeTimeoutMs,
    scanPorts: config?.scanPorts,
    scanPortTimeoutMs: config?.scanPortTimeoutMs,
    scanTimeoutMs: config?.scanTimeoutMs,
    autoAssign: config?.autoAssign,
    enforceExclusive: config?.enforceExclusive,
    connectHint: config?.connectHint,
    busyWaitEnabled: config?.busyWaitEnabled,
    busyMaxWaitMs: config?.busyMaxWaitMs,
    busyWaitIntervalMs: config?.busyWaitIntervalMs,
    autoUnbindOnArchive: config?.autoUnbindOnArchive,
    callReconnectTimeoutMs: config?.callReconnectTimeoutMs,
    stateEnabled: config?.stateEnabled,
    stateGameScreenshot: config?.stateGameScreenshot,
    stateSceneScreenshot: config?.stateSceneScreenshot,
    stateSelection: config?.stateSelection,
    stateUiSnapshot: config?.stateUiSnapshot,
    stateSerialized: config?.stateSerialized,
    stateConsoleAll: config?.stateConsoleAll,
    stateConsoleSelected: config?.stateConsoleSelected,
    stateConsoleError: config?.stateConsoleError,
    stateRefreshMs: config?.stateRefreshMs,
    stateScreenshotMaxRes: config?.stateScreenshotMaxRes,
    stateDir: config?.stateDir,
    stateMaxChars: config?.stateMaxChars,
    stateSnapshotMaxChars: config?.stateSnapshotMaxChars,
    stateConsoleMaxChars: config?.stateConsoleMaxChars,
    stateConsoleCount: config?.stateConsoleCount,
    screenshotStaleMs: config?.screenshotStaleMs,
    stateFirstTurnWaitMs: config?.stateFirstTurnWaitMs,
    stateCollectCooldownMs: config?.stateCollectCooldownMs,
    nativeToolsEnabled: config?.nativeToolsEnabled,
    nativeToolSchema: config?.nativeToolSchema,
    errorWatchEnabled: config?.errorWatchEnabled,
    errorWatchCount: config?.errorWatchCount,
    errorWatchMaxChars: config?.errorWatchMaxChars,
    errorWatchFetchMax: config?.errorWatchFetchMax,
    errorWatchStacktrace: config?.errorWatchStacktrace,
    customToolsFirst: config?.customToolsFirst,
    // 启动 Unity 编辑器（v0.5.8）
    launchEnabled: config?.launchEnabled,
    projects: config?.projects,
    editorPaths: config?.editorPaths,
    editorRoots: config?.editorRoots,
    allowVersionMismatch: config?.allowVersionMismatch,
    allowAnyProject: config?.allowAnyProject,
    launchLogDir: config?.launchLogDir,
    launchWaitReadyMs: config?.launchWaitReadyMs,
    launchPollIntervalMs: config?.launchPollIntervalMs,
    launchArgs: config?.launchArgs,
    launchDialogCheckEnabled: config?.launchDialogCheckEnabled,
    launchDialogCheckAfterMs: config?.launchDialogCheckAfterMs,
    dialogWatchEnabled: config?.dialogWatchEnabled,
    dialogPollIntervalMs: config?.dialogPollIntervalMs,
    autoDismissDialogs: config?.autoDismissDialogs,
    autoDismissOnMCPFailure: config?.autoDismissOnMCPFailure,
    serverStartWaitMs: config?.serverStartWaitMs,
    closeWaitMs: config?.closeWaitMs,
    closeStopsServer: config?.closeStopsServer,
  })
  ctx.effect(() => {
    pool.start()
    return () => pool.stop()
  }, 'unity-pool: probe')

  // ---- 系统提示 ----
  try {
    ctx.systemPrompt.section({
      name: 'unity-pool',
      order: 120,
      text: [
        '<unity_pool_guide>',
        '本机装有 Unity 服务池插件（dsh-unity-pool v2）：多个 Unity 服务（每个服务 = 一个 mcp-for-unity server）组成服务池，',
        '每个服务上可能挂多个 Unity 编辑器实例（Name@hash）。',
        '工作流：',
        '1. 需要连接 Unity 时先调 unity_pool_status 查看服务池、每个服务的实例列表（id/name/hash/是否本会话激活）。',
        '2. 若目标工程实例不在列表，调 unity_pool_scan 重新扫描（服务重探 + 实例重读 + 扫描端口段），再调 unity_pool_status。',
        '3. 用 unity_pool_bind(instance="Name@hash" 或 hash 前缀) 把本会话目标实例锁定为指定实例（一个会话只锁定一个实例）；每次绑定都会返回该服务的 MCP 工具列表（tools 字段，含名称/描述/参数 schema，同服务重复绑定也重拉保持新鲜），可据此直接 unity_mcp 调用；随时调 unity_pool_status 也可查看本会话已绑服务的最新工具名速查（tools: {count, names}）。注意：工具列表是服务级并集（同一服务上多工程实例的自定义工具会合并列出），列表里的自定义工具可能来自其他工程实例，调用失败属正常，说明该实例未注册此工具，改用官方工具即可。',
        '4. 之后所有 MCP 操作统一走 unity_mcp(tool="<mcp工具名>", params={...}) 代理——',
        '   插件会自动把本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），再转发调用，助手无感；',
        '   请求的工具不在已知列表时插件会自动重拉 tools/list（Unity 可运行时注册/注销自定义工具、manage_tools 可开关工具组）；工具名不存在时错误信息会附带当前可用工具名列表（含相似工具名提示），从中选正确的名称重试，不要盲猜；',
        '   查 Unity 编辑器状态（Game/Scene 截图、选中项、ui-snapshot、序列化字段、Console 全文/条目/错误）用 unity_pool_state（状态携带开关默认全关，需先开启；开启后每轮指令自动注入快照），不要猜 MCP 工具名；',
        '   返回内容中的 [image: ...] 占位表示官方返回了图片块（如 manage_camera include_image=true 的截图），文本通道已丢弃图片本体，需要时改用文本摘要参数；',
        '   Unity 编译/刷新期间插件会自动等待（忙时探测最长 10 秒），调用失败返回会附带编辑器状态 editorState（isCompiling/isUpdating/progressCount），据此判断是否忙碌所致。',
        '4c. 【v0.5.2 错误日志携带】每次 unity_mcp/umcp_* 调用都会在「转发前」和「转发后」各检查一次 Unity 状态：这期间只要 Console 冒出新的错误（脚本编译错误或运行时报错），',
        '   本次调用结果就直接带回新增错误明细——结构化字段 errorWatch（newErrorCount/compileDetected/entries）+ 文本附在 text 末尾，默认前 5 条、单条最长 2000 字符；',
        '   同一批错误只在一次工具调用中返回一次（游标推进，不重复刷屏），所以看到就要处理，别指望下次调用还带；检测到编译完成但无新增错误时回一行「编译完成，Console 无新增错误」（可当编译通过的确认）。',
        '   会话内首次调用只建立基线（不回溯历史错误）；需要看更多/更早的错误仍用 read_console。',
        '4b. 【v0.5.0 原生工具】绑定成功后，该服务的 MCP 工具会**自动注册为原生工具 umcp_<工具名>**（如 umcp_find_gameobjects、umcp_manage_scene），',
        '   模型上下文直接可见完整工具清单、可直接原生调用（参数同 Unity MCP 原工具，等价 unity_mcp 转发）；',
        '   未绑定会话的 umcp_* 调用会报「未锁定目标实例」，先 unity_pool_bind 即可；',
        '   umcp_* 与 unity_mcp 等价并存（unity_mcp 仍是通用代理兜底，任意工具名可调）。',
        '5. 不再使用时调 unity_pool_unbind 释放（关闭本会话的 MCP 会话）。',
        '6. 【v0.5.8 启动编辑器】需要打开 Unity 时用 unity_pool_launch（project=配置清单里的工程名，或 projectPath=工程绝对路径）：自动解析已装版本、防重复打开、等待实例出现并自动绑定，返回 pid/日志/实例。工程清单见 unity_pool_status 的 launch.projects（cordis.patch.yml 的 projects）。启动编辑器抢物理资源：Agent 自行启动前必须先按资源排期纪律写当日台账（_mini: C:\\Users\\Public\\Project\\_schedule\\YYYY-MM-DD.md；_pc: E:\\dsh\\schedule\\YYYY-MM-DD.md），单次 ≤30min。',
        '7. 【v0.5.8 关闭编辑器】需要关掉 Unity 时用 unity_pool_close（project/projectPath/pid）：默认优雅退出（等 closeWaitMs=15s），超时返回 stillRunning，确认可丢弃未保存改动后传 force=true；工程未运行时会清理陈旧 Temp/UnityLockfile；关闭后若服务上没有任何 Unity 实例，默认把 MCP 服务（uvx/python 子进程树，含残留终端里的服务）一并停掉（stopServer:false 保留）。view.launch.projects[].running 以「Unity 进程/锁文件被独占持有」为准，不再把崩溃残留的锁文件当成运行中。',
        '8. 【v0.5.8 模态窗】Unity 原生模态窗（版本不匹配/保存场景/确认框）会阻塞编辑器主线程、导致 MCP 暂时掉线/实例离线。后台每 dialogPollIntervalMs=10s 扫描一次（结果见 unity_pool_status 的 view.dialogs，仅 Windows），启动等待/关闭超时/unity_mcp 掉线失败都会自动附带 dialogs；用 unity_pool_dialog action=click + option（序号或文案，如 Continue / Don\'t Save / OK）选择，或 action=close 直接 WM_CLOSE；配置 autoDismissDialogs 可自动处理匹配「标题/正文」的弹窗（如 {match:"Opening project",option:"Continue"}）。',
        '状态携带（可选，默认全关）：插件可在每次发出指令时把 Unity 当前状态注入到上下文（配置 stateEnabled 等开关，或面板/HTTP /api/state-switch 运行时开启）——Game/Scene 视图截图（PNG 落盘到 stateDir，上下文给文件路径，可用 read_image 查看）、Hierarchy/Project 当前选中项、选中物体 ui-snapshot 与序列化字段、Console 全文/选中条目/错误；各项均有独立开关与防超长截断（stateMaxChars 等）。需要状态时调 unity_pool_state 立即刷新查看。',
        '自动解绑：实例掉线/域重载对已绑定会话是无感的——绑定保持，不做 probe 主动解绑、也不注入通知；只有本 DSH 会话被归档（session/disposed）时才会自动解绑该会话锁定的实例（autoUnbindOnArchive 默认开启）。真正要操作时直接 unity_mcp/umcp_* 调用：若实例在域重载/掉线中，插件会自动等待/重连（调用超时 callReconnectTimeoutMs，默认 20s，官方服务端会等实例重连），超过才判定实例离线并返回失败原因；重连成功后调用继续，无需重新 bind。',
        '规则：多个会话可以并行开发同一实例——你和别的会话绑定同一实例时，并发调用由 Unity 侧排队（性能排队而非错误），注意一下别操作太快；',
        'force 默认 true：并行开发同一实例是正常用法，绑定默认即允许并行（不被拒绝）；仅当显式传 force=false 且配置 enforceExclusive=true 时才拒绝并行绑定。',
        '</unity_pool_guide>',
      ].join('\n'),
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 系统提示注册失败: ' + String(err?.message ?? err))
  }

  // ---- 状态携带：用户消息事件驱动采集（v0.4.1，2026-08-20 用户纠正「只在发消息的时候采集，不需要轮询」）----
  // 无后台周期轮询（曾每 stateRefreshMs 采集一次，ui_snapshot force_refresh 全量重扫让 Unity 反复读条）。
  // 用户发送真实消息 → session/event user/message（source.kind=user）→ 异步采集一次，赶在回合首步注入前更新缓存；
  // stateContextText 里另有「缓存过期」兜底触发。采集含全局防重入，多入口只跑一次。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'user/message') return
        const src = event.data && event.data.source
        if (!src || src.kind !== 'user') return // 排除系统/插件注入（快照、审批通知等）
        const sid = session && (session.id || (session.session && session.session.id))
        if (sid) pool.requestStateCollect(String(sid))
      } catch (err) {
        ctx.logger?.warn?.('[unity-pool] 消息驱动采集触发失败: ' + String(err?.message ?? err))
      }
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 消息驱动采集监听注册失败: ' + String(err?.message ?? err))
  }

  // ---- 状态携带注入（v0.4.0，官方机制 systemPrompt.context，text 同步函数每次 agent request 前求值）----
  // 采集由消息/注入/开关驱动（无后台轮询），这里同步读取注入。
  //
  // v0.4.1 注入策略（2026-08-20 用户纠正设计）：**按回合缓存状态块文本，每回合只注入一次**——
  // 曾两次走偏：
  //  ① stateInjectOnce 每回合一次 → 同回合「首步带状态块、后续步空」→ 整段快照 541/390 抖动 → 权限快照每回合重复注入；
  //  ② 去掉 stateInjectOnce、每步返回最新状态块 + 宿主整段去重 → 状态稳定时零注入，但 Unity 开发常态
  //    （用户反复选中物体检查成果，几分钟点几十次）下每步内容都变 → **每步注入无关上下文**，严重干扰任务。
  // 现在的语义：回合首步生成并缓存状态块文本，同回合所有 step 返回同一份（快照整段稳定 → 宿主去重零注入）；
  // 用户发新消息（回合号 +1）→ 重新生成（携带当时最新状态）→ 注入一次；状态未变的新回合也不注入。
  try {
    ctx.systemPrompt.context({
      name: 'unity-pool:state',
      order: 125,
      text: (context) => {
        const agent = context && context.agent
        const sessionId = agent && (agent.id || (agent.session && agent.session.id))
        if (!sessionId) return ''
        // v0.4.2：按会话读总开关（各会话自己的开关控制自己的注入）
        if (pool.getStateSwitches(sessionId).stateEnabled !== true) return ''
        try {
          return pool.stateTextForTurn(sessionId, pool.stateTurnOf(agent))
        } catch (err) {
          ctx.logger?.warn?.('[unity-pool] 状态注入求值失败: ' + String(err?.message ?? err))
          return ''
        }
      },
    })
  } catch (err) {
    ctx.logger?.warn?.("[unity-pool] 状态 context 注册失败: " + String(err?.message ?? err))
  }

  // ---- 状态携带：冷启动补齐（v0.5.6，2026-09-09 用户报「新会话绑定后开启状态、发消息没注入上下文」）----
  // 根因：systemPrompt.context.text 是同步函数、只能读已有缓存；采集是异步的（MCP 往返 1~3s）。
  // 新会话 / 插件热重载 / 刚打开开关时缓存为空 → 首回合文本求值拿到空串（并按回合缓存空串）→
  // 整回合（含后续 step）都没有状态块，用户看到的正是「开了状态却没注入」。
  // 修复：装配瀑布（system-prompt/assemble，唯一可 await 的装配钩子）里发现条目为空且本会话
  // 启用状态携带时，有界等待一次采集（stateFirstTurnWaitMs，冷却 stateCollectCooldownMs），
  // 再就地替换该 context 条目 → 首个回合就带上状态；缓存已有时完全零开销。
  try {
    ctx.on("system-prompt/assemble", async (assembly, context, next) => {
      const out = await next()
      try {
        const agent = context && context.agent
        const sessionId = agent && (agent.id || (agent.session && agent.session.id))
        if (!sessionId) return out
        if (context.signal && context.signal.aborted) return out
        const contexts = Array.isArray(out.contexts) ? out.contexts : []
        const idx = contexts.findIndex(c => c && c.name === "unity-pool:state")
        const cur = idx >= 0 ? String(contexts[idx].text ?? "") : ""
        if (cur.trim()) return out // 已有状态块：零开销
        const turn = pool.stateTurnOf(agent)
        const text = await pool.ensureStateTextForTurn(sessionId, turn)
        if (!text) return out
        if (context.signal && context.signal.aborted) return out
        const nextContexts = contexts.slice()
        if (idx >= 0) nextContexts[idx] = { ...nextContexts[idx], text }
        else nextContexts.push({ name: "unity-pool:state", text })
        return { ...out, contexts: nextContexts }
      } catch (err) {
        ctx.logger?.warn?.("[unity-pool] 状态冷启动补齐失败: " + String(err?.message ?? err))
        return out
      }
    })
  } catch (err) {
    ctx.logger?.warn?.("[unity-pool] 状态冷启动补齐注册失败: " + String(err?.message ?? err))
  }

  // ---- Agent 工具 ----
  try {
    ctx.tools.register(defineTool({
      name: 'unity_pool_status',
      description: '查看 Unity 服务池状态：每个服务（mcp-for-unity server）的存活状态与已连接的 Unity 实例列表（实例 id 为 Name@hash，含 name/hash/是否本会话激活 active）、本会话当前锁定的目标实例、分配规则（autoAssign/enforceExclusive/autoUnbindOnArchive）、最近一次归档自动解绑 lastAutoUnbind。需要连接 Unity 前先调用本工具；本会话已绑定时附带该服务最新工具名速查（tools: {count, names}）；launch 字段给出可启动工程清单（projects：路径/版本/是否带 MCP 包/是否运行中）与最近启动记录（v0.5.8）。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      execute(_args, exec) {
        const sessionId = requireSession(exec)
        return Promise.resolve(pool.view(sessionId))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_scan',
      description: '重新扫描 Unity 服务池：对配置的服务做存活探测并重新读取每个服务上的 Unity 实例列表（mcpforunity://instances），同时探测 scanPorts 端口段以发现新的 mcp-for-unity 服务并并入池。返回本次新发现的实例与当前完整状态。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(_args, exec) {
        const sessionId = requireSession(exec)
        const { found, timedOut, error, scanRan } = await runPoolScan(pool)
        return {
          sessionId,
          scannedServices: pool.services.length,
          newServices: found,
          ...(scanRan && pool.lastScanSkipped && pool.lastScanSkipped.length > 0 ? { skippedPorts: pool.lastScanSkipped } : {}),
          ...(timedOut ? { timedOut: true, error } : {}),
          view: pool.view(sessionId),
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_bind',
      description: '把本会话的目标实例锁定为一个 Unity 实例（一个会话只锁定一个实例）。传 instance（Name@hash 或 hash 前缀）锁定指定实例；传 serviceId 则锁定该服务上第一个实例；都不传则自动分配一个未被其他会话锁定的实例。返回锁定结果与状态视图；每次绑定都会返回该服务的最新 MCP 工具列表（tools 字段，含 name/description/inputSchema 与 toolsCount，同服务重复绑定也重拉保持新鲜），可据此直接 unity_mcp 调用；绑定后该服务工具还会自动注册为原生工具（umcp_<工具名>，v0.5.0），上下文直接可见可调；随时调 unity_pool_status 也可查看工具名速查。注意：工具列表为服务级并集（同服务多工程实例的自定义工具合并列出），其中部分自定义工具可能不属于当前实例，调用失败即说明该实例未注册此工具。',
      parameters: {
        instance: { type: 'string', description: '目标实例 id（Name@hash，来自 unity_pool_status）；缺省自动分配。' },
        serviceId: { type: 'string', description: '限定在指定服务内查找实例（可选）。' },
        force: { type: 'boolean', description: '实例已被其他会话绑定时是否允许并行绑定（默认 true：并行开发是正常用法，不拒绝）；显式传 false 且配置 enforceExclusive=true 时才拒绝并行。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const a = args || {}
        const result = await pool.bind(sessionId, { instance: a.instance, serviceId: a.serviceId, force: a.force })
        return { ...result, view: pool.view(sessionId) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_launch',
      description: '启动 Unity 编辑器并等待实例就绪、自动绑定本会话（v0.5.8）。传 project（cordis.patch.yml projects 清单里的工程名）或 projectPath（任意 Unity 工程绝对路径）。插件会：解析已安装的 Unity 版本（editorPaths/editorRoots；工程版本不一致默认用已装版本打开并标 mismatch）、检查 Temp/UnityLockfile 防重复打开、服务全离线且配了 services[].startCommand 时先拉起 mcp-for-unity 服务（并清理子进程 env 里 httpx 不认的 no_proxy 方括号项）、以 -projectPath/-logFile 拉起编辑器、轮询服务池直到该工程实例出现（默认最长 launchWaitReadyMs=120s），出现后自动绑定并返回工具列表。返回 pid、日志路径、实例与绑定结果；未就绪时 ready:false 并给后续检查指引。可选 editorPath/version/serviceId/waitMs/bind/waitReady/force。注意：启动编辑器抢物理资源，Agent 自行启动前必须先按资源排期纪律写当日台账（_mini: C:\\Users\\Public\\Project\\_schedule\\YYYY-MM-DD.md；_pc: E:\\dsh\\schedule\\YYYY-MM-DD.md）。',
      parameters: {
        project: { type: 'string', description: '配置清单里的工程名（cordis.patch.yml projects[].name）。' },
        projectPath: { type: 'string', description: 'Unity 工程绝对路径（配置清单外的工程；allowAnyProject=false 时仅允许清单内）。' },
        editorPath: { type: 'string', description: '指定 Unity.exe 绝对路径（默认按工程版本匹配已装编辑器）。' },
        version: { type: 'string', description: '覆盖工程 Unity 版本（默认读 ProjectSettings/ProjectVersion.txt）。' },
        serviceId: { type: 'string', description: '只在该服务上等实例（默认全池；工程清单可配 serviceId）。' },
        waitReady: { type: 'boolean', description: '是否等待实例就绪（默认 true）。' },
        waitMs: { type: 'number', description: '等待就绪上限（毫秒，默认取配置 launchWaitReadyMs）。' },
        bind: { type: 'boolean', description: '就绪后自动绑定本会话（默认 true）。' },
        force: { type: 'boolean', description: '工程已在运行时仍强制再启动一个编辑器（默认 false；一般不要用）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        return await pool.launch(sessionId, args || {})
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_close',
      description: '关闭 Unity 编辑器（v0.5.8 配套能力，与 unity_pool_launch 对应）：传 project（配置清单名）、projectPath 或 pid。默认优雅退出（Windows taskkill 不带 /F / SIGTERM），等待 closeWaitMs=15s；超时返回 stillRunning + 提示（可能有未保存改动/保存弹窗），确认可以丢弃改动后传 force=true 强杀。工程未运行时会顺手清理陈旧 Temp/UnityLockfile（旧实现只看锁文件存在，导致「没开编辑器却显示运行中」——现在锁文件被独占持有才算运行）。关闭后若服务上已没有任何 Unity 实例，默认会把 MCP 服务（uvx/python 子进程树，含 Unity 侧 Auto-Start 拉起的残留）一并停掉（stopServer:false 可保留）。返回 closed/pids/forced/waitedMs/staleLockfileRemoved/serverStopped。注意：关闭编辑器会丢未保存改动，Agent 自行关闭前先确认该编辑器属于本任务。',
      parameters: {
        project: { type: 'string', description: '配置清单里的工程名（cordis.patch.yml projects[].name）。' },
        projectPath: { type: 'string', description: 'Unity 工程绝对路径。' },
        pid: { type: 'number', description: '直接指定 Unity 进程 PID（可跳过工程解析）。' },
        force: { type: 'boolean', description: 'true = 强杀（taskkill /F / SIGKILL）；默认 false = 优雅退出。' },
        waitMs: { type: 'number', description: '等待退出的上限（毫秒，默认取配置 closeWaitMs）。' },
        stopServer: { type: 'boolean', description: '关闭后是否停掉「在线且没有其他 Unity 实例」的 MCP 服务（默认 true，会连同 uvx/python 子进程一起收，避免残留终端）；false = 保留服务。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const result = await pool.closeProject(sessionId, args || {})
        return { ...result, view: pool.view(sessionId) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_dialog',
      description: '查看/选择/关闭 Unity 编辑器的模态对话框（v0.5.8 增强，Windows）：版本不匹配、保存场景、确认框等都是 Win32 原生 #32770 窗口。action=list（默认）返回每个窗口的 title/message/options（序号+文案）；action=click 传 option（序号或按钮文案，如 Continue / Don\'t Save / OK），插件用 BM_CLICK 点击并返回 remaining；action=close 直接发 WM_CLOSE 关闭窗口（等价取消）。可用 project/projectPath 限定工程，或 pid 直接指定。**模态窗会阻塞 Unity 主线程导致 MCP 暂时掉线**：unity_mcp/umcp_* 掉线失败时会自动附带检测到的模态窗；后台默认每 10s 扫描一次（view.dialogs），可用 autoDismissDialogs 配置自动选择匹配项。',
      parameters: {
        action: { type: 'string', description: 'list（默认）或 click。' },
        project: { type: 'string', description: '配置清单里的工程名（限定该工程的编辑器）。' },
        projectPath: { type: 'string', description: 'Unity 工程绝对路径。' },
        pid: { type: 'number', description: '直接指定 Unity 进程 PID。' },
        hwnd: { type: 'number', description: '目标对话框句柄（存在多个模态窗时指定）。' },
        option: { type: 'string', description: '要点击的选项：序号（0-based）或按钮文案（如 Continue / Don\'t Save）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        requireSession(exec)
        const a = args || {}
        let projectPath = a.projectPath ? String(a.projectPath) : undefined
        if (!projectPath && a.project) projectPath = pool.resolveProject({ project: String(a.project) }).path
        if ((a.action || 'list') === 'click') {
          return await pool.clickModalDialogOption({ projectPath, pid: a.pid, hwnd: a.hwnd, option: a.option })
        }
        if (a.action === 'close') {
          return await pool.closeModalDialog({ projectPath, pid: a.pid, hwnd: a.hwnd })
        }
        return await pool.findModalDialogs(projectPath, { pids: a.pid ? [Number(a.pid)] : undefined })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_mcp',
      description: '代理调用本会话目标实例上的 MCP 工具（先通过本插件）：调用前自动确保本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），然后转发 tools/call 并返回结果。tool 为 mcp-for-unity 工具名（如 manage_scene、manage_gameobject、manage_camera、read_console 等）；请求的工具不在已知列表时插件会自动重拉 tools/list 再转发（官方工具集合可动态增减）；工具名不存在时错误信息会附带当前可用工具名列表（含相似工具名提示），从中选取正确名称重试即可。params 为该工具参数对象。Unity 编译/刷新期间插件会自动等待（忙时探测最长 10 秒），调用失败时返回附带编辑器状态 editorState 便于判断是否忙碌所致。调用前后各检查一次 Console：期间新增的错误（编译错误/运行时报错）会随本次结果返回（errorWatch 字段 + text 末尾，默认前 5 条、单条 2000 字符，同一批只返回一次）。查 Unity 编辑器状态（截图/选中项/Console 等）用 unity_pool_state。本工具前需先用 unity_pool_bind 锁定目标实例。',
      parameters: {
        tool: { type: 'string', required: true, description: 'mcp-for-unity 工具名（如 manage_scene）。' },
        params: { type: 'json', description: '工具参数对象。' },
        instance: { type: 'string', description: '可选：临时覆盖目标实例（Name@hash）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: typeof v.text === 'string' ? v.text : JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const a = args || {}
        if (!a.tool) throw new Error('tool 必填（mcp-for-unity 工具名）')
        return await pool.proxyMcp(sessionId, String(a.tool), a.params, a.instance)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_unbind',
      description: '解除本会话的目标实例锁定并关闭本会话的 MCP 会话（释放实例给其他会话）。返回是否解除成功与状态视图。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      execute(_args, exec) {
        const sessionId = requireSession(exec)
        const result = pool.unbind(sessionId)
        return Promise.resolve({ ...result, view: pool.view(sessionId) })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_state',
      description: '查看/刷新本会话的 Unity 状态携带快照（v0.4.0）：立即采集一次并按开关返回各项状态（Game/Scene 视图截图文件路径、当前选中项、选中物体 ui-snapshot 与序列化字段、Console 全文/选中条目/错误），同时返回 view.state（各开关当前值与缓存摘要）。状态携带总开关与各项开关默认全关（需在配置或面板开启），开启后插件还会在每次发出指令时自动注入最近一次快照到上下文。',
      parameters: {
        refresh: { type: 'boolean', description: '是否立即触发一次重新采集（默认 true）。传 false 只读当前缓存。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const refresh = args === undefined || args === null || args.refresh !== false
        if (refresh) await pool.collectState(sessionId).catch(() => null)
        return { sessionId, cache: pool.stateCaches.get(sessionId) || null, view: pool.view(sessionId) }
      },
    }))
  } catch (err) {
    ctx.logger?.error?.('[unity-pool] 工具注册失败: ' + String(err?.message ?? err))
    throw err
  }

  // ---- 回环 HTTP API ----
  try {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/unity-pool/api',
        handler: (req, res) => {
          const host = String(req.headers.host ?? '')
          const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
          if (!loopback) {
            respond(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
            return
          }
          const url = new URL(req.url || '/', 'http://' + host)
          const p = url.pathname
          if (req.method === 'GET' && (p === '/unity-pool/api/status' || p === '/unity-pool/api/status/')) {
            respond(res, 200, { ok: true, value: pool.view(url.searchParams.get('sessionId') || '') })
            return
          }
          if (req.method === 'GET' && (p === '/unity-pool/api/config' || p === '/unity-pool/api/config/')) {
            respond(res, 200, { ok: true, value: {
              services: pool.services.map(s => ({ id: s.id, name: s.name, url: s.url })),
              connectHint: pool.cfg.connectHint || DEFAULT_CONNECT_HINT,
              autoAssign: pool.cfg.autoAssign,
              enforceExclusive: pool.cfg.enforceExclusive,
              scanPorts: pool.cfg.scanPorts,
              scanPortTimeoutMs: pool.scanPortBudgetMs(),
              scanTimeoutMs: Number(pool.cfg.scanTimeoutMs) > 0 ? Number(pool.cfg.scanTimeoutMs) : 20000,
              busyWaitEnabled: pool.cfg.busyWaitEnabled !== false,
              busyMaxWaitMs: pool.cfg.busyMaxWaitMs,
              busyWaitIntervalMs: pool.cfg.busyWaitIntervalMs,
              autoUnbindOnArchive: pool.cfg.autoUnbindOnArchive !== false,
              callReconnectTimeoutMs: pool.cfg.callReconnectTimeoutMs,
              errorWatchEnabled: pool.cfg.errorWatchEnabled !== false,
              errorWatchCount: pool.cfg.errorWatchCount,
              errorWatchMaxChars: pool.cfg.errorWatchMaxChars,
              errorWatchFetchMax: pool.cfg.errorWatchFetchMax,
              errorWatchStacktrace: pool.cfg.errorWatchStacktrace !== false,
              customToolsFirst: pool.cfg.customToolsFirst !== false,
              // v0.5.8：启动 Unity 编辑器能力摘要（工程清单见 GET /api/launch 与 view.launch）
              launch: {
                enabled: pool.cfg.launchEnabled !== false,
                projectCount: pool.cfg.projects.length,
                waitReadyMs: pool.cfg.launchWaitReadyMs,
                pollIntervalMs: pool.cfg.launchPollIntervalMs,
                serverStartWaitMs: pool.cfg.serverStartWaitMs,
                closeWaitMs: pool.cfg.closeWaitMs,
                closeStopsServer: pool.cfg.closeStopsServer !== false,
                dialogSupported: process.platform === 'win32',
                dialogWatchEnabled: pool.cfg.dialogWatchEnabled !== false,
                dialogPollIntervalMs: pool.cfg.dialogPollIntervalMs,
                autoDismissDialogs: pool.cfg.autoDismissDialogs,
                autoDismissOnMCPFailure: pool.cfg.autoDismissOnMCPFailure === true,
                allowAnyProject: pool.cfg.allowAnyProject !== false,
                allowVersionMismatch: pool.cfg.allowVersionMismatch !== false,
                editorRoots: pool.cfg.editorRoots,
                logDir: pool.cfg.launchLogDir,
              },
              state: (() => {
                // v0.4.2：/api/config 无会话维度 → 返回全局默认层（配置默认 + 旧全局持久化 base）
                const sw = pool.getStateSwitches('')
                return {
                  enabled: sw.stateEnabled === true,
                  gameScreenshot: sw.stateGameScreenshot === true,
                  sceneScreenshot: sw.stateSceneScreenshot === true,
                  selection: sw.stateSelection === true,
                  uiSnapshot: sw.stateUiSnapshot === true,
                  serialized: sw.stateSerialized === true,
                  consoleAll: sw.stateConsoleAll === true,
                  consoleSelected: sw.stateConsoleSelected === true,
                  consoleError: sw.stateConsoleError === true,
                  refreshMs: pool.cfg.stateRefreshMs,
                  maxChars: pool.cfg.stateMaxChars,
                  snapshotMaxChars: pool.cfg.stateSnapshotMaxChars,
                  consoleMaxChars: pool.cfg.stateConsoleMaxChars,
                  consoleCount: pool.cfg.stateConsoleCount,
                  screenshotMaxRes: pool.cfg.stateScreenshotMaxRes,
                  screenshotStaleMs: pool.cfg.screenshotStaleMs,
                  firstTurnWaitMs: pool.cfg.stateFirstTurnWaitMs,
                  collectCooldownMs: pool.cfg.stateCollectCooldownMs,
                  dir: pool.cfg.stateDir,
                }
              })(),
            } })
            return
          }
          if (req.method === 'GET' && (p === '/unity-pool/api/state' || p === '/unity-pool/api/state/')) {
            const sessionId = url.searchParams.get('sessionId') || ''
            const cache = pool.stateCaches.get(sessionId) || null
            respond(res, 200, { ok: true, value: { sessionId, cache, view: pool.view(sessionId) } })
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/state-refresh' || p === '/unity-pool/api/state-refresh/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              await pool.collectState(sessionId).catch(() => null)
              respond(res, 200, { ok: true, value: { sessionId, cache: pool.stateCaches.get(sessionId) || null, view: pool.view(sessionId) } })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/state-switch' || p === '/unity-pool/api/state-switch/')) {
            readJson(req).then(body => {
              const sessionId = String((body && body.sessionId) || '')
              const key = String((body && body.key) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required（状态开关按会话独立，v0.4.2）' } }); return }
              if (!key) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'key required (stateEnabled / stateGameScreenshot / ...)' } }); return }
              try {
                const value = pool.setStateSwitch(sessionId, key, body.value)
                // 开启后立即采集一次（若为总开关或某项，本会话绑定中时）
                if (pool.stateCarryEnabled(sessionId)) pool.collectState(sessionId).catch(() => {})
                respond(res, 200, { ok: true, value: { sessionId, key, value, state: pool.view(sessionId).state } })
              } catch (err) {
                respond(res, 400, { ok: false, error: { code: 'bad-params', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/scan' || p === '/unity-pool/api/scan/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              const { found, timedOut, error, scanRan } = await runPoolScan(pool)
              respond(res, 200, { ok: true, value: {
                newServices: found,
                ...(scanRan && pool.lastScanSkipped && pool.lastScanSkipped.length > 0 ? { skippedPorts: pool.lastScanSkipped } : {}),
                ...(timedOut ? { timedOut: true, error } : {}),
                view: pool.view(sessionId),
              } })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/bind' || p === '/unity-pool/api/bind/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              try {
                const result = await pool.bind(sessionId, { instance: body.instance, serviceId: body.serviceId, force: body.force })
                respond(res, 200, { ok: true, value: { ...result, view: pool.view(sessionId) } })
              } catch (err) {
                respond(res, 409, { ok: false, error: { code: 'conflict', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/unbind' || p === '/unity-pool/api/unbind/')) {
            readJson(req).then(body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              const result = pool.unbind(sessionId)
              respond(res, 200, { ok: true, value: { ...result, view: pool.view(sessionId) } })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'GET' && (p === '/unity-pool/api/launch' || p === '/unity-pool/api/launch/')) {
            respond(res, 200, { ok: true, value: pool.launchStatus() })
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/launch' || p === '/unity-pool/api/launch/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              try {
                const result = await pool.launch(sessionId, body || {})
                respond(res, 200, { ok: true, value: result })
              } catch (err) {
                respond(res, 400, { ok: false, error: { code: 'launch-failed', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'GET' && (p === '/unity-pool/api/dialog' || p === '/unity-pool/api/dialog/')) {
            const projectPath = url.searchParams.get('projectPath') || undefined
            const pid = Number(url.searchParams.get('pid')) > 0 ? Number(url.searchParams.get('pid')) : undefined
            pool.findModalDialogs(projectPath, { pids: pid ? [pid] : undefined }).then(value => {
              respond(res, 200, { ok: true, value })
            }).catch(err => respond(res, 500, { ok: false, error: { code: 'dialog-failed', message: String(err?.message ?? err) } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/dialog' || p === '/unity-pool/api/dialog/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              try {
                const a = body || {}
                if ((a.action || 'list') === 'click') {
                  const value = await pool.clickModalDialogOption({ projectPath: a.projectPath, pid: a.pid, hwnd: a.hwnd, option: a.option })
                  respond(res, 200, { ok: true, value })
                } else if (a.action === 'close') {
                  const value = await pool.closeModalDialog({ projectPath: a.projectPath, pid: a.pid, hwnd: a.hwnd })
                  respond(res, 200, { ok: true, value })
                } else {
                  const value = await pool.findModalDialogs(a.projectPath, { pids: a.pid ? [Number(a.pid)] : undefined })
                  respond(res, 200, { ok: true, value })
                }
              } catch (err) {
                respond(res, 400, { ok: false, error: { code: 'dialog-failed', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/close' || p === '/unity-pool/api/close/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              try {
                const result = await pool.closeProject(sessionId, body || {})
                respond(res, 200, { ok: true, value: { ...result, view: pool.view(sessionId) } })
              } catch (err) {
                respond(res, 400, { ok: false, error: { code: 'close-failed', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          respond(res, 404, { ok: false, error: { code: 'not-found', message: 'no route: ' + p } })
        },
      }), 'unity-pool: http api')
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] HTTP API 注册失败: ' + String(err?.message ?? err))
  }
}

function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

/** Levenshtein 编辑距离（不区分大小写）。 */
function levenshtein(a, b) {
  a = String(a ?? '').toLowerCase()
  b = String(b ?? '').toLowerCase()
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 与请求名最相似的若干工具名（编辑距离 ≤ 阈值，最多 limit 个）。 */
function closestToolNames(requested, names, limit = 3) {
  const req = String(requested ?? '')
  const scored = []
  for (const name of names) {
    const d = levenshtein(req, name)
    if (d <= Math.max(2, Math.floor(Math.max(req.length, name.length) / 3))) {
      scored.push({ name, d })
    }
  }
  scored.sort((a, b) => a.d - b.d || a.name.length - b.name.length)
  return scored.slice(0, limit).map(x => x.name)
}

/** Unknown tool 错误的补救文案：可用工具名列表 + 相似工具提示 + 状态工具指引。 */
function toolsHintText(tools, requested) {
  const names = Array.isArray(tools) ? tools.map(t => t && t.name).filter(Boolean) : []
  if (names.length === 0) {
    return 'Unknown tool 处理提示：当前没有可用的工具列表（tools/list 未拉取成功）。请重新调用 unity_pool_bind 获取该服务的 MCP 工具列表（tools 字段），再从中选取正确的工具名重试。'
  }
  const req = String(requested ?? '')
  const lines = [
    'Unknown tool 处理提示：工具名 [' + req + '] 不存在于当前服务。可用工具（' + names.length + ' 个）：' + names.join(', '),
  ]
  const close = closestToolNames(req, names)
  if (close.length > 0) lines.push('相似工具：' + close.join('、') + '（检查拼写后重试）')
  lines.push('需要 Unity 编辑器状态（Game/Scene 截图、选中项、ui-snapshot、序列化字段、Console 全文/条目/错误）时用 unity_pool_state（状态携带开关默认全关，需先开启）；完整工具描述与参数 schema 见 unity_pool_bind 返回的 tools 字段。')
  return lines.join('\n')
}