import { z } from "zod";
import { secret } from "../../../packages/database/index.ts";
import { boundedJson } from "../../../packages/observability/http.ts";

export class RejectedReply extends Error {
  readonly statusCode = 502;
}
export function repliesAvailable(): boolean {
  return Boolean(
    (process.env.TEAM_XAI_API_KEY_FILE || process.env.TEAM_XAI_API_KEY) &&
    process.env.TEAM_XAI_MODEL,
  );
}
export async function generateReply(
  instructions: string,
  history: { role: string; content: string }[],
  requestId: string,
): Promise<string> {
  if (!repliesAvailable())
    throw Object.assign(new Error("team replies unavailable"), {
      statusCode: 503,
    });
  const messages = [];
  let remaining = 96000;
  for (const entry of history.toReversed()) {
    if (entry.content.length > remaining) break;
    messages.unshift(entry);
    remaining -= entry.content.length;
  }
  if (!messages.length)
    throw new RejectedReply("message exceeds context budget");
  if (instructions) messages.unshift({ role: "system", content: instructions });
  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(25000),
      headers: {
        Authorization: `Bearer ${secret("TEAM_XAI_API_KEY")}`,
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify({
        model: process.env.TEAM_XAI_MODEL,
        messages,
        max_tokens: 2048,
        stream: false,
        store: false,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 413, 422, 429].includes(response.status))
        throw new RejectedReply("provider rejected request");
      throw new Error("provider unavailable");
    }
    return z
      .object({
        choices: z
          .array(
            z.object({
              message: z.object({ content: z.string().min(1).max(24000) }),
            }),
          )
          .nonempty(),
      })
      .parse(await boundedJson(response, 180000)).choices[0]!.message.content;
  } catch (error) {
    if (error instanceof RejectedReply) throw error;
    throw Object.assign(new Error("team replies unavailable"), {
      statusCode: 502,
    });
  }
}
