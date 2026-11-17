export async function boundedJson(
  response: Response,
  limit = 1024 * 1024,
): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("invalid response limit");
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("response limit exceeded");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    // Stop upstream work on an oversized, malformed or failed response while
    // retaining the original failure if stream cancellation itself fails.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
