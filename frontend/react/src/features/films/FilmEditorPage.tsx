import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { blankFilm, validateFilm, type FilmSpec } from '../../../../../contracts/films.js';
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import type { CanvasTypeDefinition, EditorSurfaceProps, ToolbarExtrasProps } from '../../canvas/types.js';
import { useHistoryState } from '../../ui/useHistoryState.js';
import { Button } from '../../ui/Button.js';
import { FilmStage } from './FilmStage.js';

export function FilmPreview({ content }: { content: string }): JSX.Element {
  const { t } = useTranslation('films');
  let film: FilmSpec;
  try { film = JSON.parse(content) as FilmSpec; if (validateFilm(film).length) throw new Error(); }
  catch { return <p role="alert">{t('invalid')}</p>; }
  return <FilmStage film={film} position={{ step: 0, progress: 1, blank: false }} />;
}

function TimelineEditor({ doc, onDocChange }: EditorSurfaceProps<FilmSpec>): JSX.Element {
  const { t } = useTranslation('films');
  const history = useHistoryState(doc);
  const { reset: resetHistory } = history;
  const sent = useRef(doc);
  const [selected, setSelected] = useState(0);
  useEffect(() => { if (doc !== sent.current) { resetHistory(doc); sent.current = doc; } }, [doc, resetHistory]);
  const update = (next: FilmSpec) => { history.set(next); sent.current = next; onDocChange(next); };
  const undo = () => { history.undo(); };
  const redo = () => { history.redo(); };
  useEffect(() => {
    if (history.state !== sent.current) { sent.current = history.state; onDocChange(history.state); }
  }, [history.state, onDocChange]);
  const sceneIndex = Math.min(selected, doc.scenes.length - 1);
  const scene = doc.scenes[sceneIndex]!;
  const edit = (mutate: (next: FilmSpec) => void) => { const next = structuredClone(doc); mutate(next); update(next); };
  return <div className="film-editor">
    <div className="film-toolbar"><Button disabled={!history.canUndo} onClick={undo}>{t('undo')}</Button><Button disabled={!history.canRedo} onClick={redo}>{t('redo')}</Button></div>
    <nav className="film-timeline" aria-label={t('scenes')}>{doc.scenes.map((s, i) => <Button size="sm" key={s.id} aria-current={sceneIndex === i ? 'step' : undefined} onClick={() => setSelected(i)}>{s.title || t('scene', { n: i + 1 })}</Button>)}</nav>
    <FilmStage film={doc} position={{ step: doc.scenes.slice(0, sceneIndex).reduce((n, s) => n + 1 + s.cues.length, 0) + scene.cues.length, progress: 1, blank: false }} />
    <div className="film-editor__fields">
      <label>{t('sceneTitle')}<input value={scene.title} maxLength={240} onChange={e => edit(next => { next.scenes[sceneIndex]!.title = e.target.value; })} /></label>
      {scene.elements.filter(e => e.kind === 'text').map(element => <label key={element.id}>{t('text')}<textarea value={element.text ?? ''} maxLength={4000} onChange={e => edit(next => { next.scenes[sceneIndex]!.elements.find(v => v.id === element.id)!.text = e.target.value; })} /></label>)}
      <label>{t('notes')}<textarea value={scene.notes ?? ''} maxLength={8000} onChange={e => edit(next => { next.scenes[sceneIndex]!.notes = e.target.value; })} /></label>
      <h2>{t('timeline')}</h2><p>{t('cueHelp')}</p>
      {scene.cues.map((cue, index) => <fieldset key={cue.id}><legend>{t('cue', { n: index + 1 })}</legend>
        <label>{t('cueLabel')}<input maxLength={240} value={cue.label} onChange={e => edit(next => { next.scenes[sceneIndex]!.cues[index]!.label = e.target.value; })} /></label>
        <label>{t('duration')}<input type="number" min={0} max={10000} step={50} value={cue.durationMs} onChange={e => { const value = e.target.valueAsNumber; if (Number.isInteger(value) && value >= 0 && value <= 10000) edit(next => { next.scenes[sceneIndex]!.cues[index]!.durationMs = value; }); }} /></label>
      </fieldset>)}
    </div>
  </div>;
}

function PresentButton({ orgId, canvasId, dirty }: ToolbarExtrasProps): JSX.Element {
  const { t } = useTranslation('films');
  const navigate = useNavigate();
  return <Button disabled={!canvasId || dirty} title={dirty ? t('saveFirst') : undefined} onClick={() => navigate(`/films/${encodeURIComponent(canvasId!)}/present?org=${encodeURIComponent(orgId)}`)}>{t('present')}</Button>;
}
export const filmDefinition: CanvasTypeDefinition<FilmSpec> = {
  canvasTypeId: 'canvas.film', toggleId: 'films', touchSupport: 'present', clientBasePath: '/host/openwop-app/films', editorPath: '/films', i18nNamespace: 'films',
  Renderer: FilmPreview, EditorSurface: TimelineEditor, ToolbarExtras: PresentButton, docNameKey: 'title',
  // Invalid persisted state is not silently rewritten; server rejects invalid writes.
  coerceDoc: state => {
    if (Object.keys(state).length === 0) return blankFilm('');
    if (validateFilm(state).length) throw new Error('Invalid film timeline');
    return state as unknown as FilmSpec;
  },
};
export function FilmEditorPage(): JSX.Element { return <CanvasEditorPage definition={filmDefinition} />; }
