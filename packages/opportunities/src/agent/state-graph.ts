/**
 * LangGraph-compatible StateGraph implementation.
 * Provides directed acyclic or cyclic state graphs with nodes, edges,
 * conditional edges, entrypoints, and streaming/invoke capabilities.
 */

export const START = "__start__";
export const END = "__end__";

export type NodeAction<TState> = (
  state: TState,
  options?: { signal?: AbortSignal; step?: number }
) => Promise<Partial<TState> | void> | Partial<TState> | void;

export type EdgeCondition<TState> = (
  state: TState
) => string | Promise<string>;

export interface StateGraphOptions {
  maxSteps?: number;
}

export interface GraphStepEvent<TState> {
  node: string;
  step: number;
  state: TState;
  delta?: Partial<TState>;
}

export class StateGraph<TState extends Record<string, any>> {
  private nodes = new Map<string, NodeAction<TState>>();
  private edges = new Map<string, string>();
  private conditionalEdges = new Map<string, EdgeCondition<TState>>();
  private entryPoint?: string;

  constructor(_options?: StateGraphOptions) {
    // optional global configuration
  }

  /**
   * Register a node action in the graph.
   */
  addNode(name: string, action: NodeAction<TState>): this {
    if (name === START || name === END) {
      throw new Error(`Reserved node name: ${name}`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`Node already registered: ${name}`);
    }
    this.nodes.set(name, action);
    return this;
  }

  /**
   * Set the initial entrypoint node of the graph.
   */
  setEntryPoint(name: string): this {
    if (!this.nodes.has(name)) {
      throw new Error(`Unknown entrypoint node: ${name}`);
    }
    this.entryPoint = name;
    return this;
  }

  /**
   * Add a fixed directed edge from one node to another.
   */
  addEdge(from: string, to: string): this {
    if (from === START) {
      this.entryPoint = to;
      return this;
    }
    if (from !== START && !this.nodes.has(from)) {
      throw new Error(`Cannot add edge from unknown node: ${from}`);
    }
    if (to !== END && !this.nodes.has(to)) {
      throw new Error(`Cannot add edge to unknown node: ${to}`);
    }
    this.edges.set(from, to);
    return this;
  }

  /**
   * Add a conditional edge where the next node is computed dynamically from state.
   */
  addConditionalEdges(from: string, condition: EdgeCondition<TState>): this {
    if (!this.nodes.has(from)) {
      throw new Error(`Cannot add conditional edge from unknown node: ${from}`);
    }
    this.conditionalEdges.set(from, condition);
    return this;
  }

  /**
   * Compile the StateGraph into an executable graph.
   */
  compile(): CompiledGraph<TState> {
    if (!this.entryPoint) {
      throw new Error("StateGraph has no entrypoint configured.");
    }
    return new CompiledGraph(
      new Map(this.nodes),
      new Map(this.edges),
      new Map(this.conditionalEdges),
      this.entryPoint
    );
  }
}

export class CompiledGraph<TState extends Record<string, any>> {
  constructor(
    private nodes: Map<string, NodeAction<TState>>,
    private edges: Map<string, string>,
    private conditionalEdges: Map<string, EdgeCondition<TState>>,
    private entryPoint: string
  ) {}

  /**
   * Execute the graph to completion starting from initialState.
   */
  async invoke(
    initialState: TState,
    options?: { signal?: AbortSignal; maxSteps?: number }
  ): Promise<TState> {
    let currentState: TState = { ...initialState };
    const maxSteps = options?.maxSteps ?? 50;
    let currentNode: string | undefined = this.entryPoint;
    let step = 0;

    while (currentNode && currentNode !== END) {
      if (options?.signal?.aborted) {
        throw new Error("Graph execution aborted by signal.");
      }
      step++;
      if (step > maxSteps) {
        throw new Error(`Graph exceeded maxSteps limit (${maxSteps}). Potential infinite cycle.`);
      }

      const action = this.nodes.get(currentNode);
      if (!action) {
        throw new Error(`Node not found during execution: ${currentNode}`);
      }

      const delta = await action(currentState, { signal: options?.signal, step });
      if (delta && typeof delta === "object") {
        currentState = { ...currentState, ...delta };
      }

      // Determine next node
      const cond = this.conditionalEdges.get(currentNode);
      if (cond) {
        currentNode = await cond(currentState);
      } else {
        currentNode = this.edges.get(currentNode) ?? END;
      }
    }

    return currentState;
  }

  /**
   * Stream step events as the graph executes node by node.
   */
  async *stream(
    initialState: TState,
    options?: { signal?: AbortSignal; maxSteps?: number }
  ): AsyncIterable<GraphStepEvent<TState>> {
    let currentState: TState = { ...initialState };
    const maxSteps = options?.maxSteps ?? 50;
    let currentNode: string | undefined = this.entryPoint;
    let step = 0;

    while (currentNode && currentNode !== END) {
      if (options?.signal?.aborted) {
        throw new Error("Graph execution aborted by signal.");
      }
      step++;
      if (step > maxSteps) {
        throw new Error(`Graph exceeded maxSteps limit (${maxSteps}). Potential infinite cycle.`);
      }

      const action = this.nodes.get(currentNode);
      if (!action) {
        throw new Error(`Node not found during execution: ${currentNode}`);
      }

      const delta = await action(currentState, { signal: options?.signal, step });
      if (delta && typeof delta === "object") {
        currentState = { ...currentState, ...delta };
      }

      yield {
        node: currentNode,
        step,
        state: currentState,
        delta: delta || undefined,
      };

      // Determine next node
      const cond = this.conditionalEdges.get(currentNode);
      if (cond) {
        currentNode = await cond(currentState);
      } else {
        currentNode = this.edges.get(currentNode) ?? END;
      }
    }
  }
}
