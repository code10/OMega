/**
 * Recursively split text into semantically coherent chunks with overlap.
 * Tries markdown headings -> double newlines -> single newlines -> sentences -> spaces.
 */
export function recursiveChunkText(
  text: string,
  { chunkSize = 800, chunkOverlap = 120 }: { chunkSize?: number; chunkOverlap?: number } = {}
): string[] {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const separators = [/\n(?=#{1,3}\s)/, /\n{2,}/, /\n/, /(?<=[.!?])\s+/, /\s+/];

  const splitRecursive = (str: string, sepIdx: number): string[] => {
    if (str.length <= chunkSize) return [str.trim()];
    if (sepIdx >= separators.length) {
      const slices: string[] = [];
      for (let i = 0; i < str.length; i += Math.max(1, chunkSize - chunkOverlap)) {
        slices.push(str.slice(i, i + chunkSize).trim());
      }
      return slices;
    }

    const parts = str.split(separators[sepIdx]).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
      return splitRecursive(str, sepIdx + 1);
    }

    const chunks: string[] = [];
    let current = '';
    for (const part of parts) {
      if (part.length > chunkSize) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        chunks.push(...splitRecursive(part, sepIdx + 1));
        continue;
      }
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= chunkSize) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        if (chunkOverlap > 0 && current) {
          const tail = current.slice(-chunkOverlap).trim();
          const withOverlap = tail ? `${tail}\n${part}` : part;
          current = withOverlap.length <= chunkSize ? withOverlap : part;
        } else {
          current = part;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  };

  return splitRecursive(trimmed, 0).filter((c) => c.length >= 10);
}
