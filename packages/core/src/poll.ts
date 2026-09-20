import { api } from "./api.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NewMessage {
  id: string;
  from_address: string;
  subject: string;
  received_at?: number;
}

export interface PollResult {
  status: "received" | "timeout";
  message?: NewMessage;
  elapsedSec: number;
}

/**
 * Poll a mailbox until a message that wasn't present at the start arrives, or
 * the timeout elapses. Transport-agnostic: the CLI wraps it with stderr
 * progress, the MCP server returns the result as structured JSON.
 *
 * On timeout this resolves with `status: "timeout"` rather than throwing, so an
 * MCP client can simply call the tool again to keep waiting.
 */
export async function pollForNewMessage(
  emailId: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    onTick?: (elapsedSec: number) => void;
  },
): Promise<PollResult> {
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(opts.intervalMs) || opts.intervalMs <= 0 || opts.intervalMs > 2_147_483_647) {
    throw new Error("Timeout and interval must be positive finite durations");
  }
  const startTime = Date.now();
  const deadline = startTime + opts.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const elapsed = () => Math.floor((Date.now() - startTime) / 1000);
  const timedOut = (): PollResult => ({ status: "timeout", elapsedSec: elapsed() });
  try {
    const initial = (await api.listMessages(emailId, undefined, controller.signal)) as any;
    if (Date.now() >= deadline) return timedOut();
    const knownIds = new Set<string>(initial.messages.map((m: any) => m.id));

    while (Date.now() < deadline) {
      opts.onTick?.(elapsed());
      await sleep(Math.min(opts.intervalMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline || controller.signal.aborted) return timedOut();
      const current = (await api.listMessages(emailId, undefined, controller.signal)) as any;
      if (Date.now() >= deadline || controller.signal.aborted) return timedOut();
      const fresh = current.messages.filter((m: any) => !knownIds.has(m.id));
      if (fresh.length > 0) return { status: "received", message: fresh[0], elapsedSec: elapsed() };
    }
    return timedOut();
  } catch (error) {
    if (controller.signal.aborted || Date.now() >= deadline) return timedOut();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
