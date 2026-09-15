import { decodeBody, decodeEditHistory, type DecodeResult, type EditMetadataResult } from "./archive.js";

export type { DecodeResult, EditMetadataResult } from "./archive.js";

// Decodes message bodies and edit histories in process. The async surface and
// the session wrapper remain so callers can batch and yield between batches.
export class MessageTextDecoder {
  async withSession<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  healthState(): "untested" | "healthy" | "failed" {
    return "healthy";
  }

  async selfTest(): Promise<boolean> {
    return true;
  }

  async decode(blobs: Buffer[]): Promise<DecodeResult[]> {
    return blobs.map(decodeBody);
  }

  async decodeEditMetadata(blobs: Buffer[]): Promise<EditMetadataResult[]> {
    return blobs.map(decodeEditHistory);
  }
}

export function populatedMessageText(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0 || text === "￼") return null;
  return text;
}
