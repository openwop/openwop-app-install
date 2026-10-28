/**
 * ADR 0941 D5 — the old plan URL `/campaign-studio/:canvasId` (bookmarks, links in
 * past chats) redirects to `/campaign-studio/plans/:canvasId`, keeping the query
 * (`?fromArtifact=` on `new`). It accepts ONLY a canvas-id shape or `new`, so the
 * redirect can never swallow a future one-segment path: anything else goes to the
 * console hub. This is the only one-segment child of `/campaign-studio` (pinned
 * by `campaignStudioRouteTable.test.ts`).
 */
import { Navigate, useLocation, useParams } from 'react-router-dom';

/** A canvas id as `host/canvasSurface.ts` mints it (`canvas-<uuid>`), or `new`. */
export const PLAN_ID_SHAPE = /^(?:new|canvas-[A-Za-z0-9_-]+)$/;

export function PlanRedirect(): JSX.Element {
  const { canvasId = '' } = useParams();
  const { search } = useLocation();
  const target = PLAN_ID_SHAPE.test(canvasId) ? `/campaign-studio/plans/${encodeURIComponent(canvasId)}${search}` : '/campaign-studio';
  return <Navigate to={target} replace />;
}
