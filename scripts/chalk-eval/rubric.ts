import {
  ARTICLE_TYPE_SPECS,
  type ArticleType,
  type ArticleTypeChoice,
} from '../../utils/comprehension';
import type { EvalResults } from './shared';

const EXPLAINER_DRAW_SYSTEM = `You are an exacting art director judging chalkboard illustrations for a narrated lesson.
Each board is a 1000×600 chalkboard. A fixed renderer paints simple chalk strokes: stick figures, boxes, arrows, short labels, tiny code. The heading at the top is written by the renderer, not the illustrator. Judge only the illustrator's choices: what is drawn, where, and how well it teaches.

Score every board from 1 to 10 on each criterion (use the whole scale; 5 is mediocre, 9–10 is rare):
- fidelity: depicts what the narration and art direction describe; each spoken line adds something relevant.
- clarity: a viewer grasps the idea at a glance; the visual metaphor makes sense; labels are readable.
- composition: balanced layout that uses the space; nothing overlapping, cramped, cut off, or floating aimlessly.
- appeal: charming and engaging; a learner would want to keep watching.
Boards are labeled in random order; the order and labels carry no meaning. Give a one-sentence note per board naming its biggest strength or flaw. Then rank all boards from best to worst.`;

const EXPLAINER_WRITE_SYSTEM = `You are an expert teacher and editor judging lesson plans for a narrated chalkboard lesson generated from a source article. Each plan has boards (scenes) with a heading, art direction for a stick-figure illustrator, and spoken lines with short chalk notes.

Score every plan from 1 to 10 on each criterion (use the whole scale; 5 is mediocre, 9–10 is rare):
- accuracy: faithful to the source; covers its key ideas; invents no facts, numbers, or advice.
- teaching: hooks the listener, builds ideas in a sensible order, flags pitfalls, and recaps; genuinely teaches rather than summarizes.
- narration: natural spoken language that works by ear alone; lines are concise and speakable.
- drawability: art direction is concrete and visual for a stick-figure illustrator; each board builds one coherent picture.
Plans are labeled in random order; the order and labels carry no meaning. Give a one-sentence note per plan naming its biggest strength or flaw. Then rank all plans from best to worst.`;

function articleTypeLine(type: ArticleType): string {
  const spec = ARTICLE_TYPE_SPECS[type];
  return `The source article is of type "${spec.label}": it ${spec.cue}.`;
}

/**
 * The board judge's rubric. Explainers (and runs with no known type) keep the
 * original teaching rubric; other types are judged against their own boards.
 */
export function drawRubric(type: ArticleType | undefined): string {
  if (!type || type === 'explainer') return EXPLAINER_DRAW_SYSTEM;
  const spec = ARTICLE_TYPE_SPECS[type];
  return `You are an exacting art director judging chalkboard illustrations for a narrated chalkboard presentation of an article. ${articleTypeLine(type)}
Each board is a 1000×600 chalkboard. A fixed renderer paints simple chalk strokes: stick figures, boxes, arrows, short labels, tiny code. The heading at the top is written by the renderer, not the illustrator. Judge only the illustrator's choices: what is drawn, where, and how well it carries the piece the way this type should be shown.

Score every board from 1 to 10 on each criterion (use the whole scale; 5 is mediocre, 9–10 is rare):
- fidelity: depicts what the narration and art direction describe; each spoken line adds something relevant; true to how this type's boards should look: ${spec.board} Turning the piece into a classroom lesson scores low.
- clarity: a viewer grasps the idea at a glance; the visual metaphor makes sense; labels are readable.
- composition: balanced layout that uses the space; nothing overlapping, cramped, cut off, or floating aimlessly.
- appeal: charming and engaging; a viewer would want to keep watching.
Boards are labeled in random order; the order and labels carry no meaning. Give a one-sentence note per board naming its biggest strength or flaw. Then rank all boards from best to worst.`;
}

/**
 * The plan judge's rubric. The criterion keys never change; for types other
 * than explainers, "teaching" scores fidelity to that type's arc.
 */
export function writeRubric(type: ArticleType | undefined): string {
  if (!type || type === 'explainer') return EXPLAINER_WRITE_SYSTEM;
  const spec = ARTICLE_TYPE_SPECS[type];
  return `You are an expert editor judging plans for a narrated chalkboard presentation generated from a source article. ${articleTypeLine(type)} Each plan has boards (scenes) with a heading, art direction for a stick-figure illustrator, and spoken lines with short chalk notes.

Score every plan from 1 to 10 on each criterion (use the whole scale; 5 is mediocre, 9–10 is rare):
- accuracy: faithful to the source; covers its key ideas; invents no facts, numbers, or advice.
- teaching: here, fidelity to the arc this type calls for. The arc: ${spec.arc} The boards: ${spec.board} Score how well the plan follows that arc; turning the piece into a classroom lesson or a flat summary scores low.
- narration: natural spoken language that works by ear alone; lines are concise and speakable.
- drawability: art direction is concrete and visual for a stick-figure illustrator; each board builds one coherent picture.
Plans are labeled in random order; the order and labels carry no meaning. Give a one-sentence note per plan naming its biggest strength or flaw. Then rank all plans from best to worst.`;
}

type RubricSource = Pick<EvalResults, 'articleTypeChoice' | 'writing' | 'reference'>;

function forcedType(choice: ArticleTypeChoice | undefined): ArticleType | undefined {
  return choice && choice !== 'infer' ? choice : undefined;
}

/**
 * The type the plans are judged as: the type the writers were told to use,
 * else the type most writers inferred (earliest writer breaks a tie), else the
 * reference's. Undefined means a run from before article types.
 */
export function writingRubricType(results: RubricSource): ArticleType | undefined {
  const forced = forcedType(results.articleTypeChoice);
  if (forced) return forced;
  const counts = new Map<ArticleType, number>();
  for (const run of results.writing) {
    if (run.ok && run.articleType) {
      counts.set(run.articleType.type, (counts.get(run.articleType.type) ?? 0) + 1);
    }
  }
  let best: ArticleType | undefined;
  for (const [type, count] of counts) {
    if (best === undefined || count > counts.get(best)!) best = type;
  }
  return best ?? results.reference?.articleType?.type;
}

/**
 * The type the reference lesson's boards are drawn and judged as: the type it
 * was written as, else the forced choice (a reference from before article types).
 */
export function drawingRubricType(results: RubricSource): ArticleType | undefined {
  return results.reference?.articleType?.type ?? forcedType(results.articleTypeChoice);
}
