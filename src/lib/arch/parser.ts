import type { SeqStep } from "./types";

/**
 * Minimal Mermaid sequenceDiagram parser.
 * Supports:
 *   participant X as Label
 *   A->>B: msg        sync call
 *   A-)B: msg         async fire-and-forget
 *   A-->>B: msg       response (sync reply)
 *   Note over A,B: x  note
 * Other lines are ignored (autonumber, activate, etc.).
 */
export interface ParseResult {
  participants: { id: string; label: string }[];
  steps: SeqStep[];
  errors: string[];
}

const ARROWS: { token: string; kind: SeqStep["kind"] }[] = [
  { token: "-->>", kind: "response" },
  { token: "->>", kind: "sync" },
  { token: "-)", kind: "async" },
  { token: "->", kind: "sync" },
];

export function parseSequence(src: string): ParseResult {
  const lines = src.split("\n");
  const participants: { id: string; label: string }[] = [];
  const steps: SeqStep[] = [];
  const errors: string[] = [];
  let idx = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("%%") || raw.startsWith("sequenceDiagram") || raw === "autonumber")
      continue;

    if (raw.toLowerCase().startsWith("participant ") || raw.toLowerCase().startsWith("actor ")) {
      const rest = raw.replace(/^(participant|actor)\s+/i, "");
      const m = rest.match(/^(\S+)(?:\s+as\s+(.+))?$/i);
      if (m) participants.push({ id: m[1], label: m[2] ?? m[1] });
      continue;
    }

    if (raw.toLowerCase().startsWith("note ")) {
      // Note over A: text  | Note over A,B: text | Note left of A: text
      const m = raw.match(/^note\s+(?:over|left of|right of)\s+([^:]+):\s*(.+)$/i);
      if (m) {
        const who = m[1].split(",")[0].trim();
        steps.push({ index: idx++, raw, kind: "note", from: who, label: m[2].trim() });
      }
      continue;
    }

    let matched = false;
    for (const a of ARROWS) {
      const i2 = raw.indexOf(a.token);
      if (i2 > 0) {
        const before = raw.slice(0, i2).trim();
        const after = raw.slice(i2 + a.token.length);
        const colon = after.indexOf(":");
        const to = (colon >= 0 ? after.slice(0, colon) : after).trim();
        const label = colon >= 0 ? after.slice(colon + 1).trim() : "";
        if (before && to) {
          steps.push({ index: idx++, raw, kind: a.kind, from: before, to, label });
          matched = true;
        }
        break;
      }
    }
    if (!matched && raw) {
      // ignore silently — keep parser permissive
    }
  }

  // Auto-add participants implied by steps
  const known = new Set(participants.map((p) => p.id));
  for (const s of steps) {
    for (const id of [s.from, s.to]) {
      if (id && !known.has(id)) {
        participants.push({ id, label: id });
        known.add(id);
      }
    }
  }

  return { participants, steps, errors };
}
