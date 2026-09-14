import { readFileSync } from "node:fs";

// The server announces its own icon in the MCP handshake, so every client that
// renders serverInfo.icons shows the same mark without fetching anything. Data
// URIs keep it offline; the SVG scales and the 64 px PNG covers clients that
// only draw raster images.
function dataUri(relative: string, mimeType: string): string {
  return `data:${mimeType};base64,${readFileSync(new URL(relative, import.meta.url)).toString("base64")}`;
}

export const SERVER_ICONS = [
  { src: dataUri("../assets/icon.svg", "image/svg+xml"), mimeType: "image/svg+xml", sizes: ["any"] },
  { src: dataUri("../assets/icon-64.png", "image/png"), mimeType: "image/png", sizes: ["64x64"] },
];
