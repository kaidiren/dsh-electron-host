# dsh-electron-host

DSH Web GUI 的 Electron 宿主。渲染内核从 WKWebView 换成 Chromium（Electron 45.3.3 / Chromium 156），
服务进程仍用**本机 nvm 的 node** 跑 `dsh web`，不使用 Electron 自带的 Node 运行时。

## 结构

    build.sh              把 Electron 官方二进制包成本 app（不需要 npm install）
    package.json          app 清单（main = src/main.js）
    src/main.js           主进程：窗口/遮罩/菜单/托盘/下载/缩放/关于面板/自检
    src/service.js        服务层：状态机、拉起、等端口、token 解析、重启、停止、残留进程接管
    src/overlay.html      启动遮罩（转圈 + 阶段 + 已用秒数）
    assets/               托盘模板图标
    Dist/DSH.app          产物（约 245M）

## 构建与运行

    ./build.sh
    "/Applications/DSH.app/Contents/MacOS/DSH"

自检档（验证用，不影响日常）：

    DSH_EL_SELFTEST=restart  启动完成后触发一次「重启服务」，再退出
    DSH_EL_SELFTEST=close    关窗后确认「应用与服务仍存活」，再退出
    DSH_EL_SELFTEST=orphan   打印残留进程判定结果，再退出
    DSH_EL_DEBUG=1           开 CDP 口 9333（便于对照渲染 / 截图）

## 更换图标

`assets/AppIcon.icns` 由 `tools/mask-icon.swift` 生成（源图需自备，不入库）：

    swiftc -O tools/mask-icon.swift -o /tmp/mask-icon
    /tmp/mask-icon 源图.jpg /tmp/icon.png 44 0.28 1.05
    # 再用 sips 生成 16/32/128/256/512 及 @2x 十档，iconutil -c icns 打包

参数依次是：裁边像素、圆角系数（0.2237≈Apple 标准，0.28 更圆能切掉底角白边）、画面缩放。
源图若是「白底 + 圆角 + 阴影」的成品图，必须先裁掉白边再遮罩，否则四角会露出白方块。

## 配置（与 Swift 壳同名同义）

    DSH_WEB_PORT            服务端口，默认 3080
    DSH_BIN                 dsh 可执行文件（默认按 nvm default 别名解析）
    DSH_WORKDIR             dsh web 的工作目录，默认 ~
    DSH_LOG_DIR             日志目录，默认 ~/Library/Logs/DSH
    DSH_WINDOW_MODE         maximized（默认，占满屏幕可用区域）| custom
    DSH_WINDOW_WIDTH/HEIGHT 仅 custom 模式
    DSH_REMEMBER_WINDOW_SIZE 记住窗口尺寸，默认 1
    DSH_STARTUP_OVERLAY     显示启动遮罩，默认 1
    DSH_TRAY                显示托盘图标，默认 1
    DSH_OPEN_WINDOW         启动时自动开窗，默认 1
    DSH_PAGE_ZOOM           首次运行的页面缩放，默认 1.0
    DSH_SERVICE_TIMEOUT     等端口就绪超时（秒），默认 60
    DSH_TOKEN_TIMEOUT       等认证地址超时（秒），默认 20
    DSH_STOP_TIMEOUT        停服务后等端口释放超时（秒），默认 10

也读取 `~/.dsh/mac-launcher.yaml`（仅 key: value 形式），环境变量优先。

## 服务与认证

- 端口已有服务 → 直接复用（不重启）
- 端口空闲 → 拉起 `dsh web --port <PORT> --no-open`
- 子进程 stdout/stderr：明文进 `service-raw.log`（0600），脱敏后进 `service.log`
- 认证地址：从 stdout 增量扫描 → 缓存到 `auth-url`（0600）；失效时回退到日志里最后一条
- 宿主退出后服务继续运行（设计如此）；`service-state.json` 记着 pid，下次启动可识别「自己留下的残留进程」

## 与 WKWebView 壳的差异

- 渲染内核：WKWebView → Chromium 156（`AbortSignal.any` / `Promise.withResolvers` / `Promise.try` 与 CSS Anchor Positioning 都原生支持，故不再需要 Polyfill / MenuFallback 两段注入）
- 体积：2.7M → 245M
- 冷启动：多约 0.3-0.5 秒（Electron 主进程 + Node 初始化）
- 遮罩改为本地 HTML 页（`overlay.html`），不再叠在渲染视图之上
- 多了原生 DevTools（⌥⌘I），便于排查渲染差异
