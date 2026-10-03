import { useEffect, useEffectEvent, useRef, type JSX } from 'react';
import { BoardRenderer, type BoardProps } from '../utils/chalk/renderer';

export type ChalkboardProps = BoardProps;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Live chalkboard: repaints stick-figure scenes in sync with the narration
 * playhead. Paints on a canvas in 1000×600 board units.
 */
export function Chalkboard(props: ChalkboardProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestProps = useEffectEvent(() => props);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const renderer = new BoardRenderer(canvas);
    renderer.setCssSize(container.clientWidth, container.clientHeight);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        renderer.setCssSize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(container);

    const motion = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
    const onMotion = () => {
      renderer.reducedMotion = motion?.matches ?? false;
    };
    onMotion();
    motion?.addEventListener('change', onMotion);

    let raf = 0;
    let warned = false;
    const tick = () => {
      try {
        renderer.render(latestProps());
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn('[autovox] chalkboard paint failed', err);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      motion?.removeEventListener('change', onMotion);
    };
  }, []);

  return (
    <div className="chalkboard" ref={containerRef}>
      <canvas className="chalkboard__canvas" role="img" aria-label={props.lesson.title} ref={canvasRef} />
    </div>
  );
}
