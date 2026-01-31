import { v4 as uuidv4 } from 'uuid';
import { Issue, GitHubPR, type IIssue, type IMatchedPR, type InputType, type IAnalysisResult } from '../models/index.js';
import { generateEmbedding, cosineSimilarity } from './embeddingService.js';
import { analyzeWithLLM, generateChangeSuggestions, generateImplementationSteps } from './llmService.js';
import { isRepoAllowed, env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { searchPRsByKeywords, extractKeywords, type GitHubPRFromAPI } from './githubService.js';

export interface SubmitIssueRequest {
    title: string;
    description: string;
    inputType: InputType;
    userId?: string;
    email?: string;
}

export interface IssueResponse {
    issueId: string;
    status: IIssue['status'];
    title: string;
    matchedPRs: Array<{
        prNumber: number;
        prUrl: string;
        title: string;
        description: string;
        confidence: number;
        isFixing: boolean;
        suggestedChanges?: string;
        implementationSteps?: string;
    }>;
    analysisResult?: IAnalysisResult;
    message: string;
    createdAt: Date;
}

/**
 * Submit a new issue for analysis
 */
export async function submitIssue(request: SubmitIssueRequest): Promise<IssueResponse> {
    const { title, description, inputType, userId, email } = request;
    
    logger.info(`Submitting new issue: ${title}`);
    
    // Create issue with pending status
    const issueId = uuidv4();
    const issue = await Issue.create({
        issueId,
        userId,
        email,
        title,
        description,
        inputType,
        status: 'pending',
    });
    
    // Analyze asynchronously (don't await)
    analyzeIssueAsync(issue._id.toString()).catch(err => {
        logger.error(`Background analysis failed for issue ${issueId}:`, err);
    });
    
    return {
        issueId,
        status: 'pending',
        title,
        matchedPRs: [],
        message: 'Issue submitted successfully. Analysis is in progress.',
        createdAt: issue.createdAt,
    };
}

/**
 * Analyze an issue asynchronously
 */
async function analyzeIssueAsync(issueObjectId: string): Promise<void> {
    const issue = await Issue.findById(issueObjectId);
    if (!issue) {
        logger.error(`Issue ${issueObjectId} not found for analysis`);
        return;
    }
    
    try {
        // Update status to analyzing
        issue.status = 'analyzing';
        await issue.save();
        
        logger.info(`Analyzing issue: ${issue.issueId}`);
        
        // Generate embedding for the issue
        const searchText = `${issue.title}\n${issue.description}`;
        const embedding = await generateEmbedding(searchText);
        issue.embedding = embedding;
        
        // Search for similar PRs from local database (allowed repos only)
        const localMatchedPRs = await searchSimilarPRs(embedding);
        
        logger.info(`Found ${localMatchedPRs.length} local matching PRs for issue ${issue.issueId}`);
        
        // Also search GitHub API for PRs using keywords
        const keywords = extractKeywords(searchText);
        let githubPRs: GitHubPRFromAPI[] = [];
        
        try {
            githubPRs = await searchPRsByKeywords(
                env.TARGET_REPO_OWNER,
                env.TARGET_REPO_NAME,
                keywords
            );
            logger.info(`Found ${githubPRs.length} GitHub API matching PRs for issue ${issue.issueId}`);
        } catch (err) {
            logger.warn('GitHub API search failed, continuing with local results only:', err);
        }
        
        // Convert GitHub API PRs to the format expected by LLM analysis
        const githubPRsFormatted = githubPRs.map((pr, index) => ({
            prNumber: pr.number,
            title: pr.title,
            description: pr.body || '',
            author: pr.user?.login || 'unknown',
            prUrl: pr.html_url,
            mergedAt: pr.merged_at ? new Date(pr.merged_at) : undefined,
            filesChanged: [] as Array<{ path: string }>,
            similarity: 0.8 - (index * 0.05), // Assign decreasing similarity scores
        }));
        
        // Combine local and GitHub PRs (deduplicate by prNumber)
        const seenPRNumbers = new Set<number>();
        const allMatchedPRs = [...localMatchedPRs, ...githubPRsFormatted].filter(pr => {
            if (seenPRNumbers.has(pr.prNumber)) return false;
            seenPRNumbers.add(pr.prNumber);
            return true;
        }).sort((a, b) => b.similarity - a.similarity).slice(0, 10);
        
        logger.info(`Combined ${allMatchedPRs.length} unique PRs for analysis`);
        
        // Analyze with LLM
        const analysis = await analyzeWithLLM(
            searchText,
            issue.inputType,
            allMatchedPRs.map(pr => ({
                prNumber: pr.prNumber,
                title: pr.title,
                description: pr.description,
                author: pr.author,
                prUrl: pr.prUrl,
                mergedAt: pr.mergedAt,
                filesChanged: pr.filesChanged || [],
                similarity: pr.similarity,
            })),
            [], // commits - can add if needed
            []  // tickets - can add if needed
        );
        
        // Generate suggested changes and implementation steps for top matches
        const matchedPRsWithSuggestions: IMatchedPR[] = [];
        for (const pr of allMatchedPRs.slice(0, 5)) {
            let suggestedChanges: string | undefined;
            let implementationSteps: string | undefined;
            
            // Generate implementation steps using LLM
            if (pr.similarity >= 0.4) {
                try {
                    const prDescription = pr.description || 'No description provided';
                    implementationSteps = await generateImplementationSteps(
                        issue.description,
                        prDescription,
                        pr.title
                    );
                } catch (err) {
                    logger.warn(`Failed to generate implementation steps for PR #${pr.prNumber}:`, err);
                }
            }
            
            // Generate suggested changes from diff if available (local PRs only)
            const localPR = localMatchedPRs.find(lpr => lpr.prNumber === pr.prNumber);
            if (localPR?.diffContent && pr.similarity >= 0.5) {
                try {
                    suggestedChanges = await generateChangeSuggestions(
                        issue.description,
                        localPR.diffContent,
                        pr.title
                    );
                } catch (err) {
                    logger.warn(`Failed to generate suggestions for PR #${pr.prNumber}:`, err);
                }
            }
            
            matchedPRsWithSuggestions.push({
                prId: localPR?._id || null,
                prNumber: pr.prNumber,
                prUrl: pr.prUrl,
                title: pr.title,
                description: pr.description || '',
                confidence: pr.similarity,
                isFixing: analysis.status === 'fixed' && pr.similarity >= 0.6,
                suggestedChanges,
                implementationSteps,
            });
        }
        
        // Update issue with results
        issue.matchedPRs = matchedPRsWithSuggestions;
        issue.analysisResult = analysis;
        issue.status = analysis.status === 'fixed' ? 'resolved' : 
                       analysis.status === 'not_fixed' ? 'unresolved' : 
                       'needs_attention';
        
        if (issue.status === 'resolved') {
            issue.resolvedAt = new Date();
        }
        
        await issue.save();
        
        logger.info(`Issue ${issue.issueId} analysis complete. Status: ${issue.status}`);
        
    } catch (error) {
        logger.error(`Error analyzing issue ${issue.issueId}:`, error);
        issue.status = 'needs_attention';
        await issue.save();
    }
}

/**
 * Search for similar PRs from allowed repositories
 */
async function searchSimilarPRs(
    queryEmbedding: number[], 
    threshold = 0.3, 
    limit = 10
): Promise<Array<{
    _id: any;
    prNumber: number;
    title: string;
    description?: string;
    author: string;
    prUrl: string;
    mergedAt?: Date;
    filesChanged: Array<{ path: string }>;
    diffContent?: string;
    repoUrl: string;
    similarity: number;
}>> {
    const prs = await GitHubPR.find({ 
        embedding: { $exists: true, $ne: [] },
        state: 'merged', // Only consider merged PRs
    })
        .select('prNumber title description author prUrl mergedAt filesChanged diffContent repoUrl embedding')
        .lean();
    
    return prs
        .filter(pr => isRepoAllowed(pr.repoUrl)) // Filter by allowed repos
        .map(pr => ({
            ...pr,
            similarity: cosineSimilarity(queryEmbedding, pr.embedding),
        }))
        .filter(pr => pr.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Get issue by ID
 */
export async function getIssueById(issueId: string): Promise<IssueResponse | null> {
    const issue = await Issue.findOne({ issueId }).lean();
    if (!issue) {
        return null;
    }
    
    return formatIssueResponse(issue);
}

/**
 * Get issues for a user
 */
export async function getUserIssues(
    userId: string, 
    options: { limit?: number; offset?: number; status?: IIssue['status'] } = {}
): Promise<{ issues: IssueResponse[]; total: number }> {
    const { limit = 20, offset = 0, status } = options;
    
    const filter: Record<string, any> = { userId };
    if (status) {
        filter.status = status;
    }
    
    const [issues, total] = await Promise.all([
        Issue.find(filter)
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit)
            .lean(),
        Issue.countDocuments(filter),
    ]);
    
    return {
        issues: issues.map(formatIssueResponse),
        total,
    };
}

/**
 * Get all issues (paginated)
 */
export async function getAllIssues(
    options: { limit?: number; offset?: number; status?: IIssue['status'] } = {}
): Promise<{ issues: IssueResponse[]; total: number }> {
    const { limit = 20, offset = 0, status } = options;
    
    const filter: Record<string, any> = {};
    if (status) {
        filter.status = status;
    }
    
    const [issues, total] = await Promise.all([
        Issue.find(filter)
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit)
            .lean(),
        Issue.countDocuments(filter),
    ]);
    
    return {
        issues: issues.map(formatIssueResponse),
        total,
    };
}

/**
 * Format issue for API response
 */
function formatIssueResponse(issue: any): IssueResponse {
    const isResolved = issue.status === 'resolved';
    const hasMatches = issue.matchedPRs && issue.matchedPRs.length > 0;
    
    let message: string;
    if (issue.status === 'pending') {
        message = 'Your issue is pending analysis.';
    } else if (issue.status === 'analyzing') {
        message = 'Your issue is currently being analyzed.';
    } else if (isResolved && hasMatches) {
        const fixingPR = issue.matchedPRs.find((pr: IMatchedPR) => pr.isFixing);
        message = fixingPR 
            ? `Great news! This issue appears to be fixed in PR #${fixingPR.prNumber}. Check the implementation steps below.`
            : 'This issue has been resolved. See related PRs for details.';
    } else if (issue.status === 'unresolved') {
        message = hasMatches 
            ? 'We found similar PRs. Review the implementation steps for guidance on how to fix your issue.'
            : 'No matching fixes found. Consider opening a new issue on the repository.';
    } else {
        message = 'This issue needs manual review.';
    }
    
    return {
        issueId: issue.issueId,
        status: issue.status,
        title: issue.title,
        matchedPRs: (issue.matchedPRs || []).map((pr: IMatchedPR) => ({
            prNumber: pr.prNumber,
            prUrl: pr.prUrl,
            title: pr.title,
            description: pr.description || '',
            confidence: Math.round(pr.confidence * 100) / 100,
            isFixing: pr.isFixing,
            suggestedChanges: pr.suggestedChanges,
            implementationSteps: pr.implementationSteps,
        })),
        analysisResult: issue.analysisResult,
        message,
        createdAt: issue.createdAt,
    };
}

/**
 * Get issue statistics
 */
export async function getIssueStats(): Promise<{
    total: number;
    pending: number;
    analyzing: number;
    resolved: number;
    unresolved: number;
    needsAttention: number;
}> {
    const [total, pending, analyzing, resolved, unresolved, needsAttention] = await Promise.all([
        Issue.countDocuments(),
        Issue.countDocuments({ status: 'pending' }),
        Issue.countDocuments({ status: 'analyzing' }),
        Issue.countDocuments({ status: 'resolved' }),
        Issue.countDocuments({ status: 'unresolved' }),
        Issue.countDocuments({ status: 'needs_attention' }),
    ]);
    
    return { total, pending, analyzing, resolved, unresolved, needsAttention };
}
