import { createHash } from "node:crypto";

/** Spec 0012: what a seat's own transcript says about one startup send. It never carries transcript or sent text. */
export interface StartupTranscriptConfirmation {
  /** verified: a user or attachment record after the send has the sent text's sha. enqueued_unconfirmed: the only
   *  attributable post-send event is an enqueue (Claude records a queued paste without its text); queued is not
   *  consumed, so this is never verification. */
  outcome: "verified" | "enqueued_unconfirmed" | "not_found" | "unavailable";
  recordType?: "user" | "attachment";
  /** ISO time of the matching record or the enqueue. */
  at?: string;
  /** Post-send records seen, by type. */
  postSendRecords?: Record<string, number>;
  /** sha256 of the sent text with whitespace removed. */
  expectedSha256?: string;
  /** Why the transcript could not be read; fixed wording, never a path or content. */
  reason?: string;
}

const digest = (text: string): string => createHash("sha256").update(text.replace(/\s+/g, "")).digest("hex");
// Claude wraps a bracketed paste in this block inside the user turn or the queued command's prompt.
const PASTED_CONTENT = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g;

type TranscriptRecord = {
  type?: unknown; timestamp?: unknown; operation?: unknown; content?: unknown;
  message?: { content?: unknown }; attachment?: { prompt?: unknown };
};

function recordTexts(record: TranscriptRecord): string[] {
  if (record.type === "user") {
    const content = record.message?.content;
    if (typeof content === "string") return [content];
    if (Array.isArray(content)) {
      return content.flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []));
    }
    return [];
  }
  if (record.type === "attachment") return typeof record.attachment?.prompt === "string" ? [record.attachment.prompt] : [];
  if (record.type === "queue-operation") return typeof record.content === "string" ? [record.content] : [];
  return [];
}

function matches(texts: string[], expected: string): boolean {
  return texts.some((text) => digest(text) === expected || [...text.matchAll(PASTED_CONTENT)].some((m) => digest(m[1]!) === expected));
}

/** Read one transcript (JSONL) for the send of `sentText` made at `sentAtMs`. Only records timestamped at or after
 *  the send count. Unparseable lines and records without a time are skipped. */
export function inspectStartupTranscript(jsonl: string, sentText: string, sentAtMs: number): StartupTranscriptConfirmation {
  const expectedSha256 = digest(sentText);
  const postSendRecords: Record<string, number> = {};
  const enqueues: Array<{ at: string; textFree: boolean; matched: boolean }> = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record: TranscriptRecord;
    try { record = JSON.parse(line) as TranscriptRecord; } catch { continue; }
    const at = typeof record.timestamp === "string" ? record.timestamp : null;
    if (at === null || !(Date.parse(at) >= sentAtMs)) continue;
    const type = typeof record.type === "string" ? record.type : "unknown";
    postSendRecords[type] = (postSendRecords[type] ?? 0) + 1;
    const texts = recordTexts(record);
    if ((type === "user" || type === "attachment") && matches(texts, expectedSha256)) {
      return { outcome: "verified", recordType: type, at, postSendRecords, expectedSha256 };
    }
    if (type === "queue-operation" && record.operation === "enqueue") {
      enqueues.push({ at, textFree: texts.every((text) => !text.trim()), matched: matches(texts, expectedSha256) });
    }
  }
  const ours = enqueues.find((enqueue) => enqueue.matched)
    ?? (enqueues.length === 1 && enqueues[0]!.textFree ? enqueues[0] : undefined);
  return ours
    ? { outcome: "enqueued_unconfirmed", at: ours.at, postSendRecords, expectedSha256 }
    : { outcome: "not_found", postSendRecords, expectedSha256 };
}
