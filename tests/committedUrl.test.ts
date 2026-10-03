import assert from "node:assert/strict";
import test from "node:test";
import { watchCommittedUrl } from "../utils/committedUrl";

function setup() {
  const navigation = new EventTarget();
  const controller = new AbortController();
  let url = "https://example.com/article";
  let changes = 0;
  watchCommittedUrl(
    navigation,
    () => url,
    () => {
      changes += 1;
    },
    controller.signal,
  );
  return {
    navigate: () => navigation.dispatchEvent(new Event("navigate")),
    commit: (next: string) => {
      url = next;
      navigation.dispatchEvent(new Event("currententrychange"));
    },
    changes: () => changes,
    stop: () => controller.abort(),
  };
}

void test("a navigation that never commits keeps the overlay", () => {
  const page = setup();
  page.navigate();
  assert.equal(page.changes(), 0);
});

void test("a committed navigation to the same URL keeps the overlay", () => {
  const page = setup();
  page.commit("https://example.com/article");
  assert.equal(page.changes(), 0);
});

void test("each committed URL change is reported once", () => {
  const page = setup();
  page.commit("https://example.com/next");
  page.commit("https://example.com/next");
  page.commit("https://example.com/next#comments");
  assert.equal(page.changes(), 2);
});

void test("stops reporting once the content script is invalidated", () => {
  const page = setup();
  page.stop();
  page.commit("https://example.com/next");
  assert.equal(page.changes(), 0);
});
