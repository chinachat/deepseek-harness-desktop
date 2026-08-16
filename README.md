# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的桌面版图形界面。将 dsh 的 Web UI 封装为独立的 Windows 桌面应用，双击即用，无需安装 Node.js 或在命令行手动启动。

基于 **Electron + TypeScript** 构建，应用启动时自动拉起内置的 `dsh web` 服务并在本地窗口中加载界面。

## 功能特性

- **一键启动**：自动拉起 `dsh web` 服务，加载 DeepSeek Harness Web UI。
- **内置资源管理器**：右侧停靠栏式文件浏览器，支持：
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
- **端口自动分配**：`dsh web --port 0` 让系统分配空闲端口，并解析标准输出中的 URL。
- **目录选择器**：dsh 原生 Win32 文件夹选择器在打包环境下会崩溃（`koffi.view` 越界），已通过 `assets/picker-browse.patch.yml` 覆盖为纯 JS 的 browse 后端。
- **peerDependencies 补齐**：electron-builder 默认不打包 peer 依赖，已将 dsh 运行时需要的 `@deepseek-ai/*` peer 包显式加入 `dependencies`。
- **依赖安全**：资源管理器的文件读取经 IPC 校验（路径穿越防护、绝对路径后门移除、大文件/图片大小上限），且 `dshDesktop.fs` 桥仅暴露给本地资源管理器页面，不暴露给 dsh 主页面。

## License

[MIT](LICENSE)
