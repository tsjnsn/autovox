import { Readability } from '@mozilla/readability';
import type { ExtractedArticle } from './types';

function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Remove Autovox UI so prior scripts / overlay chrome never enter the brief. */
function stripAutovoxUi(root: ParentNode): void {
  root
    .querySelectorAll(
      'autovox-overlay, .autovox-host, [data-autovox], [class*="autovox-"]',
    )
    .forEach((el) => el.remove());
}

/**
 * Extract the main article from the current document using Mozilla Readability.
 * Must run in a content-script context with DOM access.
 */
export function extractArticleFromDocument(
  doc: Document = document,
): ExtractedArticle | null {
  const url = doc.location?.href ?? window.location.href;
  const clone = doc.cloneNode(true) as Document;
  stripAutovoxUi(clone);

  const parsed = new Readability(clone, { charThreshold: 200 }).parse();

  if (!parsed?.textContent || parsed.textContent.trim().length < 120) {
    // Use the cleaned clone — never live body.innerText (includes open shadow roots).
    const bodyText = cleanText(clone.body?.textContent ?? '');
    if (bodyText.length < 120) return null;

    return {
      title: doc.title || 'Untitled page',
      byline: null,
      excerpt: bodyText.slice(0, 240),
      siteName: doc.location?.hostname ?? null,
      url,
      textContent: bodyText.slice(0, 60_000),
      length: bodyText.length,
    };
  }

  const textContent = cleanText(parsed.textContent).slice(0, 60_000);

  return {
    title: parsed.title || doc.title || 'Untitled page',
    byline: parsed.byline ?? null,
    excerpt: parsed.excerpt ?? null,
    siteName: parsed.siteName || doc.location?.hostname || null,
    url,
    textContent,
    length: textContent.length,
  };
}
