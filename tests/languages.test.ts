import assert from "node:assert/strict";
import test from "node:test";
import { languageFromDetection } from "../utils/languages";

void test("a reliable detection names the page's dominant language", () => {
  assert.equal(
    languageFromDetection({
      isReliable: true,
      languages: [
        { language: "en", percentage: 22 },
        { language: "es", percentage: 77 },
      ],
    }),
    "es",
  );
});

void test("regional and legacy detector codes map to output languages", () => {
  const detect = (language: string) =>
    languageFromDetection({ isReliable: true, languages: [{ language, percentage: 99 }] });
  assert.equal(detect("zh-Hant"), "zh");
  assert.equal(detect("pt-BR"), "pt");
  assert.equal(detect("iw"), "he");
  assert.equal(detect("nb"), "no");
  assert.equal(detect("fil"), "tl");
});

void test("unsure or unsupported detections leave the language to the model", () => {
  assert.equal(
    languageFromDetection({ isReliable: false, languages: [{ language: "en", percentage: 60 }] }),
    null,
  );
  assert.equal(
    languageFromDetection({ isReliable: true, languages: [{ language: "und", percentage: 100 }] }),
    null,
  );
  assert.equal(
    languageFromDetection({ isReliable: true, languages: [{ language: "yo", percentage: 95 }] }),
    null,
  );
  assert.equal(languageFromDetection({ isReliable: true, languages: [] }), null);
  assert.equal(languageFromDetection(undefined), null);
});
