# Paseo Omni Reader

Omni Reader adds LaTeX to streaming assistant replies and read-only workspace previews for Markdown, text, code, PDFs, Office files, CSV, HTML and images. Open a document from a chat link or the file tree.

Use Paseo 0.17.4 or newer on the daemon and client. The plugin supports web, iOS and Android. Select the Omni Reader panel in Paseo’s file panel picker and remember it on each client. A Git installation requires Node.js 22 or newer and npm on the daemon host. The plugin builds its rendering worker from locked dependencies during installation.

Inline fractions get room for the numerator and denominator. Standalone equations are centered. Hover for LaTeX or click to copy in a browser. Touch and hold any formula in the native app to show or copy its LaTeX. Failed formulas keep their source and offer a retry. Markdown can switch to source, and long UTF-8 documents load as you read.

PDFs up to 128 MiB render one page at a time. Drag with a mouse or use pinch and pan in the native full-screen reader. The toolbar fits the width, restores 100% zoom or jumps to a page. Office previews show Word paragraphs and tables, Excel cell values by worksheet, and PowerPoint text by slide. Structured previews show up to 24 MiB of input within fixed preview limits.

Use **Open externally** to download a copy in a browser or send one to the system share sheet on iOS and Android. If sharing is unavailable on Android, download the file from Paseo’s file menu. The daemon reads files in the workspace and returns rendered content to the connected Paseo client. The plugin uses no external rendering service.
