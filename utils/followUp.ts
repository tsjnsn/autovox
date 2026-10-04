import type { NewsReportScript } from './types';

/**
 * Consumer apps. A query string would be sent as the first message before
 * the brief is pasted, so the link is only the new-chat page.
 */
const FOLLOW_UP_URLS = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
} as const;

export type FollowUpTarget = keyof typeof FOLLOW_UP_URLS;

export function isFollowUpTarget(value: unknown): value is FollowUpTarget {
  return value === 'chatgpt' || value === 'claude';
}

/** Opens the user's own ChatGPT or Claude tab. The brief stays on the clipboard. */
export function followUpOpenUrl(target: FollowUpTarget): string {
  return FOLLOW_UP_URLS[target];
}

/**
 * Clipboard text the user pastes into the app they just opened.
 * Source is the site and title already on the player, never the page URL.
 */
export function followUpClipboard(
  script: NewsReportScript,
  question: string,
  sourceLabel: string,
): string {
  const brief = [script.headline, script.lede, ...script.segments]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
  const lines: string[] = [];
  const asked = question.trim();
  if (asked) {
    lines.push(
      'Answer the question using only this brief. If the brief does not say, say so.',
      '',
      `Question: ${asked}`,
    );
  } else {
    lines.push(
      'A brief is below. Wait for a follow-up question about it, and answer using only the brief.',
    );
  }
  const source = sourceLabel.trim();
  if (source) {
    lines.push('', `Source: ${source}`);
  }
  lines.push('', brief);
  return lines.join('\n');
}

/**
 * Copy during the click, inside the overlay shadow root, and stop the event
 * so the page cannot replace the clipboard with its own selection.
 */
export function copyPlainText(root: ParentNode, text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.tabIndex = -1;
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData?.setData('text/plain', text);
  };
  area.addEventListener('copy', onCopy);
  root.append(area);
  area.focus({ preventScroll: true });
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
