import { Request, Response } from 'express';
import { z } from 'zod';
import { generateEmbedding } from '../services/embeddingService.js';
import { searchSimilarPRs, searchSimilarCommits, searchSimilarTickets } from '../services/analysisService.js';
import { logger } from '../utils/logger.js';
import { createAgent, saveToHistory, getHistory } from '../services/graphService.js';
import type { IAnalysisResult } from '../models/index.js';

const analyzeSchema = z.object({
    inputText: z.string().min(1, 'Input text is required'),
    inputType: z.enum(['error', 'stack_trace', 'jira_ticket', 'github_issue', 'description']),
    conversationId: z.string().optional(),
    messages: z.array(z.object({
        role: z.enum(['user', 'model']),
        parts: z.array(z.object({ text: z.string() }))
    })).optional().default([]),
});

/**
 * POST /api/analyze/stream
 * Stream analysis using Server-Sent Events (SSE)
 */
export async function analyzeStream(req: Request, res: Response) {
    try {
        const validatedBody = analyzeSchema.parse(req.body);
        const { inputText, inputType, messages } = validatedBody;

        logger.info(`Streaming analysis request: ${inputType}, History: ${messages.length}`);

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const yieldEvent = (event: string, data: any) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let prs: any[] = [], commits: any[] = [], tickets: any[] = [];

        // 1. Thinking Stage (Only if searching)
        // If it's a follow-up (messages > 0), we might skip search or search again based on query intent?
        // For simplicity, we only search on the FIRST turn or if explicitly requested.
        // But the user might ask about a new file.
        // Strategy: Always search if query > 10 chars? Or just search always for now to provide context.
        // Actually, searching every time adds context which is good.
        
        yieldEvent('stage', { stage: 'thinking', message: 'Understanding your query...' });

        // Generate embedding
        const queryEmbedding = await generateEmbedding(inputText);

        // 2. Searching Stage
        yieldEvent('stage', { stage: 'searching', message: 'Checking codebase...' });
        
        [prs, commits, tickets] = await Promise.all([
            searchSimilarPRs(queryEmbedding),
            searchSimilarCommits(queryEmbedding),
            searchSimilarTickets(queryEmbedding),
        ]);

        yieldEvent('stage', { 
            stage: 'searching', 
            message: `Found ${prs.length} PRs, ${commits.length} commits` 
        });

        // 3. Send Initial Matches (Partial Result)
        // We send this every time so the UI can update the tabs if new relevant stuff is found for the follow-up.
        const partialResult: Partial<IAnalysisResult> = {
            status: 'unknown',
            confidence: 0,
            summary: messages.length > 0 ? 'Follow-up analysis...' : 'Analysis in progress...',
            rootCause: '',
            explanation: '',
            relatedPRs: prs.map(pr => ({
                prNumber: pr.prNumber,
                title: pr.title,
                description: pr.description,
                author: pr.author,
                url: pr.prUrl,
                mergedAt: pr.mergedAt?.toISOString(),
                relevanceScore: pr.similarity,
                filesImpacted: pr.filesChanged?.map((f: any) => f.path) || [],
                filesChanged: pr.filesChanged || [],
                diffContent: pr.diffContent,
                labels: pr.labels || [],
                whyRelevant: pr.similarity > 0.6 ? 'High similarity match' : undefined
            })),
            relatedCommits: commits.map(c => ({
                sha: c.sha,
                message: c.message,
                author: c.author,
                url: c.commitUrl,
                committedAt: c.committedAt.toISOString(),
                filesChanged: c.filesChanged?.map((f: any) => f.path) || [],
            })),
            relatedTickets: tickets.map(t => ({
                key: t.ticketKey,
                title: t.title,
                status: t.status,
                priority: t.priority || 'medium',
                url: t.ticketUrl,
            })),
            filesImpacted: [],
        };

        yieldEvent('result', partialResult);

        // 4. Analyzing Stage
        yieldEvent('stage', { stage: 'analyzing', message: 'Generating response...' });

        // 5. Stream LLM Content using LangGraph Agent
        const agent = createAgent();
        const convoId = validatedBody.conversationId || `convo-${Date.now()}`;
        
        // Save user message to history
        await saveToHistory(convoId, 'user', inputText);
        
        // Fetch full history for better context
        const history = await getHistory(convoId);

        let fullResponse = '';
        const stream = await agent.stream({
            messages: history.map(m => ({ 
                role: m.role === 'model' ? 'assistant' : 'user', 
                content: m.content 
            }))
        });

        for await (const update of stream) {
            // LangGraph stream updates can be complex, we look for the last message in 'analyze' node
            if (update.analyze?.messages) {
                const lastMsg = update.analyze.messages[update.analyze.messages.length - 1];
                const text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
                // Since this is a simple implementation, we might need to delta the text or handle incremental properly
                // For now, if it's the final message, we yield it in chunks if possible, 
                // but usually LangGraph ChatGoogleGenerativeAI handles streaming internally if configured.
                // Here we'll just yield what we get.
                yieldEvent('content', { chunk: text });
                fullResponse = text;
            }
        }

        // Save AI response to history
        await saveToHistory(convoId, 'model', fullResponse);

        // 6. Complete
        yieldEvent('complete', {});
        res.end();

    } catch (error) {
        logger.error('Streaming analysis failed:', error);
        
        if (!res.headersSent) {
            res.status(500).json({ error: 'Analysis failed' });
        } else {
            // If headers already sent, send error event
             const msg = error instanceof Error ? error.message : String(error);
            res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
            res.end();
        }
    }
}
