# Paseo Omni Reader

**Omni Reader** 是 Paseo 阅览增强插件。它把聊天里的 Markdown 和 LaTeX、工作区里的 Markdown 与长文本、PDF 预览放进同一个插件，支持电脑浏览器和 Paseo 原生手机 App。

## 安装

Paseo daemon 和客户端均需 **0.17.4 或更新版本**。通过 Git 安装时，daemon 所在机器需有 Node.js 22+ 和 npm。

```sh
paseo plugin install github:Fu021/paseo-omni-reader --ref v0.1.0
```

在 **Settings → Plugins** 中也可以安装 `github:Fu021/paseo-omni-reader`。只需在工作区所在的 daemon 安装一次，连接该 daemon 的各个客户端都会加载插件。首次打开 `.md`、`.txt` 等文件时，在 Paseo 的 **打开方式** 中选择相应的 **Omni Reader** 面板并记住选择。浏览器和手机各自保存这一选择。若已安装其他 PDF 面板，也可以在同一菜单中选定 Omni Reader PDF。

## 阅读

- **聊天**支持 `$…$`、`\(...\)`、`$$…$$`、`\[…\]` 和 `math` 代码围栏。行内公式随文字排版，表格和代码各自横向滚动，代码块可一键复制。回复完成后生成公式，打字过程沿用 Paseo 的流式显示。
- **文件**从聊天或文件树打开 Markdown 与 PDF，选择面板后两处共用同一预览。代码链接如 `./src/example.ts#L31` 仍使用 Paseo 原生的行号跳转。
- **长文**按约 24 KiB 的 UTF-8 片段加载，接近底部时继续读取。Markdown 面板可切换排版和源码。文本面板支持 `.txt`、`.text`、`.log`。
- **PDF**按页加载。电脑用鼠标拖动页面，手机双指缩放后用单指平移。工具栏提供适合宽度、恢复到 100%、上一页、下一页和页码跳转。

公式和 PDF 在 Paseo daemon 上渲染，客户端通过连接接收结果。渲染无需第三方在线服务。PDF 预览上限为 128 MiB，当前采用逐页图像显示。长 Markdown 的跨片段引用定义和超大片段的复杂嵌套排版可能降级为普通文本。无效或超出引擎范围的 TeX 保留为文本。

## 开发与验收

```sh
npm ci
npm run typecheck
npm test
paseo plugin install "$PWD"
```

工作区里放入一个超过 1 MiB 的 `report.pdf`、一个 Markdown 文件和至少有 31 行的代码文件。让 agent 输出如下 Markdown，并分别从聊天和文件树打开文件。

```markdown
中文 \(E=mc^2\) 和 English $x^2$ 混排。打开 [PDF](./report.pdf)、[文档](./guide.md) 或 [第 31 行](./example.ts#L31)。

| 项目 | Formula |
| --- | --- |
| 面积 | $\frac{bh}{2}$ |
```

放大 PDF，在页面上半部从右向左拖，确认可以看到原先被裁掉的右边内容。测试套件会生成超过 1 MiB 的 PDF 和 UTF-8 Markdown，验证公式解析、文件分块、页码和手势边界。

See [the English overview](OVERVIEW.md) for installation requirements and reader behavior.
