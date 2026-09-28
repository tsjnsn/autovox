/**
 * Chalkboard lesson contract shared by the planner, the scene drawer, the
 * narration stream, and the board renderer.
 *
 * Board space is a fixed 1000×600 grid (origin top-left, y down). The renderer
 * scales it to whatever canvas size the overlay has.
 */
export const BOARD_WIDTH = 1000;
export const BOARD_HEIGHT = 600;
/** Top band the renderer reserves for the scene heading it writes itself. */
export const BOARD_HEADING_BAND = 80;

export type SessionFormat = 'brief' | 'chalkboard';

export type ChalkAccessory =
  | 'none'
  | 'hat'
  | 'cap'
  | 'glasses'
  | 'bow'
  | 'tie'
  | 'crown'
  | 'beard';

export type ChalkPose =
  | 'stand'
  | 'point_left'
  | 'point_right'
  | 'arms_up'
  | 'think'
  | 'walk'
  | 'sit'
  | 'wave'
  | 'shrug'
  | 'hold';

export type ChalkFace = 'happy' | 'neutral' | 'sad' | 'surprised' | 'confused';

/** Colored chalk is for emphasis only; white is the default. */
export type ChalkColor = 'white' | 'yellow' | 'pink' | 'blue' | 'green';

export const CHALK_ACCESSORIES: readonly ChalkAccessory[] = [
  'none',
  'hat',
  'cap',
  'glasses',
  'bow',
  'tie',
  'crown',
  'beard',
];
export const CHALK_POSES: readonly ChalkPose[] = [
  'stand',
  'point_left',
  'point_right',
  'arms_up',
  'think',
  'walk',
  'sit',
  'wave',
  'shrug',
  'hold',
];
export const CHALK_FACES: readonly ChalkFace[] = [
  'happy',
  'neutral',
  'sad',
  'surprised',
  'confused',
];
export const CHALK_COLORS: readonly ChalkColor[] = [
  'white',
  'yellow',
  'pink',
  'blue',
  'green',
];

/** A recurring stick-figure character, drawn the same way in every scene. */
export interface ChalkCastMember {
  /** Short label written under the figure (≤ 14 chars). */
  name: string;
  accessory: ChalkAccessory;
  /** What the character stands for in the lesson (drawer guidance only). */
  role: string;
}

export interface ChalkBeat {
  /** Spoken narration, 1–3 sentences, read verbatim by the voice. */
  say: string;
  /** ≤ 6-word chalk note; the board falls back to these before art arrives. */
  note: string;
}

/** One full board: written, drawn over several beats, then erased. */
export interface ChalkScene {
  /** Chalk title the renderer writes at the top of the board (≤ 32 chars). */
  heading: string;
  /** Art direction for the whole board: layout, metaphor, cast on stage. */
  visual: string;
  beats: ChalkBeat[];
}

export interface ChalkLesson {
  title: string;
  cast: ChalkCastMember[];
  scenes: ChalkScene[];
  estimatedSeconds: number;
}

interface ChalkElementBase {
  /** Beat index within the scene at which this element is drawn. */
  beat: number;
  color: ChalkColor;
}

/**
 * Sanitized drawing primitives, in board coordinates.
 * - figure: x = body center, y = feet (ground line), size = total height
 * - text / code: x, y = top-left, size = font height
 * - box: x, y = top-left, w × h, label centered inside
 * - circle: x, y = center, r = radius, label centered inside
 * - line / arrow: (x, y) → (x2, y2); arrow curve −1..1 bends the shaft
 * - path: polyline through points
 * - check / cross: x, y = center, size = width
 */
export type ChalkElement =
  | (ChalkElementBase & {
      kind: 'figure';
      x: number;
      y: number;
      size: number;
      pose: ChalkPose;
      face: ChalkFace;
      accessory: ChalkAccessory;
      label: string | null;
      say: string | null;
    })
  | (ChalkElementBase & {
      kind: 'text';
      x: number;
      y: number;
      size: number;
      text: string;
    })
  | (ChalkElementBase & {
      kind: 'box';
      x: number;
      y: number;
      w: number;
      h: number;
      label: string | null;
    })
  | (ChalkElementBase & {
      kind: 'circle';
      x: number;
      y: number;
      r: number;
      label: string | null;
    })
  | (ChalkElementBase & {
      kind: 'line';
      x: number;
      y: number;
      x2: number;
      y2: number;
    })
  | (ChalkElementBase & {
      kind: 'arrow';
      x: number;
      y: number;
      x2: number;
      y2: number;
      curve: number;
      label: string | null;
    })
  | (ChalkElementBase & {
      kind: 'path';
      points: Array<[number, number]>;
      closed: boolean;
    })
  | (ChalkElementBase & {
      kind: 'check' | 'cross';
      x: number;
      y: number;
      size: number;
    })
  | (ChalkElementBase & {
      kind: 'code';
      x: number;
      y: number;
      size: number;
      text: string;
    });

export type ChalkElementKind = ChalkElement['kind'];

export interface ChalkSceneDrawing {
  elements: ChalkElement[];
}

/** A beat addressed in narration order across the whole lesson. */
export interface ChalkBeatRef {
  scene: number;
  beat: number;
  say: string;
  note: string;
}

/**
 * Where each flattened beat sits on the audio's media timeline, in seconds.
 * `starts[i]` is known once beat i's audio starts downloading; `ends[i]` once
 * it finishes. Unknown values are null.
 */
export interface ChalkTimeline {
  starts: (number | null)[];
  ends: (number | null)[];
}

export function flattenBeats(lesson: ChalkLesson): ChalkBeatRef[] {
  const out: ChalkBeatRef[] = [];
  lesson.scenes.forEach((scene, sceneIndex) => {
    scene.beats.forEach((beat, beatIndex) => {
      out.push({
        scene: sceneIndex,
        beat: beatIndex,
        say: beat.say,
        note: beat.note,
      });
    });
  });
  return out;
}
