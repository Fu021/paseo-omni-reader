<img src="assets/icon.png" alt="" width="96">

# Paseo Omni Reader

[English](README.md)

Omni Reader 是 Paseo 阅览增强插件。它为流式聊天加入 LaTeX 排版，也为工作区里的 Markdown、PDF、Word、Excel 和 PowerPoint 提供只读预览。

![Paseo 中文回复中的行内分数、公式表格、居中公式和文件链接](assets/chat-zh-CN.png)

## 阅览体验

- **聊天公式。** 流式回复中的公式闭合后即可渲染。行内分数按分子和分母所需的高度排版，独立公式居中。表格按内容调整列宽，放得下时居中，宽表格和长代码各自横向滚动。浏览器悬停看 LaTeX 原文，点击复制。原生 App 长按任意公式即可查看或复制。点击回复下方的**还原原始回复**可切回 Paseo 的 Markdown，同一位置会显示**恢复增强渲染**。两种视图都使用 Paseo 的回合页脚。行内和独立公式都跟随 Paseo 的内容字号，在插件设置中可分别选择 50% 至 200% 的字号档位。
- **工作区文件。** 从聊天链接或文件树打开 Markdown、`.pdf`、`.docx`、`.xlsx` 和 `.pptx`。在 Paseo 的「打开位置」里，可分别设置聊天链接和文件树打开在主面板还是侧边。手机使用 Paseo 的文件预览窗口。Markdown 使用与聊天相同的公式设置，可切换预览和源码，长文档按需加载。
- **连续页面。** PDF 和带排版的 Office 预览按页上下排列。100% 时每页完整显示，宽度或高度贴合可用区域。拖动滑杆或输入 25% 至 400% 的百分比可调整缩放，鼠标悬停工具栏图标可查看提示。滚轮上下滚动，按住左键拖动平移。点击预览后按 `+`、`-`、`0` 放大、缩小或恢复适合页面。原生 App 支持双指缩放和单指平移。
- **Excel 工作表。** 在网格中双向滚动，按底部标签切换工作表。网格显示行号和列标，保留合并单元格和基础样式。列宽随内容扩展，长文本换行并增加行高。手机上可双指缩放、单指平移。在 Paseo 主机安装 LibreOffice 后，可切换到「打印版式」查看图表和打印效果。
- **外部编辑。** 在 Paseo 桌面客户端中，本机守护进程上的文件可通过「在外部打开」交给系统默认应用打开原件。浏览器和桌面端的远程工作区下载副本。iOS 和 Android 通过系统分享交给其他 App。Android 系统分享不可用时，可从 Paseo 文件菜单下载副本。

| PDF 阅读器 | PowerPoint 预览 |
| --- | --- |
| ![连续滚动中的横版 PDF 航拍图与下一张竖版页面](assets/pdf-en.png) | ![PowerPoint 幻灯片中的折线图、页码和缩放控件](assets/powerpoint-en.png) |

查看[自动换行的 Excel 备注](assets/excel-zh-CN.png)、[带公式和代码的 Markdown 预览](assets/markdown-zh-CN.png)和[双语公式字号设置](assets/settings-zh-CN.png)。

## 从 GitHub 安装

Paseo 客户端和 daemon 均需 0.17.5 或更新版本。从 0.17.5 起，增强回复可以保留原生的分支和回合统计等操作。通过 Git 安装时，daemon 主机需有 Node.js 22 或更新版本及 npm。

```sh
paseo plugin install github:Fu021/paseo-omni-reader
```

只有 Omni Reader 可用时，Paseo 会直接打开文件。如果 Paseo 询问 Markdown 的打开方式，选择 Omni Reader 并记住。Paseo 使用简体中文时显示中文插件控件，其余语言使用英文。

手机上以全屏显示文件内容，让滑动手势留在预览内。Paseo 0.17.6 中，点全屏右上角的 × 返回文件标题栏，再点 Paseo 的 × 关闭文件。也可点文件名旁的全屏图标重新打开预览。

## 数据和限制

插件读取当前工作区内的文件，守护进程通过 Paseo 连接发送预览结果。在运行 Paseo 守护进程的主机安装 LibreOffice Writer、Calc 和 Impress 后，Office 打印预览会保留排版、图片、图表和分页。浏览器和原生 App 使用同一套只读预览。Excel 工作表网格无需 LibreOffice，未安装 LibreOffice 时，Word 和 PowerPoint 可查看基本文本。PDF 预览上限为 128 MiB，Office 预览上限为 24 MiB。渲染失败的公式会保留源码并提供重试。

开发时可运行 `npm ci --include=dev --ignore-scripts`、`npm run typecheck`、`npm test` 和 `npm run check:package`。安装 LibreOffice Writer、Calc 和 Impress 后，可以运行 `npm run test:office` 验证 Office 排版预览。GitHub Actions 在 Linux 上使用 Node.js 22 和 24 执行检查，其中 Node.js 24 包含 LibreOffice 测试。插件市场介绍备有[简体中文](OVERVIEW.zh-CN.md)与 [English](OVERVIEW.md) 版本。

`npm run pack:release` 生成包含渲染进程和锁定依赖的 npm 压缩包。`npm run check:package` 还会在临时目录安装该包，验证关闭生命周期脚本后仍可安装。
