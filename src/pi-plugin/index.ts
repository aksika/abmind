import { logInfo, logWarn } from "../mem-logger.js";
import { extractEnglishTokens } from "../query-tokenizer.js";
import { createPiRuntime, hasDegraded, type PiRuntime } from "./runtime.js";
import { buildIdentity } from "./identity.js";
import { extractAssistantText, composeAbmindContext } from "./messages.js";
import { createRecallTool, createStoreTool } from "./tools.js";
import {
  createAbtarsStatusTool,
  createAbtarsNotifyTool,
  createAbtarsTaskQueueTool,
  createAbtarsTaskStatusTool,
  createAbtarsPeerListTool,
  createAbtarsPeerDelegateTool,
} from "./abtars-tools.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  BeforeAgentStartEvent,
  AgentEndEvent,
  SessionShutdownEvent,
  SessionCompactEvent,
} from "./pi-types.js";

const TAG = "pi-plugin";
const RECALL_POLICY = { limit: 5, maxChars: 8_000, minScore: 0.25, maxClassification: 2 as 0 | 1 | 2 };

export default async function abmindPiPlugin(pi: ExtensionAPI): Promise<void> {
  const runtime = await createPiRuntime();

  if (hasDegraded(runtime)) {
    logWarn(TAG, "Running in degraded mode — memory unavailable");
  }

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    logInfo(TAG, `session_start: ${event.reason}`);
    const { identity } = buildIdentity(event, ctx);
    runtime.state.identity = identity;
    runtime.state.runGeneration = 0;
    runtime.state.lastCapturedGeneration = -1;
    runtime.state.pendingUserPrompt = null;

    if (!runtime.state.lifecycle) {
      runtime.state.pendingWakeUp = "";
      return;
    }

    try {
      const result = await runtime.state.lifecycle.startSession({
        identity,
        maxChars: 12_000,
      });
      if (result.ok) {
        runtime.state.pendingWakeUp = result.context;
      } else {
        runtime.state.pendingWakeUp = "";
      }
    } catch {
      runtime.state.pendingWakeUp = "";
    }
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
    runtime.state.runGeneration++;
    runtime.state.pendingUserPrompt = event.prompt;

    if (!event.prompt.trim()) return;

    const identity = runtime.state.identity;
    if (!identity || !runtime.state.lifecycle) return;

    let recall = "";
    try {
      const tokens = extractEnglishTokens(event.prompt);
      const result = await runtime.state.lifecycle.prepareTurn({
        identity,
        prompt: event.prompt,
        query: { translated: tokens.length > 0 ? tokens : [event.prompt], original: event.prompt },
        policy: RECALL_POLICY,
      });
      recall = result.context;
    } catch {
      recall = "";
    }

    const wakeUp = runtime.state.pendingWakeUp;
    if (wakeUp) {
      runtime.state.pendingWakeUp = "";
    }

    const composed = composeAbmindContext(wakeUp, recall);
    if (!composed) return;

    pi.sendMessage({
      customType: "abmind-context",
      content: composed,
      display: false,
      details: {
        executionId: identity.executionId,
        wakeUp: !!wakeUp,
        recallHits: recall ? recall.split("\n").filter(l => l.startsWith("- (")).length : 0,
      },
    });
  });

  pi.on("agent_end", async (event: AgentEndEvent, _ctx: ExtensionContext) => {
    const identity = runtime.state.identity;
    if (!identity || !runtime.state.lifecycle) return;

    const currentGeneration = runtime.state.runGeneration;
    const userPrompt = runtime.state.pendingUserPrompt;
    runtime.state.pendingUserPrompt = null;

    if (currentGeneration <= runtime.state.lastCapturedGeneration) return;
    if (!userPrompt) return;

    const assistantText = extractAssistantText(event.messages);
    if (!assistantText) return;

    try {
      const result = runtime.state.lifecycle.completeTurn({
        identity,
        user: { content: userPrompt },
        assistant: { content: assistantText },
      });

      if (result.status === "recorded") {
        runtime.state.lastCapturedGeneration = currentGeneration;
      }
    } catch {
      // fail-open
    }
  });

  pi.on("session_compact", async (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
    // No lifecycle operation — Pi owns compaction.
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    runtime.state.pendingUserPrompt = null;
    runtime.state.identity = null;
    runtime.state.pendingWakeUp = "";
    runtime.state.runGeneration = 0;
    runtime.state.lastCapturedGeneration = -1;
    runtime.close();
  });

  if (runtime.state.lifecycle) {
    const getIdentity = () => {
      if (!runtime.state.identity) {
        throw new Error("No active identity — session_start not yet called");
      }
      return runtime.state.identity;
    };

    pi.registerTool(createRecallTool({ lifecycle: runtime.state.lifecycle, getIdentity }));
    pi.registerTool(createStoreTool({ lifecycle: runtime.state.lifecycle, getIdentity }));
  }

  // #1313 — Pi-to-abtars capability bridge tools (always registered, report unavailable if no credential)
  pi.registerTool(createAbtarsStatusTool());
  pi.registerTool(createAbtarsNotifyTool());
  pi.registerTool(createAbtarsTaskQueueTool());
  pi.registerTool(createAbtarsTaskStatusTool());
  pi.registerTool(createAbtarsPeerListTool());
  pi.registerTool(createAbtarsPeerDelegateTool());
}
