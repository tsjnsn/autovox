import { estimateBeatSeconds } from './chalk/timeline';
import {
  flattenBeats,
  type ChalkLesson,
  type ChalkTimeline,
} from './chalk/types';

/**
 * A timeline that shows a saved lesson with no audio. Each scene's time is
 * the end of its last beat, held just before the next scene would replace it.
 */
export function scenePlayback(lesson: ChalkLesson): {
  timeline: ChalkTimeline;
  sceneTime: number[];
} {
  const beats = flattenBeats(lesson);
  const starts: number[] = [];
  const ends: number[] = [];
  const sceneTime: number[] = [];
  let cursor = 0;
  beats.forEach((beat, index) => {
    starts.push(cursor);
    const end = cursor + estimateBeatSeconds(beat.say);
    ends.push(end);
    const next = beats[index + 1];
    sceneTime[beat.scene] =
      next && next.scene !== beat.scene ? Math.max(cursor, end - 0.001) : end;
    cursor = end;
  });
  return { timeline: { starts, ends }, sceneTime };
}
