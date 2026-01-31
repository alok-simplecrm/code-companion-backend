import { GitHubPR, GitHubCommit, JiraTicket, AnalysisQuery, type InputType, type IAnalysisResult } from '../models/index.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';
import { analyzeWithLLM } from './llmService.js';
import { logger } from '../utils/logger.js';

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

    // Step 2: Search for similar items in parallel
    const [prs, commits, tickets] = await Promise.all([
        searchSimilarPRs(queryEmbedding),
        searchSimilarCommits(queryEmbedding),
        searchSimilarTickets(queryEmbedding),
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
