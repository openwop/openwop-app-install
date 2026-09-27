/**
 * CFP-1 (D9) test helper — drive a territory model activation/archival through the
 * SHARED reviews gate (it is no longer a direct route mutation). The submit route
 * returns `202 { review: { approvalId } }`; this approves it via the reviews inbox
 * so downstream setup gets an active/archived model exactly as before the gate.
 *
 * Returns the SUBMIT response verbatim when it is not 202 (403/404/409 preserved,
 * so RBAC / illegal-transition assertions still read naturally), else the decision
 * response (`{ status: 'approved' }`).
 */
export interface ReviewHttpClient {
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

export async function transitionModelViaReview(
  client: ReviewHttpClient,
  base: string,
  modelId: string,
  transition: 'activate' | 'archive' = 'activate',
): Promise<{ status: number; body: any }> {
  const submit = await client.post(`${base}/models/${modelId}/${transition}`);
  if (submit.status !== 202) return submit; // 403 / 404 / 409 surfaced verbatim
  const approvalId = submit.body.review.approvalId as string;
  return client.post(`/v1/host/openwop-app/reviews/approval:${approvalId}/actions/approve`);
}
