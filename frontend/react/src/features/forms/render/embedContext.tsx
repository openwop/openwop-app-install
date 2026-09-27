/**
 * ADR 0339 §D2 — the form embed seam. An embedding PUBLIC surface (the funnel
 * viewer today; any future host page) wraps its section tree in
 * `FormEmbedProvider` to hand every rendered form its submission context
 * (ADR 0332 `meta.context`) and an `onSubmitted` hook — without the CMS
 * section or the page authoring model knowing anything about the embedder.
 * Direction: the embedder imports forms' provider (integrator → primitive,
 * the ADR 0330 discipline); `PublicFormRenderer` merges provider context UNDER
 * its own prop (an explicit prop wins) and calls both callbacks.
 */

import { createContext, useContext } from 'react';

export interface FormEmbed {
  /** Opaque submission provenance (bounded server-side — ADR 0332). */
  context?: Record<string, string>;
  /** Fired ONLY with a real submission id (ADR 0584 / FORM-UX-1): an id is the
   *  only proof the server stored anything, so an embedding surface must never
   *  advance off a submission that does not exist. */
  onSubmitted?: (submissionId: string) => void;
  /** ADR 0584 (FORM-UX-4) — the embedder's designed state for an unavailable
   *  form. It exists because the surface that EMBEDS the form is the only one
   *  that knows what "the way forward" is: a CMS page needs an honest line, a
   *  FUNNEL STEP needs an EXIT, because its advance fires only on submit and a
   *  step whose form is gone is otherwise a dead end. An explicit
   *  `renderUnavailable` prop still wins; absent both, the renderer draws its
   *  own designed default (never nothing, which is what shipped). */
  renderUnavailable?: () => React.ReactNode;
}

const Ctx = createContext<FormEmbed | null>(null);

export const FormEmbedProvider = Ctx.Provider;

export function useFormEmbed(): FormEmbed | null {
  return useContext(Ctx);
}
