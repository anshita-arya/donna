"use strict";
/**
 * Donna core types.
 *
 * Nothing in `src/core`, `src/evidence`, `src/constraints` or `src/assess`
 * imports `vscode`, so the whole assessment pipeline runs headlessly — in the
 * eval harness, in CI, and in tests. Only `src/ui`, `src/agents/llm.ts` and
 * `extension.ts` touch the editor API.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERDICT_LABELS = exports.ESCALATION_LABELS = exports.DIMENSION_LABELS = void 0;
exports.DIMENSION_LABELS = {
    'blast-radius': 'Blast radius',
    'design-conformance': 'Design conformance',
    'backward-compatibility': 'Backward compatibility',
    'test-coverage': 'Test coverage',
    'production-risk': 'Production risk',
    'review-routing': 'Review routing',
};
exports.ESCALATION_LABELS = {
    'design-conflict': 'Conflicts with a documented design decision',
    'missing-documentation': 'No design documentation covers this area',
    'missing-ownership': 'No owner recorded for an affected component',
    'compat-uncertain': 'Backward compatibility could not be established',
    'production-behavior-change': 'May change production behavior',
};
exports.VERDICT_LABELS = {
    'ready-to-propose': 'Looks ready to propose',
    'needs-revision': 'Needs revision before PR',
    'escalate-to-design-review': 'Send to design review',
};
//# sourceMappingURL=types.js.map