# Paseo Omni Reader

Omni Reader adds LaTeX to assistant replies and workspace Markdown, and opens PDFs in a reader with page navigation, zoom, and pan. Wide tables and long code scroll within the message or document. Open supported files from the chat or workspace tree and switch Markdown between preview and source.

Use Paseo 0.17.4 or newer on the daemon and client. The reader supports web, iOS, and Android. Select Omni Reader in Paseo’s file panel picker and remember your choice on each device. A Git installation needs Node.js 22 or newer and npm on the daemon machine.

Long UTF-8 documents load in sections as you read. PDFs up to 128 MiB render as page images. The daemon renders PDF pages and formulas and sends the rendered content to the connected client. It does not send file contents or formulas to an external rendering service.
