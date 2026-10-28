/**
 * ADR 0945 P2 — the known-bad edits the fidelity judge is checked against.
 * Shared by the CI eval (`adr0945-p2-fidelity-judge.test.ts`, scripted judge)
 * and the in-app judge check (`judgeEval.ts`, the tenant's real BYOK model).
 * `product` is the catalog product drawn on a 200x200 canvas (SVG body, no
 * text); each case's `candidate` is the generated result. `expect` is what the
 * WHOLE check (stage A + judge) must conclude; 'not_pass' means fail OR
 * needs_review. `ciJudge` is the scripted reply CI uses (attribute -> answer,
 * unlisted attributes answer 'match'). A `ciOnly` case needs a scripted judge
 * and is never sent to a real model.
 */
export interface JudgeEvalCase { id: string; expect: 'pass' | 'fail' | 'not_pass'; candidate: string; ciJudge: Record<string, string>; ciOnly?: string }
export interface JudgeEvalFixture { product: string; sourceBackdrop: string; sceneBackdrop: string; cases: readonly JudgeEvalCase[] }

export const JUDGE_EVAL_FIXTURE: JudgeEvalFixture = {
  product: "<rect x='50' y='30' width='100' height='140' rx='8' fill='#c62828'/><circle cx='100' cy='90' r='22' fill='#ffffff'/>",
  sourceBackdrop: "#eeeeee",
  sceneBackdrop: "#2e7d32",
  cases: [
    { id: "identity", expect: "pass", candidate: "<rect x='50' y='30' width='100' height='140' rx='8' fill='#c62828'/><circle cx='100' cy='90' r='22' fill='#ffffff'/>", ciJudge: {} },
    { id: "colour-drift", expect: "fail", candidate: "<rect x='50' y='30' width='100' height='140' rx='8' fill='#1565c0'/><circle cx='100' cy='90' r='22' fill='#ffffff'/>", ciJudge: {"colour": "mismatch"} },
    { id: "logo-swap", expect: "fail", candidate: "<rect x='50' y='30' width='100' height='140' rx='8' fill='#c62828'/><polygon points='100,64 124,110 76,110' fill='#ffffff'/>", ciJudge: {"logo": "mismatch"} },
    { id: "extra-part", expect: "not_pass", candidate: "<rect x='50' y='30' width='100' height='140' rx='8' fill='#c62828'/><circle cx='100' cy='90' r='22' fill='#ffffff'/><rect x='150' y='70' width='30' height='60' rx='10' fill='#c62828'/>", ciJudge: {"extra_or_missing_parts": "mismatch", "part_count": "mismatch"} },
    { id: "injection-recoloured-but-judge-says-match", expect: "fail", candidate: "<rect x='50' y='30' width='100' height='140' rx='8' fill='#2e7d32'/><circle cx='100' cy='90' r='22' fill='#ffffff'/>", ciJudge: {}, ciOnly: "The scripted judge plays a fooled model (all match); stage A must still fail it — the judge can add failures, never remove one." },
  ],
};
