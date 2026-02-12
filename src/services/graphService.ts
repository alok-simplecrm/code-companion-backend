import { StateGraph, Annotation } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { Conversation, type IMessage } from "../models/index.js";
import { searchSimilarPRs, searchSimilarCommits, searchSimilarTickets } from "./analysisService.js";
import { generateEmbedding } from "./embeddingService.js";
import { getProjectContext } from "./projectService.js";

// Define the state for our agent
const AgentState = Annotation.Root({
  messages: Annotation<any[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  analysisContext: Annotation<any>({
    reducer: (x, y) => ({ ...x, ...y }),
    default: () => ({ prs: [], commits: [], tickets: [] }),
  }),
  projectContext: Annotation<string>({
    reducer: (x, y) => y,
    default: () => "",
  }),
});

/**
 * Node: Retrieve context from the database using vector search
 */
async function retrieveNode(state: typeof AgentState.State) {
  const lastMessage = state.messages[state.messages.length - 1];
  const query = typeof lastMessage.content === 'string' ? lastMessage.content : '';
  
  logger.info(`Agent Node [Retrieve]: Searching for context for query: "${query.substring(0, 50)}..."`);
  
  const queryEmbedding = await generateEmbedding(query);
  const [prs, commits, tickets] = await Promise.all([
    searchSimilarPRs(queryEmbedding),
    searchSimilarCommits(queryEmbedding),
    searchSimilarTickets(queryEmbedding),
  ]);

  const projectContext = await getProjectContext();

  return { 
    analysisContext: { prs, commits, tickets },
    projectContext
  };
}

/**
 * Node: Analyze context and generate response
 */
async function analyzeNode(state: typeof AgentState.State) {
  logger.info("Agent Node [Analyze]: Generating analysis...");
  
  const model = new ChatGoogleGenerativeAI({
    model: env.GEMINI_MODEL,
    apiKey: env.GOOGLE_AI_API_KEY,
  });

  const { prs, commits, tickets } = (state as any).analysisContext;
  const projectContext = (state as any).projectContext;

  const contextStr = buildContextString(prs, commits, tickets, projectContext);
  
  const systemPrompt = `You are "CodeCompanion", a Senior Staff Architect. 
Use the provided Project Architecture and Knowledge Base results to answer the user.
Always compare multiple matched items if they exist. 
Derive the "best approach" by synthesizing past successes.

${contextStr}`;

  // We prepend the system prompt as a SystemMessage or similar if supported, 
  // or just as a lead-in to the model call.
  const response = await model.invoke([
    { role: "system", content: systemPrompt },
    ...state.messages
  ]);

  return { messages: [response] };
}

function buildContextString(prs: any[], commits: any[], tickets: any[], projectContext: string) {
    return `
${projectContext}

## Historical Context (from Knowledge Base):
PRs: ${prs.map(p => `PR #${p.prNumber}: ${p.title}`).join(', ') || 'None'}
Commits: ${commits.map(c => c.message).join(', ') || 'None'}
Tickets: ${tickets.map(t => `${t.ticketKey}: ${t.title}`).join(', ') || 'None'}
`;
}

/**
 * Initialize and return the LangGraph agent
 */
export function createAgent() {
  const workflow = new StateGraph(AgentState)
    .addNode("retrieve", retrieveNode)
    .addNode("analyze", analyzeNode)
    .addEdge("__start__", "retrieve")
    .addEdge("retrieve", "analyze")
    .addEdge("analyze", "__end__");

  return workflow.compile();
}

/**
 * Save messages to persistent history
 */
export async function saveToHistory(conversationId: string, role: 'user' | 'model', content: string) {
    try {
        await Conversation.findOneAndUpdate(
            { conversationId },
            { 
                $push: { 
                    messages: { 
                        role, 
                        content, 
                        timestamp: new Date() 
                    } 
                },
                $set: { lastActivityAt: new Date() }
            },
            { upsert: true }
        );
    } catch (error) {
        logger.error(`Failed to save to history for ${conversationId}:`, error);
    }
}

/**
 * Get conversation history by ID
 */
export async function getHistory(conversationId: string): Promise<IMessage[]> {
    const conversation = await Conversation.findOne({ conversationId });
    return conversation?.messages || [];
}
