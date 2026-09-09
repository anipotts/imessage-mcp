# Installed demo

![Installed imessage-mcp demo with synthetic data](../assets/demo.gif)

Recorded on 2026-09-09 using Node v24.19.0. The script packs the checkout, installs that tarball into an empty project, runs doctor through npx, and calls the installed server through the MCP SDK. All Messages data is synthetic. The GIF renders the captured responses; it does not show a named client app or a clean Mac installation. Paths are abbreviated.

Reproduce on a supported Mac with Node and ImageMagick installed:

```sh
npm ci
npm run demo:installed
```

Captured transcript:

```text
imessage-mcp 2.0.0-rc.2
Fresh local package install | synthetic Messages data

> npx --no-install imessage-mcp doctor [synthetic database]
  PASS - 10 diagnostic checks

> MCP tools/list
  7 tools, all read-only

> MCP search_messages: "reservation", privacy=full
  1 match
  Dinner reservation at 7. Meet outside.

> MCP search_messages: "reservation", privacy=aggregate
  1 match; no message text or identities returned
```
