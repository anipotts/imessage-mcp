/**
 * Synthetic NSAttributedString archives generated on macOS with Foundation:
 *
 *   NSArchiver.archivedData(withRootObject: NSAttributedString(string: text))
 *
 * The text is deliberately fake. These fixtures contain no Messages data.
 */
export const FOUNDATION_ATTRIBUTED_BODY_FIXTURES = {
  short: {
    text: "Hi from Foundation",
    base64: "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBKxJIaSBmcm9tIEZvdW5kYXRpb26GhAJpSQESkoSEhAxOU0RpY3Rpb25hcnkAlIQBaQCGhg==",
  },
  long: {
    text: "Long message block with exact bytes. ".repeat(8).trim(),
    base64: "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4EoAUxvbmcgbWVzc2FnZSBibG9jayB3aXRoIGV4YWN0IGJ5dGVzLiBMb25nIG1lc3NhZ2UgYmxvY2sgd2l0aCBleGFjdCBieXRlcy4gTG9uZyBtZXNzYWdlIGJsb2NrIHdpdGggZXhhY3QgYnl0ZXMuIExvbmcgbWVzc2FnZSBibG9jayB3aXRoIGV4YWN0IGJ5dGVzLiBMb25nIG1lc3NhZ2UgYmxvY2sgd2l0aCBleGFjdCBieXRlcy4gTG9uZyBtZXNzYWdlIGJsb2NrIHdpdGggZXhhY3QgYnl0ZXMuIExvbmcgbWVzc2FnZSBibG9jayB3aXRoIGV4YWN0IGJ5dGVzLiBMb25nIG1lc3NhZ2UgYmxvY2sgd2l0aCBleGFjdCBieXRlcy4ghoQCaUkBgSgBkoSEhAxOU0RpY3Rpb25hcnkAlIQBaQCGhg==",
  },
  unicode: {
    text: "Cafe\u0301 👋🏽 👩‍💻 日本語 العربية",
    base64: "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBKzRDYWZlzIEg8J+Ri/Cfj70g8J+RqeKAjfCfkrsg5pel5pys6KqeINin2YTYudix2KjZitiphoQCaUkBHJKEhIQMTlNEaWN0aW9uYXJ5AJSEAWkAhoY=",
  },
  multiline: {
    text: "first line\nsecond line\r\nthird line",
    base64: "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBKyYgIGZpcnN0IGxpbmUKc2Vjb25kIGxpbmUNCnRoaXJkIGxpbmUgIIaEAmlJASaShISEDE5TRGljdGlvbmFyeQCUhAFpAIaG",
  },
  issue: {
    text: "Hey Jordan, can you call me back at 555-0173 when you get a chance? Wanted to talk through the weekend plans before I book anything.",
    base64: "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4GEAEhleSBKb3JkYW4sIGNhbiB5b3UgY2FsbCBtZSBiYWNrIGF0IDU1NS0wMTczIHdoZW4geW91IGdldCBhIGNoYW5jZT8gV2FudGVkIHRvIHRhbGsgdGhyb3VnaCB0aGUgd2Vla2VuZCBwbGFucyBiZWZvcmUgSSBib29rIGFueXRoaW5nLoaEAmlJAYGEAJKEhIQMTlNEaWN0aW9uYXJ5AJSEAWkAhoY=",
  },
} as const;

export function attributedBodyFixture(name: keyof typeof FOUNDATION_ATTRIBUTED_BODY_FIXTURES): Buffer {
  return Buffer.from(FOUNDATION_ATTRIBUTED_BODY_FIXTURES[name].base64, "base64");
}

export function malformedAttributedBodyFixture(): Buffer {
  const source = attributedBodyFixture("issue");
  const textStart = source.indexOf(Buffer.from("Hey Jordan"));
  return source.subarray(0, textStart + 24);
}
