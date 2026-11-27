# Paseo Omni Reader

Omni Reader provides read-only workspace previews for Markdown, PDF, Word, Excel and PowerPoint. Open files in the main panel or on the side using Paseo’s **Open location** settings. The plugin also renders LaTeX in streaming assistant replies. Use **Restore original reply** to switch back to Paseo’s Markdown.

Use Paseo 0.17.5 or newer on the daemon and client. The plugin supports browser, desktop, iOS and Android clients. If Paseo asks which Markdown viewer to use, choose Omni Reader and remember the choice.

Inline fractions get room for the numerator and denominator. Standalone equations are centered. Both follow Paseo’s chat content font size, with separate size presets from 50% to 200% in the plugin settings. Hover for LaTeX or click to copy in a browser. Touch and hold any formula in the native app to show or copy its LaTeX. Failed formulas keep their source and offer a retry.

Markdown supports the same LaTeX as chat, a source view, and loading large files as you read. PDF and formatted Office pages scroll vertically. At 100%, an entire page fits the viewport by width or height. Use the toolbar or focus the preview and press `+`, `-`, or `0`. PDFs can be up to 128 MiB. For Office files up to 24 MiB, LibreOffice on the Paseo host renders formatted Word pages, Excel print layouts and PowerPoint slides. Excel also opens in a scrollable read-only worksheet grid that works without LibreOffice.

On iOS and Android, Omni Reader shows file content in full screen so swipes stay inside the reader. Pinch to zoom and drag with one finger in PDF pages, formatted Office pages, and Excel worksheets. In Paseo 0.17.6, the full-screen × returns to the file header. Use Paseo’s × to close the file or the full-screen icon to reopen it.

For workspaces on the local Paseo Desktop daemon, **Open externally** opens the original in the system’s default app. Browsers and remote desktop workspaces download a copy. On iOS and Android, the action uses the system share sheet. If sharing is unavailable on Android, download the file from Paseo’s file menu. The daemon reads files in the workspace and returns rendered content to the connected Paseo client. The plugin uses no external rendering service.
