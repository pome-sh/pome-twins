// SPDX-License-Identifier: Apache-2.0
export type JudgeStatus = "pass" | "fail" | "partial";

export interface JudgeResponse {
  status: JudgeStatus;
  confidence: number;
  explanation: string;
}

const MAX_EXPLANATION = 400;

function mapStatus(value: unknown): JudgeStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "pass" || v === "passed") return "pass";
  if (v === "fail" || v === "failed") return "fail";
  if (v === "partial" || v === "partially_passed" || v === "partially passed") return "partial";
  return null;
}

function clampConfidence(value: unknown): number {
  if (typeof value === "number") return Math.max(0, Math.min(1, value));
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (!Number.isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return 0.3;
}

function sanitize(value: unknown): string {
  if (typeof value !== "string") return "No explanation provided";
  const compact = value.replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "").trim();
  return compact.length > 0 ? compact.slice(0, MAX_EXPLANATION) : "No explanation provided";
}

function fromObject(parsed: Record<string, unknown>): JudgeResponse | null {
  const direct = mapStatus(parsed["status"]);
  if (direct) {
    return {
      status: direct,
      confidence: clampConfidence(parsed["confidence"]),
      explanation: sanitize(parsed["explanation"]),
    };
  }
  for (const key of ["result", "evaluation", "judge", "output"]) {
    const nested = parsed[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const candidate = fromObject(nested as Record<string, unknown>);
      if (candidate) return candidate;
    }
  }
  return null;
}

function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function parseLooseKeyValue(text: string): JudgeResponse | null {
  const statusMatch = text.match(
    /\bstatus\s*[:=]\s*(pass(?:ed)?|fail(?:ed)?|partial(?:ly[_\s-]?passed)?)\b/i,
  );
  if (!statusMatch) return null;
  const status = mapStatus(statusMatch[1]);
  if (!status) return null;
  const conf = text.match(/\bconfidence\s*[:=]\s*([01](?:\.\d+)?)\b/i);
  const expl = text.match(/\bexplanation\s*[:=]\s*(.+)$/im);
  return {
    status,
    confidence: clampConfidence(conf?.[1]),
    explanation: sanitize(expl?.[1]),
  };
}

function inferFreeform(text: string): JudgeResponse | null {
  const normalized = text.replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const partialSignals = [/\bpartial(?:ly)?\b/, /\bsome progress\b/, /\bnot fully\b/, /\bclose but\b/];
  const failSignals = [/\bfailed?\b/, /\bnot satisfied\b/, /\bdid not\b/, /\bmissing\b/, /\bincorrect\b/];
  const passSignals = [/\bpassed?\b/, /\bsatisfied\b/];

  const status = partialSignals.some((p) => p.test(lower))
    ? "partial"
    : failSignals.some((p) => p.test(lower))
      ? "fail"
      : passSignals.some((p) => p.test(lower))
        ? "pass"
        : null;

  if (!status) return null;
  return {
    status,
    confidence: 0.35,
    explanation: sanitize(normalized.split(/(?<=[.!?])\s+/)[0]),
  };
}

export function parseJudgeResponse(text: string): JudgeResponse {
  const candidates: string[] = [text.trim()];
  const blocks = Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi))
    .map((m) => m[1] ?? "")
    .filter(Boolean);
  candidates.push(...blocks);
  candidates.push(...extractBalancedJsonObjects(text));

  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const result = fromObject(parsed as Record<string, unknown>);
        if (result) return result;
      }
    } catch {
      // ignore; try next candidate
    }
  }

  const loose = parseLooseKeyValue(text);
  if (loose) return loose;

  const freeform = inferFreeform(text);
  if (freeform) return freeform;

  return {
    status: "fail",
    confidence: 0.3,
    explanation: "judge response un-parseable",
  };
}
