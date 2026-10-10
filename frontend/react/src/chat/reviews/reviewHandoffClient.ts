/**
 * ADR 0854 D1 — a review's active handoff ("asked someone else to decide").
 * Its own module, not `reviewClient.ts`: the review client loads with the app's
 * entry chunk, and only the lazily loaded `<ReviewHandoff>` needs these two calls.
 */
import { BASE, http } from './reviewClient.js';

export interface ReviewHandoff { reviewId: string; to: string; by: string; at: string; note: unknown }

export async function getReviewHandoff(reviewId: string): Promise<ReviewHandoff | null> {
  return (await http<{ handoff: ReviewHandoff | null }>(`${BASE}/${encodeURIComponent(reviewId)}/handoff`)).handoff;
}

export async function handOffReview(reviewId: string, to: string, handoff: { intent: string; openQuestions?: string[] }): Promise<ReviewHandoff> {
  return (await http<{ handoff: ReviewHandoff }>(`${BASE}/${encodeURIComponent(reviewId)}/handoff`, { method: 'POST', body: JSON.stringify({ to, handoff }) })).handoff;
}
