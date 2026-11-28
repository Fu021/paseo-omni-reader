# Paseo Omni Reader 维护指南

- [GitHub 仓库](https://github.com/Fu021/paseo-omni-reader)使用 `main` 分支。[npm 包](https://www.npmjs.com/package/paseo-omni-reader)为 `paseo-omni-reader`，Paseo 市场 ID 为 `fu021/omni-reader`。
- 插件增强聊天中的 Markdown 和 LaTeX，并提供 Markdown、PDF、Word、Excel、PowerPoint 的只读预览。最低支持版本以 `paseo-plugin.json` 为准，开发使用 Node.js 22 或以上。
- `client/` 负责界面与交互，`server/` 负责文件读取和渲染，`shared/` 定义共享逻辑与 RPC 契约。`reader-test-fixtures/` 存放本地验收样例，由 Git 忽略。
- 遇到复杂任务或连续追加、需要排队的任务时，自动创建 Goal，或将新增要求纳入正在进行的 Goal 并持续跟进。

## 本机验证

- 首次安装依赖运行 `npm ci --include=dev --ignore-scripts`。从源码构建需要 Rust 1.92 或以上、`wasm32-unknown-unknown` 目标和 `wasm-bindgen-cli` 0.2.115。修改后运行 `npm run typecheck`、`npm test` 和 `npm run test:office`。`npm run check:package` 验证发布包可离线安装并预览 Office 文件。
- 每次完成功能并通过相关检查后，直接在用户日常使用的本机 Paseo 守护进程上重载开发版，确认它已运行再交付。先用 `paseo plugin ls --json` 按安装路径确认本检出的运行时 ID，再执行 `paseo plugin reload <ID>`。
- 首次在该守护进程加载开发版时，执行 `paseo plugin install <检出目录绝对路径> --id <ID>`。默认 ID 为 `paseo-omni-reader`，市场版占用时使用 `local-paseo-omni-reader`。若市场版已启用，切换到开发版时暂时停用市场版，保留其安装和设置。切换失败时恢复原先启用的版本。
- 用 `paseo plugin ls <ID> --json` 确认开发版状态为 `running`。隔离环境可用于额外验证。本机开发版通过 `reload` 加载改动，守护进程保持运行。

## 发布

- 经用户确认后推送 `main`。发布前同步 `package.json` 和 `package-lock.json` 的版本，运行 `npm run check:package -- --paseo` 并确认 GitHub CI 通过。
- 用 `npm run pack:release` 生成发布包。npm 需要双重验证时走 `npm stage publish`，发起审批并把验证链接交给用户。公开后从 npm 安装验证。
- npm 新版本验证通过后，向 [Paseo 市场](https://github.com/getpaseo/plugins)提交更新 PR。核对市场固定版本，若已有同版本的 `bump` PR 则沿用。用市场的锁定工具生成 `plugins/fu021/omni-reader.json`，运行 `npm test` 和 `npm run validate -- --online --changed`，并把 npm 版本页和审核 PR 链接发给用户。
- 市场保留 `OVERVIEW.md` 和 `OVERVIEW.zh-CN.md` 两份介绍，使用三张英文展示图。插件界面支持简体中文，其他语言回退到英文。
