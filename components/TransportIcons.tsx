export function PlayIcon() {
  return (
    <svg className="player__svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg className="player__svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
    </svg>
  );
}

export function VolumeIcon() {
  return (
    <svg className="player__svg player__svg--sm" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
    </svg>
  );
}
