/** Bound bytes while streaming, before JSON parsing or signature processing. */
export async function readBoundedText(input: Request | Response, maximum = 1024 * 1024): Promise<string> {
  if (Number(input.headers.get("content-length")) > maximum) throw new Error("Payload too large");
  if (!input.body) return "";
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Payload too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
