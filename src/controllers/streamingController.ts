import { Request, Response } from 'express';
import { z } from 'zod';
import { generateEmbedding } from '../services/embeddingService.js';
import { searchSimilarPRs, searchSimilarCommits, searchSimilarTickets } from '../services/analysisService.js';
import { analyzeWithLLMStream } from '../services/llmService.js';
import { logger } from '../utils/logger.js';
import type { IAnalysisResult } from '../models/index.js';

const analyzeSchema = z.object({
    inputText: z.string().min(1, 'Input text is required'),
    inputType: z.enum(['error', 'stack_trace', 'jira_ticket', 'github_issue', 'description']),
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

        const sendEvent = (event: string, data: any) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let prs: any[] = [], commits: any[] = [], tickets: any[] = [];

        // 1. Thinking Stage (Only if searching)
        // If it's a follow-up (messages > 0), we might skip search or search again based on query intent?
        // For simplicity, we only search on the FIRST turn or if explicitly requested.
        // But the user might ask about a new file.
        // Strategy: Always search if query > 10 chars? Or just search always for now to provide context.
        // Actually, searching every time adds context which is good.
        
        sendEvent('stage', { stage: 'thinking', message: 'Understanding your query...' });

        // Generate embedding
        const queryEmbedding = await generateEmbedding(inputText);

        // 2. Searching Stage
        sendEvent('stage', { stage: 'searching', message: 'Checking codebase...' });
        
        [prs, commits, tickets] = await Promise.all([
            searchSimilarPRs(queryEmbedding),
            searchSimilarCommits(queryEmbedding),
            searchSimilarTickets(queryEmbedding),
        ]);

        sendEvent('stage', { 
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
                author: pr.author,
                url: pr.prUrl,
                mergedAt: pr.mergedAt?.toISOString(),
                relevanceScore: pr.similarity,
                filesImpacted: pr.filesChanged?.map((f: any) => f.path) || [],
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

        sendEvent('result', partialResult);

        // 4. Analyzing Stage
        sendEvent('stage', { stage: 'analyzing', message: 'Generating response...' });

        // 5. Stream LLM Content
        // We cast messages key slightly if needed, but the structure matches
        const stream = analyzeWithLLMStream(inputText, inputType, prs, commits, tickets, messages as any);

        for await (const chunk of stream) {
            sendEvent('content', { chunk });
        }

        // 6. Complete
        sendEvent('complete', {});
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
