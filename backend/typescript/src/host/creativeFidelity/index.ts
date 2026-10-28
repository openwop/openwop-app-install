/** ADR 0945 D3 — the host fidelity library (no feature imports). */
export * from './types.js';
export * from './rules.js';
export { rasteriseIntoSlot, rasteriseCrop, rasteriseFull, protectionMaskPng, isRasterisable, type RgbaGrid, type Box } from './raster.js';
export { imageSize } from './imageSize.js';
export { productMask, runStageA, deltaE2000, rgbToLab, dHash, pHash, hamming } from './stageA.js';
export { verdictIdFor, recordVerdict, getVerdict, __clearFidelityVerdicts } from './verdictStore.js';
export { FIDELITY_ATTRIBUTES, CRITICAL_ATTRIBUTES, JUDGE_ANSWERS, judgePrompt, parseJudgeReply, type FidelityAttribute, type JudgeAnswer, type JudgeAttributeResult } from './judgeSchema.js';
export { runFidelityJudge, type JudgeImage, type JudgeOutcome } from './judge.js';
export { judgeOutcome, combineOutcome } from './decide.js';
export { disclosureFor, DISCLOSURE_RULES, DISCLOSURE_RULES_VERSION, type AiDisclosure, type DisclosureDestination } from './disclosureRules.js';
export { JUDGE_EVAL_FIXTURE, type JudgeEvalCase, type JudgeEvalFixture } from './judgeEvalFixture.js';
export { runJudgeEval, summariseProviderError, LIVE_JUDGE_EVAL_CASES, type JudgeEvalReport, type JudgeEvalRow, type ProviderErrorSummary } from './judgeEval.js';
