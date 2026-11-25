# 草稿纸 · Windows 桌面预览版

面向 Windows 11 x64 的独立桌面窗口。无需安装 Node.js、Electron 或打开浏览器；程序保存在一个包含全部依赖的便携目录。先解压完整 ZIP，再双击 `草稿纸.exe`，不要将 EXE 单独移出目录。

- 草稿写入本机应用数据，不上传服务器。网页试玩版与 Windows 电脑版不共享本机草稿，可用 JSON 导出和导入。
- 右上角 `⋯ → 保存截图` 或 `Ctrl+Shift+S` 捕捉草稿纸应用内容，不采集桌面或其他窗口。
- 此预览版没有独立的 Windows 代码签名，不是安装器。请从可信来源下载。
- 当前仅构建 x64。没有验证 ARM64、Windows 10 或较早系统。

## 从源码打包

使用 Python 3.11+，联网下载 Electron v45.5.0 官方 Windows x64 运行时并校验发布方 SHA-256。也可用 `--cache 路径` 指向已下载的官方运行时 ZIP 和 `SHASUMS256.txt` 所在目录。

```sh
python desktop/build-windows.py --output ./草稿纸-win-x64.zip
```

ZIP 包括 Electron 及 Chromium 上游许可证。应用源码和网站共用 `dist/index.html`，桌面入口为 `desktop/main.cjs`。
