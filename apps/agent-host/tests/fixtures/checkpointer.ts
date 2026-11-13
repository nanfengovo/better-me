// Resolve this backend-only dependency from the Host package. Web acceptance
// may import this fixture without adding LangGraph to the browser package.
export { MemorySaver } from "@langchain/langgraph";
