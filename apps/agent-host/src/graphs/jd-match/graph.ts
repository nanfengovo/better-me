/**
 * JD Match Graph — compiled graph factory.
 *
 * Graph shape:
 *
 *   START → structureJd → matchProfile → confirmProposals → buildOutput → END
 *                ↓ (error)                      ↑ (resume after interrupt)
 *           → buildOutput
 *
 * Checkpointing:
 *   The SqliteSaver stores thread state between the interrupt() pause and the
 *   browser's resume call. Checkpoint file lives outside the repo at:
 *   ~/Library/Application Support/BetterMe/agent/checkpoints.sqlite
 *
 * The compiled graph is a singleton per process; it is safe to share across
 * concurrent HTTP requests because each request uses its own thread_id.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  JdMatchAnnotation,
} from "./state.js";
import {
  makeStructureJdNode,
  makeMatchProfileNode,
  confirmProposalsNode,
  buildOutputNode,
} from "./nodes.js";

export function buildJdMatchGraph(
  model: BaseChatModel,
  checkpointer: BaseCheckpointSaver
) {
  const structureJd = makeStructureJdNode(model);
  const matchProfile = makeMatchProfileNode(model);

  const graph = new StateGraph(JdMatchAnnotation)
    .addNode("structureJd", structureJd)
    .addNode("matchProfile", matchProfile)
    .addNode("confirmProposals", confirmProposalsNode)
    .addNode("buildOutput", buildOutputNode)
    // Edges
    .addEdge(START, "structureJd")
    .addConditionalEdges("structureJd", (state) => {
      if (state.errors.some((e) => e.startsWith("structureJd:"))) {
        return "buildOutput"; // surface partial output even on error
      }
      return "matchProfile";
    })
    .addConditionalEdges("matchProfile", (state) => {
      if (state.errors.some((e) => e.startsWith("matchProfile:"))) {
        return "buildOutput";
      }
      return "confirmProposals";
    })
    .addEdge("confirmProposals", "buildOutput")
    .addEdge("buildOutput", END);

  return graph.compile({ checkpointer, interruptBefore: ["confirmProposals"] });
}

export type JdMatchGraph = ReturnType<typeof buildJdMatchGraph>;
