// The largest attributedBody blob any code path decodes. Long pasted texts are
// stored well above 1 MiB, so a lower bound made strict searches fail on
// archives that hold one.
export const MAX_ATTRIBUTED_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_ATTRIBUTED_BODY_LABEL = "4 MiB";
