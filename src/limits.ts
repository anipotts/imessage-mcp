// The largest attributedBody blob any code path hands to the native Foundation
// decoder. Long pasted texts are stored well above 1 MiB, so a lower bound made
// every strict search on such an archive fail. native/message-text-decoder.js
// enforces the same value on its side of the process boundary; a test keeps the
// two equal. Per-call decoder input and output budgets are separate and did not
// grow with this bound.
export const MAX_ATTRIBUTED_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_ATTRIBUTED_BODY_LABEL = "4 MiB";
