/** Replies up to this length go out as one message; longer ones are split into readable bubbles. */
const SPLIT_ABOVE = 320;
/** Preferred bubble size when splitting by paragraph. */
const TARGET_CHUNK = 500;
/** More bubbles than this feels like spam, so paragraphs are packed up to the provider limit instead. */
const MAX_CHUNKS = 4;

/**
 * Splits a reply into chat-sized messages: by paragraph first, then by sentence, then by word.
 * Every chunk is at most `maxLength` (the provider limit), so nothing is cut off by the provider.
 */
export function splitReply(text: string, maxLength: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= Math.min(SPLIT_ABOVE, maxLength)) return [trimmed];

  const pieces = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= maxLength ? [p] : hardSplit(p, maxLength)));

  const chunks = pack(pieces, Math.min(TARGET_CHUNK, maxLength));
  return chunks.length <= MAX_CHUNKS ? chunks : pack(pieces, maxLength);
}

/**
 * How long the "typing…" bubble stays before a message goes out, roughly like a fast typist:
 * short answers wait under a second, long ones never more than 3 seconds.
 */
export function typingDelayMs(text: string): number {
  return Math.min(3000, Math.max(800, 600 + text.length * 15));
}

function pack(pieces: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + 2 + piece.length > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** One paragraph longer than the provider allows: cut at sentence ends, then at spaces, then hard. */
function hardSplit(paragraph: string, maxLength: number): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'));
    const space = window.lastIndexOf(' ');
    const cut = sentenceEnd > maxLength / 2 ? sentenceEnd + 1 : space > maxLength / 2 ? space : maxLength;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
