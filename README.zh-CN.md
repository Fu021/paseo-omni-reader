<img src="assets/icon.png" alt="" width="96">

# Omni Reader

[English](README.md)

Omni Reader 是 Paseo 阅览增强插件。它为流式聊天加入 LaTeX 排版，也为工作区里的 Markdown、PDF、Word、Excel 和 PowerPoint 提供只读预览。

![Paseo 英文回复中的行内分数、公式表格、居中公式和文件链接](assets/cover-en.png)

## 阅览体验

- **聊天公式。** 流式回复中的公式闭合后即可渲染。行内分数按分子和分母所需的高度排版，独立公式居中。角标、分数、箭头标注和矩阵里也能显示中文。表格按内容调整列宽，放得下时居中，宽表格和长代码各自横向滚动。点击或点按公式即可预览并复制 LaTeX，也可用预览里的**复制 LaTeX 原文**再次复制。桌面端悬停即可查看源码。点击回复下方的**还原原始回复**可切回 Paseo 的 Markdown，同一位置会显示**恢复增强渲染**。两种视图都使用 Paseo 的回合页脚。行内和独立公式都跟随 Paseo 的内容字号，在插件设置中可分别选择 50% 至 200% 的字号档位。
- **工作区文件。** 从聊天链接或文件树打开 Markdown（`.md`、`.markdown`、`.mdown`、`.mkd`、`.mkdn`、`.mdwn`）、`.pdf`、`.docx`、`.xlsx` 和 `.pptx`。在 Paseo 的「打开位置」里，可分别设置聊天链接和文件树打开在主面板还是侧边。各预览器在操作区上方显示 **Omni Reader** 和文件大小，Markdown 还显示行数。Markdown 使用与聊天相同的公式设置，长文档按需加载。桌面端的 Markdown 排版宽度跟随 Paseo 的「外观 → 内容宽度」。
- **连续页面。** PDF 和带排版的 Office 预览按页上下排列。100% 时每页完整显示，宽度或高度贴合可用区域。拖动滑杆或输入 25% 至 400% 的百分比可调整缩放，鼠标悬停工具栏图标可查看提示。滚轮上下滚动，按住左键拖动平移。按住 `Ctrl` 或 `⌘` 滚动可围绕指针缩放。点击预览后按 `+`、`-`、`0` 放大、缩小或恢复适合页面，鼠标停在预览区时也可按住 `Ctrl` 或 `⌘` 使用这三个按键。点击预览后还可以用方向键平移，或按 `Page Up`、`Page Down` 上下滚动。原生 App 支持双指缩放和单指平移。
- **Excel 工作表。** 在网格中双向滚动，按底部标签切换工作表。网格显示行号和列标，保留合并单元格和基础样式。列宽随内容扩展，长文本换行并增加行高。桌面端可使用同样的缩放和滚动快捷键，按 `0` 恢复 100%。开启「拖动表格」后可用左键向任意方向拖动，也可直接用鼠标中键拖动。手机上可双指缩放、单指平移。
- **外部编辑。** 在 Paseo 桌面客户端中，本机守护进程上的文件可通过「在外部打开」交给系统默认应用打开原件。浏览器和桌面端的远程工作区下载副本。iOS 和 Android 通过系统分享交给其他 App。Android 系统分享不可用时，可从 Paseo 文件菜单下载副本。

Markdown 支持文档内链接和带行号的只读源码。桌面与平板的宽面板默认左侧显示排版预览，右侧显示源码。手机和窄面板可手动开启「分屏显示预览和源码」，上方为预览，下方为源码。已打开的分屏会随预览面板宽度自动调整排列。滚动任意一侧时另一侧会跟随。点预览块旁的源码按钮会短暂高亮对应原文，原文在视野外时会滚动到对应位置。源码可直接选择并复制文字。预览也会显示 YAML 文件头，并遵循表格的列对齐设置。

在 Markdown 面板中点「查找」或按 `Ctrl+F` / `Cmd+F`，即可搜索全文，包括尚未加载的部分。查找保持当前视图，在预览里标出命中区块，在源码里高亮具体文字。查找栏显示当前匹配与总数，提供区分大小写、全词和正则选项。按 `Enter` 或 `Shift+Enter` 切换匹配，按 `Escape` 关闭。

PDF 和 Office 排版预览使用与 Markdown 一致的查找控件，输入时直接在页面或幻灯片上高亮匹配内容。查找栏浮在内容区上方，页面保持原缩放。可用鼠标拖选或手指长按选取并复制文字。PDF 的选取和查找需要文件含有文字层。PowerPoint 默认在左侧显示缩略图，可点击跳页，也可用工具栏按钮收起以腾出阅读空间。Excel 查找栏输入 `X604` 等地址可同时定位该单元格并查找匹配文本，也可开启「仅查找单元格地址」直接跳转。可直接选取单元格内的文字，手机上也可点选单元格复制完整内容。右键或长按单元格，可以分别冻结或解除冻结该行、该列。

| Markdown 与公式预览 | PDF 与 Office 预览 |
| --- | --- |
| ![带 LaTeX 的 Markdown 预览与带行号的源码并排展示，右侧为公式预览及 LaTeX 原文](assets/markdown-en.png) | ![PDF 航拍图、Word 排版页面、带换行备注的 Excel 工作表和 PowerPoint 幻灯片缩略图](assets/documents-en.png) |

## 安装

Paseo 客户端和守护进程均需 0.17.5 或更新版本。从 0.17.5 起，增强回复可以保留原生的分支和回合统计等操作。在 Paseo 插件市场安装 **Omni Reader**，也可运行以下命令。

```sh
paseo plugin add fu021/omni-reader
```

从 GitHub 构建并安装时，守护进程主机需要 Node.js 22 或更高版本、npm 及下文列出的 Rust 工具。

```sh
paseo plugin install github:Fu021/paseo-omni-reader
```

聊天链接和文件树都使用 Paseo 已保存的文件关联。如果 Paseo 询问打开方式，选择 Omni Reader 并记住。Paseo 使用简体中文时显示中文插件控件，其余语言使用英文。

在手机上，文件直接在 Paseo 的文件面板内预览。点击 Paseo 的 × 关闭预览。

## 数据和限制

插件读取当前工作区内的文件，守护进程通过 Paseo 连接发送预览结果。npm 包内置 WebAssembly 引擎，公式、Word 和 PowerPoint 共用一份简体中文字体。安装完成后在本机渲染。首次打开 Word 或 PowerPoint 的排版预览时，会把整个文件转成 PDF，图片较多的演示文稿可能需要多等几秒。转换进程在开始绘制页面前退出，翻页、搜索和选取文字复用缓存的 PDF。部分嵌入图表可能与原件显示不同或留白。PDF 预览上限为 128 MiB，Office 预览上限为 24 MiB。排版不可用时，Word 和 PowerPoint 可查看基本文本。渲染失败的公式会保留源码并提供重试。

文件大小和行数跟随 Paseo 的界面字号。浏览器和桌面客户端的 Markdown 源码跟随 Paseo 的代码字体、代码字号和语法配色。原生 App 源码使用平台等宽字体并随系统文字缩放。

开发时可运行 `npm ci --include=dev --ignore-scripts`、`npm run typecheck`、`npm test` 和 `npm run test:office`。从源码构建需 Rust 1.92 或更高版本、`wasm32-unknown-unknown` 编译目标及 `wasm-bindgen-cli` 0.2.115。GitHub Actions 在 Linux 上使用 Node.js 22 和 24 验证发布包，测试使用隔离的用户目录、空的命令路径和离线 npm 安装。使用 npm 包时无需另装 Rust 或 Office。

Rust 负责工作簿的 XML、样式和尺寸，Markdown 的标题、引用和表格边界，公式排版和 PNG 输出，以及页面 JPEG 编码。客户端通过流式解析保持 Markdown 的交互。PDFium 负责绘制 PDF 页面，并提供选择、复制和搜索用的文字坐标。Word 和 PowerPoint 共用 [office2pdf 0.11.1](https://github.com/developer0hye/office2pdf/tree/v0.11.1)。公式用 [RaTeX](https://github.com/erweixin/RaTeX) 排版，字形来自 KaTeX 字体和 [Noto Sans SC](https://github.com/inkbar/fonts)。插件市场介绍备有[简体中文](OVERVIEW.zh-CN.md)与 [English](OVERVIEW.md) 版本。

`npm run pack:release` 生成包含渲染进程和锁定依赖的 npm 压缩包。`npm run check:package` 还会在临时目录安装该包，验证关闭生命周期脚本后仍可安装。
