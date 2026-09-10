# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的桌面版图形界面。将 dsh 的 Web UI 封装为独立的 Windows 桌面应用，双击即用，无需安装 Node.js 或在命令行手动启动。

基于 **Electron + TypeScript** 构建，应用启动时自动拉起内置的 `dsh web` 服务并在本地窗口中加载界面。

## 功能特性

- **一键启动**：自动拉起 `dsh web` 服务，加载 DeepSeek Harness Web UI。
- **纯壳**：不再向 dsh 页面注入任何界面。附件上传、目录选择等能力均由 dsh 0.1.5 原生提供，宿主只负责拉起服务、承载窗口与托盘。
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
    main.ts        # 窗口/视图编排、主题同步
    dsh-server.ts  # dsh 子进程管理（启动/守护/重启）
    ipc-guard.ts   # IPC 发送方校验
    tray.ts        # 系统托盘
    settings.ts    # 设置持久化
    settings-window.ts # 设置窗口 + 在线升级
    updater.ts     # electron-updater 封装
    log-window.ts  # 日志查看窗口
    logger.ts      # 日志（含轮转）
  preload/        # 预加载脚本
    preload.ts               # dsh 视图预加载（仅暴露运行时信息）
    settings-preload.ts      # 设置窗口
    log-preload.ts           # 日志窗口
assets/          # 资源（图标、日志/设置页面、patch 等）
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

1. **发送方校验**：`ipcMain.handle` 是进程级注册，任何能触达 `ipcRenderer` 的渲染进程都能调用。因此 `src/main/ipc-guard.ts` 要求每个 handler 校验 `event.senderFrame`：`settings:*` / `updater:*` / `logs:read` 只接受来自应用自身 `file://` 页面的顶层 frame。仅靠 preload 的 `contextBridge` 作用域**不构成**边界——它是按 `webPreferences` 而非 URL 安装的。
2. **导航与开窗**：dsh 视图只允许停留在本次启动的 loopback 来源，其余一律拦截并交给系统浏览器打开；`setWindowOpenHandler` 拒绝在应用内新建窗口。
3. **不再持有文件能力**：资源管理器移除后，宿主不再注册任何 `dsh-fs:*` / `dsh-explorer:*` 通道，也不再向 dsh 页面注入脚本，因此不存在「宿主代理文件访问」这一攻击面。三个本地页面都带 CSP；dsh 视图使用独立会话分区（`persist:dsh-web`）。

## 已知限制

- **更新链路无代码签名**：安装包未签名，`electron-updater` 的签名校验被显式跳过（见 `src/main/updater.ts`），完整性只靠 `latest.yml` 里的 SHA-512，而它与安装包同源。要消除风险需要给安装包签名；否则请把可配置的 GitHub 代理当作更新链路的信任组成部分。
- **`wasm`/原生模块构建**：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty` 带 install script。`npm ci` 默认可能不执行它们；从零 clone 后若要使用原生目录选择器或终端功能，需要 `npm approve-scripts`（本仓库默认走 browse 后端，因此不影响正常启动）。
- **发布产物的文件名必须与 `latest.yml` 一致**：`electron-updater` 由 `latest.yml` 的 `path` 推导下载地址（仅把空格换成连字符），而 GitHub 会把上传资产名里的空格规范成点号。因此 `package.json` 固定了 `artifactName`（无空格）；改动它时请同时确认三者一致，否则自动更新会 404。

## License

[MIT](LICENSE)
