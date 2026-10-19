/**
 * Stable finding identity.
 *
 * The whole value of Donna is the diff between "before the agent ran" and
 * "after", so a finding's id must not change when the file is reformatted or
 * lines shift. Ids are therefore derived from the rule plus a semantic key
 * (the modules and layers involved), never from positions.
 */

/** FNV-1a, 32-bit. Short, deterministic, and good enough for set membership. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function findingId(ruleId: string, parts: (string | number | null | undefined)[]): string {
  const key = parts.map((p) => String(p ?? '')).join('|');
  return `${ruleId}:${fnv1a(key)}`;
}
