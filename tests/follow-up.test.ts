import assert from "node:assert/strict";
import test from "node:test";
import {
  followUpClipboard,
  followUpOpenUrl,
  isFollowUpTarget,
} from "../utils/followUp";
import type { NewsReportScript } from "../utils/types";

const script: NewsReportScript = {
  headline: "Moon line up tonight",
  lede: "The pull adds when the bodies align.",
  segments: ["Sailors knew the tide tables.", "The rest is geometry."],
  estimatedSeconds: 45,
};

void test("the handoff URL is a bare new chat and carries none of the brief", () => {
  const chatgpt = new URL(followUpOpenUrl("chatgpt"));
  assert.equal(chatgpt.href, "https://chatgpt.com/");
  assert.equal(chatgpt.search, "");

  const claude = new URL(followUpOpenUrl("claude"));
  assert.equal(claude.origin, "https://claude.ai");
  assert.equal(claude.pathname, "/new");
  assert.equal(claude.search, "");

  assert.equal(chatgpt.href.includes("Moon"), false);
  assert.equal(claude.href.includes(script.lede), false);
});

void test("only ChatGPT and Claude are follow-up targets", () => {
  assert.equal(isFollowUpTarget("chatgpt"), true);
  assert.equal(isFollowUpTarget("claude"), true);
  assert.equal(isFollowUpTarget("https://evil.example"), false);
  assert.equal(isFollowUpTarget("openai"), false);
});

void test("the clipboard prompt includes the question and brief, not the page URL", () => {
  const text = followUpClipboard(
    script,
    "  Why does the tide rise? ",
    "Reuters · Moon line up tonight",
  );
  assert.match(text, /Question: Why does the tide rise\?/);
  assert.match(text, /Moon line up tonight/);
  assert.match(text, /Sailors knew the tide tables\./);
  assert.match(text, /Source: Reuters · Moon line up tonight/);
  assert.equal(text.includes("http"), false);
  assert.match(text, /If the brief does not say/);
});

void test("a blank question waits for the follow-up instead of inventing one", () => {
  const text = followUpClipboard(script, "   ", "");
  assert.match(text, /Wait for a follow-up question/);
  assert.equal(text.includes("Question:"), false);
  assert.equal(text.includes("Source:"), false);
  assert.match(text, /The rest is geometry\./);
});
