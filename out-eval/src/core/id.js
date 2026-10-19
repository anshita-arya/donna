"use strict";
/**
 * Stable finding identity.
 *
 * The whole value of Donna is the diff between "before the agent ran" and
 * "after", so a finding's id must not change when the file is reformatted or
 * lines shift. Ids are therefore derived from the rule plus a semantic key
 * (the modules and layers involved), never from positions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findingId = findingId;
/** FNV-1a, 32-bit. Short, deterministic, and good enough for set membership. */
function fnv1a(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function findingId(ruleId, parts) {
    const key = parts.map((p) => String(p ?? '')).join('|');
    return `${ruleId}:${fnv1a(key)}`;
}
//# sourceMappingURL=id.js.map