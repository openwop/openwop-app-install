import type { BackendFeature } from '../types.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { registerArtifactType } from '../../host/artifactTypes.js';
import { FILM_SCHEMA, blankFilm, validateFilm, audienceFilm, type FilmSpec } from '../../../../../contracts/films.js';
import { getAsset, viewAsset } from '../media/mediaService.js';
import { OpenwopError } from '../../types.js';

/** Shared host-local films; one canvas store/authority, no protocol advertisement. */
export const filmsFeature: BackendFeature = {
  id: 'films',
  dependsOn: ['media'],
  toggleDefault: { id: 'films', label: 'Animated films', description: 'Animated HTML films with manual cues and a private presenter view. Live speaking needs no recording or AI connection.', category: 'Documents', status: 'off', bucketUnit: 'tenant', salt: 'films-v1' },
  demo: { unseededReason: 'A deterministic fictional film is created through the ordinary canvas creation action; no generated production or completed client approval is fabricated.' },
  registerRoutes(deps) {
    registerArtifactType({ artifactTypeId: 'canvas.film', title: 'Animated film', schema: FILM_SCHEMA, registrationSource: 'host', export: [] });
    registerCanvasEditorRoutes(deps, {
      basePath: '/host/openwop-app/films', feature: { toggleId: 'films', label: 'Animated films' }, canvasTypeId: 'canvas.film',
      defaultOwnerToCaller: true,
      blankState: name => blankFilm(name) as unknown as Record<string, unknown>,
      validate: state => ({ errors: validateFilm(state), warnings: [] }),
      validateSeed: state => ({ errors: validateFilm(state), warnings: [] }),
      extraRoutes: ({ app }, { org, authz, loadCanvas }) => {
        app.get(`${org}/canvases/:canvasId/presenter`, async (req, res, next) => {
          try {
            const { tenantId, orgId, user } = await authz(req, 'workspace:read');
            const c = await loadCanvas(tenantId, req.params.canvasId, user.userId, 'read');
            const errors = validateFilm(c.state);
            if (errors.length) throw new OpenwopError('validation_error', 'Film is invalid.', 422, { errors });
            const film = c.state as unknown as FilmSpec;
            const ids = [...new Set(film.scenes.flatMap(s => s.elements.filter(e => e.kind === 'image').map(e => e.assetId!)))];
            const assetUrls: Record<string, string> = {};
            for (const id of ids) {
              const asset = await getAsset(tenantId, orgId, id);
              if (asset?.contentType.startsWith('image/')) assetUrls[id] = viewAsset(asset).serveUrl;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.json({ canvasId: c.canvasId, version: c.version, film, assetUrls });
          } catch (e) { next(e); }
        });
        // A separate audience response: private notes never reach this payload.
        app.get(`${org}/canvases/:canvasId/audience`, async (req, res, next) => {
          try {
            const { tenantId, user } = await authz(req, 'workspace:read');
            const c = await loadCanvas(tenantId, req.params.canvasId, user.userId, 'read');
            const errors = validateFilm(c.state);
            if (errors.length) throw new OpenwopError('validation_error', 'Film is invalid.', 422, { errors });
            res.setHeader('Cache-Control', 'no-store');
            res.json({ canvasId: c.canvasId, version: c.version, film: audienceFilm(c.state as unknown as FilmSpec) });
          } catch (e) { next(e); }
        });
      },
    });
  },
};
