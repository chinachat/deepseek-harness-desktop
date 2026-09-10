# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的桌面版图形界面。将 dsh 的 Web UI 封装为独立的 Windows 桌面应用，双击即用，无需安装 Node.js 或在命令行手动启动。

基于 **Electron + TypeScript** 构建，应用启动时自动拉起内置的 `dsh web` 服务并在本地窗口中加载界面。

## 功能特性

- **一键启动**：自动拉起 `dsh web` 服务，加载 DeepSeek Harness Web UI。
- **内置资源管理器**：右侧停靠栏式文件浏览器，支持：
  - **跟随当前任务**：自动定位到当前会话（任务）的工作区根目录，切换会话即跟随
  - 目录导航、盘符切换、文件过滤
  - 展开/折叠、宽度拖拽
  - 标签卡切换「导航树 / 文件预览」
  - Markdown 富文本渲染（含表格、代码块、链接等）
  - 图片直接预览
  - 代码语法高亮 + 行号（JS/TS、Python、JSON、HTML/CSS、Shell、YAML、C 系、SQL 等）
  - 明暗主题跟随主界面
- **系统托盘**：服务状态显示、显示/隐藏主窗口、查看日志、重启服务、退出。
- **设置持久化**：开机自启、关闭窗口最小化到托盘。
- **日志面板**：实时查看 `dsh` 服务日志。
- **服务守护**：`dsh` 进程异常退出自动重启。

## 技术栈

- Electron 43
- TypeScript 5
- electron-builder（NSIS 安装包）

## 运行与构建

```bash
# 安装依赖
npm install

# 开发运行
npm run dev

# 编译 TypeScript
npm run build

# 打包 Windows 安装包（NSIS）
npm run dist

# 仅产出未打包目录（调试用）
npm run pack
```

打包产物输出到 `release/`，安装包为 `release/DeepSeek Harness Setup <version>.exe`。

> 注意：打包为 NSIS 时若内存不足，可设置 `NODE_OPTIONS=--max-old-space-size=4096` 避免 OOM。

## 在线升级

应用内置在线升级（electron-updater + GitHub Releases）：

- **升级源**：`https://github.com/chinachat/deepseek-harness-desktop/releases`（`publish.github` 配置）。
- **检查方式**：托盘「设置…」→「检查更新」，或直接打开设置窗口。下载进度实时显示，下载完成后可一键重启安装。
- **代理配置**：网络受限时，在设置窗口填写 GitHub 代理（如 `http://127.0.0.1:7890`）即可，升级请求会经该代理走 GitHub。
- **发布新版本**：打标签发布时，用 `GH_TOKEN` 环境变量将产物上传到 GitHub Releases：

  ```bash
  GH_TOKEN=<your-token> npm run dist -- --publish always
  ```

  electron-builder 会把安装包和 `latest.yml` 一起发布，用户端即可检测到更新。

## 项目结构

```
src/
  main/          # 主进程
    main.ts        # 窗口/视图编排、菜单、主题同步
    dsh-server.ts  # dsh 子进程管理（启动/守护/重启）
    file-explorer.ts # 文件系统 IPC（目录/读取/盘符）
    tray.ts        # 系统托盘
    settings.ts    # 设置持久化
    log-window.ts  # 日志查看窗口
    logger.ts      # 日志
  preload/        # 预加载脚本
    preload.ts               # 主界面（dsh）预加载
    file-explorer-preload.ts # 资源管理器预加载
assets/          # 资源（资源管理器页面、图标、patch 等）
build/           # 打包资源（应用图标、NSIS 自定义脚本）
```

## 关键实现说明

- **dsh 运行时内置**：应用使用 Electron 自带的 Node 运行时（`ELECTRON_RUN_AS_NODE`）以子进程方式运行 `@deepseek-ai/dsh`，无需单独安装 Node。
- **`--expose-internals`**：dsh 的 HMR 插件需要该标志，启动 dsh 时已传入。
- **`--no-open`**：桌面版自己就是界面，因此启动 dsh 时显式关闭它「用默认浏览器打开」的行为，避免每次启动（含崩溃重启）多弹一个标签页。
- **端口自动分配**：`dsh web --port 0` 让系统分配空闲端口，并解析标准输出中的 URL。
- **目录选择器**：dsh 原生 Win32 文件夹选择器在打包环境下会崩溃（`koffi.view` 越界），已通过 `assets/picker-browse.patch.yml` 覆盖为纯 JS 的 browse 后端。
- **peerDependencies 补齐**：electron-builder 默认不打包 peer 依赖，已将 dsh 运行时需要的 `@deepseek-ai/*` peer 包显式加入 `dependencies`（含 `picker-browse.patch.yml` 引用的两个 browse 插件包）。
- **进程树清理**：重启/退出时用 `taskkill /T` 结束 dsh 及其全部子进程，避免留下孤儿服务。
- **日志轮转**：`dsh-desktop.log` 超过 5MB 时保留最近 2000 行，不会无限增长。

## 安全模型

桌面壳把宿主能力收敛在三个边界上，改动 IPC 时请一并维护：

1. **发送方校验**：`ipcMain.handle` 是进程级注册，任何能触达 `ipcRenderer` 的渲染进程都能调用。因此 `src/main/ipc-guard.ts` 要求每个 handler 校验 `event.senderFrame`：`dsh-fs:*` / `dsh-explorer:*` / `settings:*` / `updater:*` / `logs:read` 只接受来自应用自身 `file://` 页面的顶层 frame，`dsh-desktop:pick-images` 只接受当前 dsh 服务来源。仅靠 preload 的 `contextBridge` 作用域**不构成**边界——它是按 `webPreferences` 而非 URL 安装的。
2. **导航与开窗**：dsh 视图只允许停留在本次启动的 loopback 来源，资源管理器视图只允许在包内 `file://` 页面间跳转，其余一律拦截并交给系统浏览器打开；`setWindowOpenHandler` 拒绝在应用内新建窗口。
3. **文件访问**：`dsh-fs:*` 只读取被显式claim 过的根目录（浏览/切换盘符/工作区根即claim），`read`/`open` 用 `realpath` 做包含性校验（符号链接无法逃逸），`dsh-fs:open` 只允许文档/图片/媒体类扩展名——`.exe`/`.bat`/`.ps1`/`.lnk` 等一律拒绝。三个本地页面都带 CSP。三个视图仍以 `sandbox: false` 运行（编译出的 preload 为 CommonJS，沙箱下未经实机验证，故未改动）。

### 资源管理器如何跟随当前任务

dsh 的 Web UI 不会把「当前显示的是哪个会话」暴露给宿主，所以桌面壳用 dsh 的**实时会话存储**来推断：

- 数据源：`${DSH_HOME:-~/.dsh}/storages/session_projcache/sessions/<sessionId>.json` 中 `record.identity.cwd`。
- 排序依据：**文件 mtime**（dsh 每次持久化会话变更都会重写该文件），取最新的一条。
- 为什么不用 `session_projcache.json` 里的 `sessionListMetadata.lastPromptAt`：那个聚合文件写入节奏更慢，且 `lastPromptAt` 只在用户**提交提示词**时才更新——切到旧会话继续干活时它已经过期，会把资源管理器钉在**上一个**工作区上（这正是修复前的表现）。
- 兜底：`workspace.json` 中 `updatedAt` 最新的工作区。
- 探针每 1 秒一次，只在结果变化时才推送给渲染层；命中的根目录会被加入 `allowedRoots`，因此第 3 条的文件访问约束不会挡住这条路径。

## 已知限制

- **更新链路无代码签名**：安装包未签名，`electron-updater` 的签名校验被显式跳过（见 `src/main/updater.ts`），完整性只靠 `latest.yml` 里的 SHA-512，而它与安装包同源。要消除风险需要给安装包签名；否则请把可配置的 GitHub 代理当作更新链路的信任组成部分。
- **`wasm`/原生模块构建**：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty` 带 install script。`npm ci` 默认可能不执行它们；从零 clone 后若要使用原生目录选择器或终端功能，需要 `npm approve-scripts`（本仓库默认走 browse 后端，因此不影响正常启动）。
- **上游注入依赖构建期哈希**：`src/main/web-bridge.ts` 的盘符下拉/贴图按钮依赖 dsh 前端的 CSS Module 类名（如 `.ZuhsRW_*`）。dsh 升级重建后这些哈希会变，届时对应功能会静默失效（仅记录日志），不会影响启动。

## License

[MIT](LICENSE)
