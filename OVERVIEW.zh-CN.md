# Paseo Omni Reader

Omni Reader 为工作区中的 Markdown、PDF、Word、Excel 和 PowerPoint 提供只读预览。文件可按 Paseo 的「打开位置」设置在主面板或侧边打开。插件也会在流式助手回复中渲染 LaTeX。点击**还原原始回复**可切回 Paseo 的 Markdown。

守护进程和客户端均需 Paseo 0.17.5 或更新版本，支持浏览器、桌面客户端、iOS 和 Android。如果 Paseo 询问 Markdown 的打开方式，选择 Omni Reader 并记住。通过 Git 安装时，守护进程主机需有 Node.js 22 或更新版本及 npm。插件在安装时根据锁定的依赖构建渲染进程。

行内分数按分子和分母所需的高度排版，独立公式居中。聊天中的两种公式均跟随 Paseo 的内容字号，插件设置可分别选择 50% 至 200% 的字号档位。浏览器中悬停可看 LaTeX 原文，点击可复制。原生 App 中长按任意公式即可显示或复制 LaTeX。渲染失败时会保留源码并提供重试。

Markdown 可显示与聊天相同的 LaTeX、切换源码，并随阅读加载大文件。PDF 和带排版的 Office 预览可连续上下滚动。100% 时整页按宽度或高度适配。使用工具栏缩放，也可点击预览后按 `+`、`-` 或 `0`。PDF 预览上限为 128 MiB。在 Paseo 主机安装 LibreOffice 后，最大 24 MiB 的 Office 文件可按 Word 页面、Excel 打印版式和 PowerPoint 幻灯片预览。Excel 还提供无需 LibreOffice 的可滚动只读工作表网格。

使用 Paseo 桌面客户端打开本机工作区时，「在外部打开」会使用系统默认应用打开原件。浏览器和桌面端的远程工作区下载副本。iOS 和 Android 通过系统分享交给其他 App。Android 系统分享不可用时，可从 Paseo 文件菜单下载。守护进程读取工作区文件并通过 Paseo 连接返回预览结果，插件无需外部渲染服务。
