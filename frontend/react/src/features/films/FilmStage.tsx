import { evaluateFilm, type FilmSpec } from '../../../../../contracts/films.js';
import type { FilmPosition } from './playback.js';
import './films.css';

/** Trusted DOM only. Film data cannot supply HTML, CSS, script, or a URL. */
export function FilmStage({ film, position, assetUrls = {} }: { film: FilmSpec; position: FilmPosition; assetUrls?: Record<string, string> }): JSX.Element {
  const { scene, poses } = evaluateFilm(film, position.step, position.progress);
  const visibleText = scene.elements.filter(e => poses[e.id]!.opacity > 0 && e.kind === 'text' && e.text !== scene.title).map(e => e.text).join(' ');
  const sizes = { title: 'film-element--title', body: 'film-element--body', caption: 'film-element--caption' };
  return <div className="film-stage" role="img" aria-label={position.blank ? '' : [scene.title, visibleText].filter(Boolean).join('. ')}>
    {!position.blank && scene.elements.map(element => {
      const pose = poses[element.id]!;
      return <div key={element.id} className={`film-element ${sizes[element.size ?? 'body']} ${element.kind === 'shape' ? 'film-element--shape' : ''} ${element.tone === 'accent' ? 'film-element--accent' : ''}`}
        aria-hidden={pose.opacity === 0}
        style={{ left: `${pose.x * 100}%`, top: `${pose.y * 100}%`, width: `${element.width * 100}%`, height: `${element.height * 100}%`, opacity: pose.opacity, transform: `scale(${pose.scale})` }}>
        {element.kind === 'text' ? element.text : element.kind === 'image' && element.assetId && assetUrls[element.assetId]
          ? <img src={assetUrls[element.assetId]} alt={element.alt ?? ''} draggable={false} /> : element.kind === 'image' ? element.alt : null}
      </div>;
    })}
  </div>;
}
