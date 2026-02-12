import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { IAnalysisResult, InputType } from '../models/index.js';
import { getProjectContext } from './projectService.js';

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
    if (!genAI) {
        if (!env.GOOGLE_AI_API_KEY) {
            throw new Error('GOOGLE_AI_API_KEY is not configured');
        }
        genAI = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY);
    }
    return genAI;
}

export interface MatchedPR {
    prNumber: number;
    title: string;
    description?: string;
    author: string;
    prUrl: string;
    mergedAt?: Date;
    filesChanged: Array<{ 
        path: string;
        additions?: number;
        deletions?: number;
        status?: 'modified' | 'added' | 'deleted';
    }>;
    similarity: number;
    diffContent?: string;
    labels?: string[];
}

export interface MatchedCommit {
    sha: string;
    message: string;
    author: string;
    commitUrl: string;
    committedAt: Date;
    filesChanged: Array<{ path: string }>;
    similarity: number;
}

export interface MatchedTicket {
    ticketKey: string;
    title: string;
    status: string;
    priority?: string;
    ticketUrl: string;
    similarity: number;
}

/**
 * Analyze error/bug report using LLM with RAG context
 */
export async function analyzeWithLLM(
    inputText: string,
    inputType: InputType,
    matchedPRs: MatchedPR[],
    matchedCommits: MatchedCommit[],
    matchedTickets: MatchedTicket[]
): Promise<IAnalysisResult> {
    logger.info('Analyzing with LLM...');
    logger.debug(`Matched PRs: ${matchedPRs.length}, Commits: ${matchedCommits.length}, Tickets: ${matchedTickets.length}`);

    const projectContext = await getProjectContext();
    const context = buildContext(matchedPRs, matchedCommits, matchedTickets, projectContext);
    const systemPrompt = getSystemPrompt();
    const userPrompt = getUserPrompt(inputText, inputType, context);

    try {
        const ai = getGenAI();
        const model = ai.getGenerativeModel({
            model: env.GEMINI_MODEL,
            generationConfig: {
                responseMimeType: 'application/json',
            },
        });

        const result = await model.generateContent([
            { text: systemPrompt },
            { text: userPrompt },
        ]);

        const responseText = result.response.text();
        logger.debug('LLM response received, parsing...');

        try {
            return JSON.parse(responseText) as IAnalysisResult;
        } catch (parseError) {
            logger.warn('Failed to parse LLM response as JSON, attempting extraction');
            // Try to extract JSON from markdown code blocks
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1].trim()) as IAnalysisResult;
            }
            throw parseError;
        }
    } catch (error) {
        logger.error('LLM analysis failed:', error);
        return buildFallbackAnalysis(matchedPRs, matchedCommits, matchedTickets);
    }
}

export interface ChatMessage {
    role: 'user' | 'model';
    parts: { text: string }[];
}

/**
 * Analyze error/bug report using LLM with streaming response
 */
export async function* analyzeWithLLMStream(
    inputText: string,
    inputType: InputType,
    matchedPRs: MatchedPR[],
    matchedCommits: MatchedCommit[],
    matchedTickets: MatchedTicket[],
    history: ChatMessage[] = []
): AsyncGenerator<string, void, unknown> {
    logger.info('Analyzing with LLM (streaming)...');
    
    // For the first turn, we include context. For subsequent turns, we rely on history.
    const isFirstTurn = history.length === 0;
    
    let systemInstruction = getStreamingSystemPrompt();
    let userContent = inputText;

    if (isFirstTurn) {
        const projectContext = await getProjectContext();
        const context = buildContext(matchedPRs, matchedCommits, matchedTickets, projectContext);
        userContent = getUserPrompt(inputText, inputType, context);
    } else {
        // For follow-ups, we don't re-inject the massive context, assuming it's in history
        // But we might want to remind the model of the "Role" if it drifts, though history usually keeps it.
        // We just pass the user input as is.
        userContent = inputText;
    }

    try {
        const ai = getGenAI();
        const model = ai.getGenerativeModel({
            model: env.GEMINI_MODEL,
        });

        // Construct history for startChat
        const chatHistory = history.map(h => ({
            role: h.role,
            parts: h.parts
        }));

        // If it's the first turn, we prepend the System Prompt to the first message or use a special trick.
        // gemini-pro (v1) doesn't support systemInstruction param well in all versions.
        // We'll emulate it by prepending to the first user message or history.
        
        let chat;
        if (isFirstTurn) {
             chat = model.startChat({
                history: [], // No history yet
            });
            // Result will be generated from sendMessage which includes system prompt + user prompt
            userContent = `${systemInstruction}\n\n${userContent}`;
        } else {
            // We need to inject system prompt if it's not in history? 
            // Actually, if we pass `history` to startChat, the model should remember from previous turns.
            // But we are stateless between requests in this endpoint implementation?
            // Yes, we receive 'history' array from frontend.
            
            // We need to ensure the FIRST message in history has the system prompt if we want persistence.
            // Or we just rely on the model seeing the previous turn's context.
            
            // Note: The history passed from frontend likely doesn't have the System Prompt text we injected invisibly.
            // Implementation: We will just startChat with the history as provided.
            chat = model.startChat({
                history: chatHistory,
            });
        }

        const result = await chat.sendMessageStream(userContent);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
                yield chunkText;
            }
        }
    } catch (error: any) {
        logger.error('LLM streaming analysis failed:', error);
        yield `\n\n**Analysis Error**: I encountered an issue while generating the analysis. \n\nDebug Details: \`${error.message || String(error)}\``;
    }
}

function buildContext(
    matchedPRs: MatchedPR[],
    matchedCommits: MatchedCommit[],
    matchedTickets: MatchedTicket[],
    projectContext: string = ''
): string {
    const prContext = matchedPRs.length > 0
        ? matchedPRs.map(pr => {
            let prInfo = `
- PR #${pr.prNumber}: ${pr.title} (similarity: ${(pr.similarity * 100).toFixed(1)}%)
  Author: ${pr.author}
  URL: ${pr.prUrl}
  Merged: ${pr.mergedAt || 'Not merged'}
  Files: ${pr.filesChanged?.map(f => f.path).join(', ') || 'N/A'}
  Description: ${pr.description || 'No description'}`;
            
            // Include diff excerpt for top matches (first 3 PRs with diff content)
            if (pr.diffContent && pr.similarity >= 0.4) {
                const diffExcerpt = pr.diffContent.slice(0, 2000);
                const truncated = pr.diffContent.length > 2000 ? '\n  ... (diff truncated)' : '';
                prInfo += `\n  Diff:\n\`\`\`diff\n${diffExcerpt}${truncated}\n\`\`\``;
            }
            return prInfo;
        }).join('\n')
        : 'No matching PRs found';

    const commitContext = matchedCommits.length > 0
        ? matchedCommits.map(c => `
- ${c.sha.substring(0, 7)}: ${c.message} (similarity: ${(c.similarity * 100).toFixed(1)}%)
  Author: ${c.author}
  URL: ${c.commitUrl}
  Files: ${c.filesChanged?.map(f => f.path).join(', ') || 'N/A'}`).join('\n')
        : 'No matching commits found';

    const ticketContext = matchedTickets.length > 0
        ? matchedTickets.map(t => `
- ${t.ticketKey}: ${t.title} (similarity: ${(t.similarity * 100).toFixed(1)}%)
  Status: ${t.status}
  Priority: ${t.priority || 'Unknown'}
  URL: ${t.ticketUrl}`).join('\n')
        : 'No matching tickets found';

    return `
${projectContext}

# >>> DYNAMIC KNOWLEDGE BASE SEARCH RESULTS <<<
# These items were retrieved using semantic vector search from your developer database.
# Use these to COMPARE and DERIVE the best implementation path.

## Matched Pull Requests:
${prContext}
 
## Matched Commits:
${commitContext}
 
## Related Jira Tickets:
${ticketContext}
# >>> END OF KNOWLEDGE BASE CONTEXT <<<
`;
}

function getSystemPrompt(): string {
    return `You are a friendly and helpful senior software engineer named "CodeCompanion". You're analyzing bug reports and errors for a developer. Based on the user's input and the semantically matched code changes from the repository, provide a comprehensive analysis.

## Agentic Intelligence Core:
- You have direct read access to a **Dynamic Knowledge Base** of historical Pull Requests, Commits, and Jira tickets for this repository.
- **Comparative Analysis**: Always compare multiple matched items if they exist. If PR #1 and PR #2 both touch similar logic, identify which one is a "refactor" vs a "bug fix" and which pattern is more applicable now.
- **Retrieve the Best Approach**: Your goal is not just to find similar code, but to derive the *best* technical approach by synthesizing patterns from the most successful past changes.
- **Agentic Grounding**: Use phrases like "I've queried the database and found..." or "Comparing these three historical fixes, I recommend..." to show you are actively using the repository's history as your source of truth.

## Your Personality:
- You are a Senior Staff Engineer / Architect named "CodeCompanion".
- You are highly technical, precise, and authoritative yet helpful.
- Speak directly to the developer, using "I" for your analysis and "you" for their actions.

## Analysis Guidelines:
1. **Synthesize Git Diffs**: When diff content is provided, perform a deep dive into the code:
   - Compare the "before" and "after" patterns across all matched PRs.
   - Identify the "Golden Path" — the cleanest, most robust way this problem has been solved before.
   - Note any technical debt or pitfalls mentioned in PR descriptions that were avoided.

2. **Comparative Root Cause**: Explain the technical root cause by triangulating:
   - The current error/report.
   - How similar logic failed in the past (based on matched items).
   - Why the proposed fix is superior to other potential approaches.

3. **High-Fidelity Fixes**: Provide code snippets in the fixSuggestion field that are production-ready, following the best patterns found in the "Golden Path".
4. **Contextual Relevance**: For every matched item, explain exactly how it "connects" to the current issue and what specific lesson was learned from it.

Your response MUST be valid JSON with this exact structure:
{
  "status": "fixed" | "not_fixed" | "partially_fixed" | "unknown",
  "confidence": 0.0-1.0,
  "summary": "Brief one-sentence summary",
  "rootCause": "Technical explanation of the root cause, referencing specific code patterns from diffs if available",
  "explanation": "Detailed explanation in simple terms for junior developers",
  "conversationalResponse": "A friendly, conversational response written in Markdown that speaks directly to the user like ChatGPT would. Start with a greeting or acknowledgment of their issue. Explain what you found in a natural, helpful way. Reference specific PRs by number if relevant (e.g., 'I found that PR #123 addressed a similar issue...'). Provide clear next steps. Use formatting like **bold**, bullet points, and code blocks where helpful. End with an encouraging note or offer to help further. This should be 2-4 paragraphs, warm and human-like.",
  "diffAnalysis": "Analysis of what the matched PRs changed and WHY those changes fixed the issue. If diffs are provided, explain the specific code changes.",
  "bestPractices": ["List of coding best practices demonstrated in the matched PRs that help prevent this type of issue"],
  "relatedPRs": [
    {
      "prNumber": number,
      "title": "string",
      "author": "string",
      "url": "string",
      "mergedAt": "ISO date or null",
      "relevanceScore": 0.0-1.0,
      "filesImpacted": ["file paths"],
      "whyRelevant": "Brief explanation of why this PR is relevant to the issue"
    }
  ],
  "relatedCommits": [
    {
      "sha": "string",
      "message": "string",
      "author": "string",
      "url": "string",
      "committedAt": "ISO date",
      "filesChanged": ["file paths"]
    }
  ],
  "relatedTickets": [
    {
      "key": "string",
      "title": "string",
      "status": "string",
      "priority": "string",
      "url": "string"
    }
  ],
  "filesImpacted": [
    {
      "path": "string",
      "module": "string",
      "changeType": "modified" | "added" | "deleted",
      "linesChanged": number
    }
  ],
  "fixSuggestion": {
    "title": "string",
    "description": "string",
    "steps": ["step 1", "step 2", ...],
    "codeExample": "optional code snippet showing the recommended fix pattern"
  } | null
}

IMPORTANT: The "conversationalResponse" field is what the user will read first. Make it:
- Personal and friendly (use "I found...", "Based on my analysis...", "Here's what I think...")
- Reference specific PRs by number when relevant
- Include practical next steps they can take
- Use Markdown formatting for readability
- Feel like a chat with a helpful colleague, not a report
- **Respct User Quantity**: If the user asked for a specific number of items (e.g. "top 10 PRs"), try to list or mention that many if available.

If no matching PRs/commits exist, acknowledge this honestly in the conversational response and still try to help based on the error description. Always include diffAnalysis and bestPractices fields.`;
}

function getStreamingSystemPrompt(): string {
    return `You are a helpful and knowledgeable AI coding assistant. Your goal is to help the user understand and fix their software issue by analyzing similar past issues and pull requests.

## Your Personality:
- Professional, encouraging, and clear.
- Feel like an expert pair programmer.
- Use Markdown formatting for readability.

## Your Task:
1. **Query & Analyze**: Synthesize the repository context (PRs, commits, tickets) to find the most relevant historical fixes.
2. **Compare Patterns**: If there are multiple matches, compare their approaches and identify the most robust one.
3. **Explain the Architecture**: Focus on the *why* and the *how*. Reference specific PRs (e.g., "PR #123") as evidence for your recommendation.
4. **Prescribe a Fix**: Suggest a definitive implementation path based on the "best approach" retrieved from the data.

Please format your response in clear sections using Markdown:
- **Executive Summary**: A concise overview of the issue and your findings from the knowledge base.
- **Comparative Analysis**: How different past changes relate to this issue, and why one approach might be better than another.
- **Recommended Implementation**: A definitive, step-by-step guide with code blocks.
- **Evidence & Context**: Deep dive into the matched PRs/commits that informed your decision.

Do NOT output JSON. Output natural language Markdown. Always include code blocks for fix suggestions.`;
}

function getUserPrompt(inputText: string, inputType: InputType, context: string): string {
    return `## User Input (${inputType}):
${inputText}

## Repository Context:
${context}

Analyze the user input against the repository context. If multiple PRs or commits are found, compare their technical approaches. Derive and recommend the most robust "best approach" for the current issue.

Provide your response as valid JSON.`;
}

function buildFallbackAnalysis(
    matchedPRs: MatchedPR[],
    matchedCommits: MatchedCommit[],
    matchedTickets: MatchedTicket[]
): IAnalysisResult {
    const hasSomeMatches = matchedPRs.length > 0 || matchedCommits.length > 0;
    
    let conversationalResponse = `Hey there! 👋 

I looked through the codebase for anything related to your issue, but I wasn't able to find a definitive match. `;
    
    if (hasSomeMatches) {
        conversationalResponse += `I did find ${matchedPRs.length} potentially related PRs and ${matchedCommits.length} commits that might give you some clues.

**What I suggest:**
- Take a look at the related PRs I've listed below - they might have patterns that help
- Check recent commits in the modules where you're seeing this issue
- Try adding some debug logging to narrow down where things are going wrong

I know it's frustrating when you can't find a clear answer, but you've got this! Let me know if you'd like me to dig deeper into any specific area. 💪`;
    } else {
        conversationalResponse += `This could mean:
- The issue is new and hasn't been addressed in any previous PRs
- The relevant code changes haven't been synced yet
- The issue might be in a different area than where I searched

**Here's what you can try:**
1. Make sure your repository is fully synced with recent PRs
2. Search the codebase manually for similar error patterns
3. Add some debug logging to help pinpoint the issue

Don't give up! Sometimes bugs just need a fresh set of eyes. Let me know if you'd like to try a different search approach. 🔍`;
    }

    return {
        status: 'unknown',
        confidence: 0.3,
        summary: 'Unable to determine if this issue has been fixed.',
        rootCause: 'Analysis inconclusive. The error pattern could not be matched to existing code changes.',
        explanation: 'We analyzed the error but could not find definitive matches in the codebase. This could mean the issue is new or the relevant code changes are not yet indexed.',
        conversationalResponse,
        relatedPRs: matchedPRs.map(pr => ({
            prNumber: pr.prNumber,
            title: pr.title,
            description: pr.description,
            author: pr.author,
            url: pr.prUrl,
            mergedAt: pr.mergedAt?.toISOString(),
            relevanceScore: pr.similarity,
            filesImpacted: pr.filesChanged?.map(f => f.path) || [],
            filesChanged: pr.filesChanged || [],
            diffContent: pr.diffContent,
            labels: pr.labels,
        })),
        relatedCommits: matchedCommits.map(c => ({
            sha: c.sha,
            message: c.message,
            author: c.author,
            url: c.commitUrl,
            committedAt: c.committedAt.toISOString(),
            filesChanged: c.filesChanged?.map(f => f.path) || [],
        })),
        relatedTickets: matchedTickets.map(t => ({
            key: t.ticketKey,
            title: t.title,
            status: t.status,
            priority: t.priority || 'medium',
            url: t.ticketUrl,
        })),
        filesImpacted: [],
        diffAnalysis: 'No matching diffs available for analysis. The issue may be new or not yet addressed in the codebase.',
        bestPractices: [
            'Add comprehensive error handling',
            'Implement proper input validation',
            'Use defensive coding practices',
            'Add logging for debugging purposes',
        ],
        fixSuggestion: {
            title: 'Investigate Further',
            description: 'This issue requires manual investigation as no definitive matches were found.',
            steps: [
                'Search the codebase for similar error patterns',
                'Check recent commits in related modules',
                'Review open issues and PRs for similar reports',
                'Add logging to narrow down the issue location',
            ],
            codeExample: undefined,
        },
    };
}

/**
 * Generate suggested code changes based on PR diff content
 */
export async function generateChangeSuggestions(
    issueDescription: string,
    diffContent: string,
    prTitle: string
): Promise<string> {
    logger.info('Generating change suggestions from PR diff...');
    
    const prompt = `You are a senior software engineer helping a developer understand how to apply changes from a merged PR to fix their issue.

## User's Issue:
${issueDescription}

## PR Title: ${prTitle}

## PR Diff Content:
\`\`\`diff
${diffContent.slice(0, 10000)} ${diffContent.length > 10000 ? '\n... (truncated)' : ''}
\`\`\`

Based on the PR diff above, provide specific, actionable suggestions for how the user can apply similar changes to fix their issue. Focus on:
1. The key files that were modified
2. The specific code patterns that were changed
3. Step-by-step instructions they can follow
4. Any configuration changes needed

Be concise but thorough. Format your response in markdown.`;

    try {
        const ai = getGenAI();
        const model = ai.getGenerativeModel({
            model: env.GEMINI_MODEL,
        });

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        logger.error('Failed to generate change suggestions:', error);
        return 'Unable to generate specific suggestions. Please review the PR directly for implementation details.';
    }
}

/**
 * Generate implementation steps based on PR description
 */
export async function generateImplementationSteps(
    issueDescription: string,
    prDescription: string,
    prTitle: string
): Promise<string> {
    logger.info('Generating implementation steps from PR description...');
    
    const prompt = `You are a senior software engineer helping a developer understand how to implement changes to fix their issue based on a similar PR that was already merged.

## User's Issue:
${issueDescription}

## Similar PR Title: ${prTitle}

## PR Description:
${prDescription.slice(0, 5000)}${prDescription.length > 5000 ? '\n... (truncated)' : ''}

Based on the PR description above, provide specific, actionable implementation steps for how the user can fix their issue. Include:

1. **What files to modify** - List the likely files that need changes
2. **Key changes to make** - Describe the code modifications needed
3. **Step-by-step implementation** - Clear numbered steps to follow
4. **Testing recommendations** - How to verify the fix works

Be concise and practical. Format your response in markdown with clear sections.`;

    try {
        const ai = getGenAI();
        const model = ai.getGenerativeModel({
            model: env.GEMINI_MODEL,
        });

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        logger.error('Failed to generate implementation steps:', error);
        return 'Unable to generate implementation steps. Please review the PR description directly for guidance.';
    }
}
