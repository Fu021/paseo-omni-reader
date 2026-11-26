# Paseo Omni Reader

Omni Reader 是 Paseo 阅览增强插件。它在助手回复和工作区 Markdown 中排版 LaTeX 公式，让宽表格和长代码独立滚动，并提供支持缩放、平移和页码跳转的 PDF 阅读器。可从聊天或文件树打开文件，在 Markdown 预览和源码间切换。

daemon 和客户端均需 Paseo 0.17.4 或更新版本，支持浏览器、iOS 和 Android。首次打开文件时，可在 Paseo 的打开方式中选择 Omni Reader 并为当前设备记住选择。通过 Git 安装时，daemon 机器需有 Node.js 22 或更新版本和 npm。

长 UTF-8 文档按需分段读取。128 MiB 以内的 PDF 逐页渲染为图像。daemon 负责渲染 PDF 和公式，通过 Paseo 连接发送给当前客户端，无需外部渲染服务。
