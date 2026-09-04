import { v } from "convex/values";

export const accountRoleValidator = v.union(
  v.literal("user"),
  v.literal("admin"),
);

export const accountStatusValidator = v.union(
  v.literal("active"),
  v.literal("suspended"),
);

export const reportLengthValidator = v.union(
  v.literal("short"),
  v.literal("standard"),
  v.literal("deep"),
);

export const sessionStatusValidator = v.union(
  v.literal("reserved"),
  v.literal("active"),
  v.literal("completed"),
  v.literal("fault"),
  v.literal("aborted"),
  v.literal("expired"),
  v.literal("provisioning_failed"),
  v.literal("reconcile_failed"),
  v.literal("reconciled"),
);

export const sessionOutcomeValidator = v.union(
  v.literal("completed"),
  v.literal("fault"),
  v.literal("aborted"),
  v.literal("expired"),
);

export const sessionKindValidator = v.union(
  v.literal("brief"),
  v.literal("tts_replay"),
);

export const faultStageValidator = v.union(
  v.literal("extract"),
  v.literal("understand"),
  v.literal("tts"),
  v.literal("none"),
);

export const planKeyValidator = v.union(
  v.literal("trial"),
  v.literal("credit_pack_100"),
);

export const lifecycleEventValidator = v.union(
  v.object({
    type: v.literal("script_ready"),
    estimatedSeconds: v.number(),
  }),
  v.object({
    type: v.literal("playback_started"),
  }),
  v.object({
    type: v.literal("completed"),
    playbackSeconds: v.number(),
  }),
  v.object({
    type: v.literal("fault"),
    stage: faultStageValidator,
    playbackSeconds: v.number(),
  }),
  v.object({
    type: v.literal("aborted"),
    playbackSeconds: v.number(),
  }),
);
