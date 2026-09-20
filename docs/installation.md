# Installation

## 直接安装（推荐）

从 Releases 下载 `Sprout Setup 1.1.0.exe`，双击安装即可运行，无需 Node.js。

也可下载 `win-unpacked` 目录，直接运行其中的 `Sprout.exe`（便携版，免安装）。

## 从源码运行

### 依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ | 运行时 |
| Git | 任意 | 克隆仓库 |
| ImageMagick | 任意（可选） | 仅在需要生成 `app/icon.ico` 时使用 |
| Windows 构建工具（C++ 工作负载 + Python） | 可选 | 当 `active-win` / `node-window-manager` 没有可用的预编译产物、需要本地编译时使用 |

### 安装与启动

```bash
git clone https://github.com/stevenstg/Sprout-Focus-Windows.git
cd Sprout-Focus-Windows
npm install
npm start
```

开发检查：

```bash
npm run check
```

### 图标

`app/icon.ico` 不在版本库中（见 `.gitignore`），需要时生成：

```bash
npm run build:icon   # 依赖 ImageMagick 的 magick 命令
```

未生成时程序仍可运行，但系统托盘图标会缺失，打包时也会缺少应用图标。

### 打包

```bash
npm run package:dir        # dist/win-unpacked 便携目录
npm run package:win        # dist/Sprout Setup 1.1.0.exe（NSIS 安装包）
npm run package:portable   # 单文件便携版
```

## 文件位置

```
%LOCALAPPDATA%\Sprout\user-data\settings.json   # 设置文件
%LOCALAPPDATA%\Sprout\user-data\                # 用户数据、日志、helper 日志
%DOCUMENTS%\Sprout\history\YYYY-MM-DD.md         # 历史记录
```

开发态（`npm start`）根目录为 `%LOCALAPPDATA%\Sprout-dev`。

精准/模糊规则集保存在 Electron 的本地存储中（键 `sprout-precise-rulesets` / `sprout-fuzzy-rulesets`），不在项目目录里。

## 常见问题

**图标缺失 / 托盘没有图标**：运行 `npm run build:icon` 生成 `app/icon.ico`。

**原生模块加载失败或 ABI 不匹配**：安装「使用 C++ 的桌面开发」的 Visual Studio Build Tools 与 Python 后重试；也可执行 `npx electron-builder install-app-deps` 为 Electron ABI 重建原生模块。

**打包提示找不到 `app/icon.ico`**：先生成图标，见上。

**未签名的安装包触发 SmartScreen 警告**：属正常现象，当前未配置代码签名。
