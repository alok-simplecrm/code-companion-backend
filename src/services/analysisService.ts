import { GitHubPR, GitHubCommit, JiraTicket, AnalysisQuery, type InputType, type IAnalysisResult } from '../models/index.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';
import { analyzeWithLLM } from './llmService.js';
import { logger } from '../utils/logger.js';

export interface DataAvailability {
    hasData: boolean;
    prCount: number;
    commitCount: number;
    ticketCount: number;
    message: string;
}

/**
 * Check if there's any data available for analysis
 */
export async function checkDataAvailability(): Promise<DataAvailability> {
    const [prCount, commitCount, ticketCount] = await Promise.all([
        GitHubPR.countDocuments({ embedding: { $exists: true, $ne: [] } }),
        GitHubCommit.countDocuments({ embedding: { $exists: true, $ne: [] } }),
        JiraTicket.countDocuments({ embedding: { $exists: true, $ne: [] } }),
    ]);

    const hasData = prCount > 0 || commitCount > 0 || ticketCount > 0;
    
    let message = '';
    if (!hasData) {
        message = 'No data has been synced yet. Please sync a GitHub repository first to enable AI-powered analysis. Go to Settings > Repositories to add and sync your first repository.';
    } else {
        message = `Ready for analysis. Database contains ${prCount} PRs, ${commitCount} commits, and ${ticketCount} tickets.`;
    }

    return {
        hasData,
        prCount,
        commitCount,
        ticketCount,
        message,
    };
}

export interface AnalysisRequest {
    inputText: string;
    inputType: InputType;
}

/**
 * Main RAG analysis service
 * 1. Generate embedding for input
 * 2. Search similar PRs, commits, and tickets
 * 3. Use LLM to analyze with context
 * 4. Cache the result
 */
export async function analyzeError(request: AnalysisRequest): Promise<IAnalysisResult> {
    const { inputText, inputType } = request;

    logger.info(`Starting analysis for input type: ${inputType}`);

    // Step 1: Generate embedding for the input query
    const queryEmbedding = await generateEmbedding(inputText);
    logger.debug(`Generated query embedding with ${queryEmbedding.length} dimensions`);

    // Detect if user requested a specific number of items
    const match = inputText.match(/(\d+)\s*(?:prs?|pull requests?|commits?|items?|results?)/i);
    let limit = 10; // Default limit
    if (match) {
        const requestedLimit = parseInt(match[1]);
        if (requestedLimit > 0 && requestedLimit <= 50) { // Cap at 50 to prevent overload
            limit = requestedLimit;
            logger.info(`User requested ${limit} items`);
        }
    }

    // Step 2: Search for similar items in parallel
    const [prs, commits, tickets] = await Promise.all([
        searchSimilarPRs(queryEmbedding, 0.3, limit),
        searchSimilarCommits(queryEmbedding, 0.3, limit),
        searchSimilarTickets(queryEmbedding, 0.3, Math.min(limit, 10)), // Keep tickets lower
    ]);

    logger.info(`Found ${prs.length} PRs, ${commits.length} commits, ${tickets.length} tickets`);

    // Step 3: Analyze with LLM
    const analysis = await analyzeWithLLM(
        inputText,
        inputType,
        prs,
        commits,
        tickets
    );

    // Step 4: Cache the result
    try {
        await AnalysisQuery.create({
            inputText,
            inputType,
            embedding: queryEmbedding,
            result: analysis,
        });
        logger.debug('Analysis result cached');
    } catch (error) {
        logger.warn('Failed to cache analysis result:', error);
    }

    return analysis;
}

export async function searchSimilarPRs(queryEmbedding: number[], threshold = 0.3, limit = 10) {
    const prs = await GitHubPR.find({ embedding: { $exists: true, $ne: [] } })
        .select('prNumber title description author prUrl mergedAt filesChanged diffContent embedding')
        .lean();

    return prs
        .map(pr => ({
            ...pr,
            similarity: cosineSimilarity(queryEmbedding, pr.embedding),
        }))
        .filter(pr => pr.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

export async function searchSimilarCommits(queryEmbedding: number[], threshold = 0.3, limit = 10) {
    const commits = await GitHubCommit.find({ embedding: { $exists: true, $ne: [] } })
        .select('sha message author commitUrl committedAt filesChanged embedding')
        .lean();

    return commits
        .map(commit => ({
            ...commit,
            similarity: cosineSimilarity(queryEmbedding, commit.embedding),
        }))
        .filter(commit => commit.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

export async function searchSimilarTickets(queryEmbedding: number[], threshold = 0.3, limit = 5) {
    const tickets = await JiraTicket.find({ embedding: { $exists: true, $ne: [] } })
        .select('ticketKey title status priority ticketUrl embedding')
        .lean();

    return tickets
        .map(ticket => ({
            ...ticket,
            similarity: cosineSimilarity(queryEmbedding, ticket.embedding),
        }))
        .filter(ticket => ticket.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Get recent analysis queries for analytics
 */
export async function getRecentAnalyses(limit = 20) {
    return AnalysisQuery.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('inputType result.status result.confidence createdAt')
        .lean();
}
