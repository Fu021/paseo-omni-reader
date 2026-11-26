# Paseo Omni Reader

Omni Reader 为 Paseo 的流式助手回复添加 LaTeX 排版，并为工作区中的 Markdown、文本、代码、PDF、Office 文件、CSV、HTML 和图片提供只读预览。从聊天链接或文件树都可以打开文档。

daemon 和客户端均需 Paseo 0.17.4 或更新版本，支持浏览器、iOS 和 Android。首次打开文件时，在「打开方式」中选择 Omni Reader 面板，并在每个客户端记住选择。通过 Git 安装时，daemon 主机需有 Node.js 22 或更新版本及 npm。插件在安装时根据锁定的依赖构建渲染进程。

行内分数按分子和分母所需的高度排版，独立公式居中。浏览器中悬停可看 LaTeX 原文，点击可复制。原生 App 中长按任意公式即可显示或复制 LaTeX。渲染失败时会保留源码并提供重试。Markdown 可切换到源码，长 UTF-8 文档按需分段读取。

PDF 预览上限为 128 MiB，按页渲染。浏览器用鼠标拖动，原生 App 在全屏阅读器中用双指缩放和单指平移。工具栏支持适合宽度、恢复 100% 和跳页。Office 预览保留 Word 段落和表格、Excel 工作表和单元格值，以及 PowerPoint 各页文字。结构化预览的文件上限为 24 MiB，并限制预览内容量。

「在外部打开」在浏览器下载副本，在 iOS 和 Android 通过系统分享交给其他 App。Android 系统分享不可用时，可从 Paseo 文件菜单下载。守护进程读取工作区文件并通过 Paseo 连接返回预览结果，插件无需外部渲染服务。
