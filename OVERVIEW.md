# Omni Reader

Omni Reader provides read-only workspace previews for Markdown, PDF, Word, Excel and PowerPoint. Open files in the main panel or on the side using Paseo’s **Open location** settings. The plugin also renders LaTeX in streaming assistant replies. Use **Restore original reply** to switch back to Paseo’s Markdown.

Use Paseo 0.17.5 or newer on the daemon and client. The plugin supports browser, desktop, iOS and Android clients. If Paseo asks which Markdown viewer to use, choose Omni Reader and remember the choice.

Inline fractions get room for the numerator and denominator. Standalone equations are centered. Both follow Paseo’s chat content font size, with separate size presets from 50% to 200% in the plugin settings. Hover for LaTeX or click to copy in a browser. On mobile, tap a formula to preview it and copy its LaTeX. The preview includes a **Copy LaTeX source** button. Failed formulas keep their source and offer a retry.

Each viewer shows the file size above its controls. Markdown also shows the line count and loads large files as you read. PDFs can be up to 128 MiB. For `.docx`, `.xlsx` and `.pptx` files up to 24 MiB, install LibreOffice on the Paseo host to see formatted Word pages, Excel print layouts and PowerPoint slides. Excel’s worksheet grid works without LibreOffice.

- **Markdown.** Read rendered LaTeX alongside numbered source. Wide desktop and tablet panels default to a side-by-side split. On narrow panels, you can stack the panes. Both panes follow each other as you scroll, and a block’s source button highlights its matching lines. Find searches the whole file, including sections you have yet to load, with case-sensitive, whole-word and regular-expression options.
- **PDF and Office pages.** Scroll through continuously stacked pages, jump to a page or slide, and use the slider or type a zoom percentage. At 100%, each page fits by width or height. Select and copy text directly, or use the floating search bar without changing the page fit. PDF text selection and find require a text layer. PowerPoint opens with a collapsible slide thumbnail sidebar.
- **Excel worksheets.** Inspect wrapped text and merged cells, then switch between sheets or open the print layout. Find `A4` to match both the address and cell text, or enable **Cell address only**. Right-click or touch and hold a cell to freeze or unfreeze its row or column independently.

On iOS and Android, previews open in Paseo’s file panel. Pinch to zoom and drag with one finger in PDF pages, formatted Office pages, and Excel worksheets. Close the preview with Paseo’s ×.

For workspaces on the local Paseo Desktop daemon, **Open externally** opens the original in the system’s default app. Browsers and remote desktop workspaces download a copy. On iOS and Android, the action uses the system share sheet. If sharing is unavailable on Android, download the file from Paseo’s file menu. The daemon reads files in the workspace and returns rendered content to the connected Paseo client. The plugin uses no external rendering service.
