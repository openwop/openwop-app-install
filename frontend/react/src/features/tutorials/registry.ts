/**
 * Tutorial registry (ADR 0490) — the MyndHyve seed-registry pattern: adding a
 * tutorial = author a `TutorialData` object in `content/` and append one entry
 * here. Order is display order within a category. CMS-backed (user-authored)
 * tutorials are the recorded follow-on; v1 ships authored seeds only.
 */
import type { TutorialData } from './tutorialTypes.js';
import { buildYourFirstFunnel } from './content/build-your-first-funnel.js';
import { connectYourAi } from './content/connect-your-ai.js';
import { openYourStorefront } from './content/open-your-storefront.js';
import { campaignStudioFirstBrief } from './content/campaign-studio-first-brief.js';
import { modelYourFirstPart } from './content/model-your-first-part.js';

export const TUTORIALS: TutorialData[] = [
  connectYourAi,
  campaignStudioFirstBrief,
  buildYourFirstFunnel,
  openYourStorefront,
  modelYourFirstPart,
];

export function getTutorial(id: string): TutorialData | null {
  return TUTORIALS.find((t) => t.id === id) ?? null;
}
