import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { analyzeError, getRecentAnalyses, checkDataAvailability } from '../services/analysisService.js';
import { logger } from '../utils/logger.js';

const analyzeSchema = z.object({
    inputText: z.string().min(1, 'Input text is required'),
    inputType: z.enum(['error', 'stack_trace', 'jira_ticket', 'github_issue', 'description']),
});

/**
 * POST /api/analyze
 * Analyze an error or bug description using RAG + LLM
 */
export async function analyze(req: Request, res: Response, next: NextFunction) {
    try {
        const validatedBody = analyzeSchema.parse(req.body);

        logger.info(`Analysis request: ${validatedBody.inputType}`);

        // Check if we have any data to analyze against
        const dataAvailability = await checkDataAvailability();
        
        if (!dataAvailability.hasData) {
            return res.status(200).json({
                success: true,
                analysis: {
                    status: 'unknown',
                    confidence: 0,
                    summary: 'No data available for analysis',
                    rootCause: 'Unable to analyze - no Pull Requests or commits have been synced yet.',
                    explanation: dataAvailability.message,
                    conversationalResponse: `Hey! 👋 I'd love to help you analyze this issue, but I don't have any data to work with yet.

To unlock AI-powered analysis, you'll need to **sync a GitHub repository** first. This lets me search through your PRs, commits, and code changes to find relevant solutions.

**Here's how to get started:**
1. Go to **Settings > Repositories**
2. Add your GitHub repository
3. Click **"Sync PRs"** to import your pull requests
4. Come back here and I'll be ready to help!

Once you've synced some data, I'll be able to find similar issues, analyze code patterns, and give you actionable suggestions. Looking forward to helping you! 🚀`,
                    relatedPRs: [],
                    relatedCommits: [],
                    relatedTickets: [],
                    filesImpacted: [],
                    diffAnalysis: 'No diffs available - please sync a repository first.',
                    bestPractices: [],
                    fixSuggestion: {
                        title: 'Sync Repository First',
                        description: 'To get AI-powered analysis, you need to sync a GitHub repository first.',
                        steps: [
                            'Go to Settings > Repositories',
                            'Add your GitHub repository',
                            'Click "Sync PRs" to import pull requests',
                            'Once synced, retry your analysis'
                        ],
                        codeExample: undefined
                    }
                },
                message: dataAvailability.message,
                hint: 'Sync a GitHub repository to enable AI analysis'
            });
        }

        const result = await analyzeError(validatedBody);

        // Format a user-friendly response
        res.json({
            success: true,
            analysis: result,
            message: formatSummaryMessage(result),
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            res.status(400).json({
                success: false,
                error: 'Invalid request',
                message: 'Please provide valid input for analysis.',
                details: error.errors.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                })),
            });
            return;
        }
        
        // Handle specific error types with user-friendly messages
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        if (errorMessage.includes('GOOGLE_AI_API_KEY')) {
            logger.error('Google AI API key not configured');
            return res.status(503).json({
                success: false,
                error: 'AI Service Unavailable',
                message: 'The AI analysis service is not configured. Please contact the administrator.',
                hint: 'GOOGLE_AI_API_KEY environment variable is missing'
            });
        }
        
        if (errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
            logger.error('AI service rate limited:', errorMessage);
            return res.status(429).json({
                success: false,
                error: 'Rate Limited',
                message: 'The AI service is temporarily unavailable due to high demand. Please try again in a few minutes.',
                retryAfter: 60
            });
        }
        
        logger.error('Analysis error:', error);
        next(error);
    }
}

/**
 * Format a user-friendly summary message based on the analysis result
 */
function formatSummaryMessage(result: any): string {
    if (!result) return 'Analysis completed but no results were returned.';
    
    const { status, confidence, relatedPRs = [] } = result;
    
    if (status === 'fixed' && confidence >= 0.7) {
        const prCount = relatedPRs.length;
        return `Good news! This issue appears to be fixed. Found ${prCount} related PR${prCount !== 1 ? 's' : ''} with ${Math.round(confidence * 100)}% confidence.`;
    }
    
    if (status === 'partially_fixed') {
        return `This issue appears to be partially addressed. Some related changes were found, but additional fixes may be needed.`;
    }
    
    if (status === 'not_fixed') {
        return `This issue does not appear to be fixed yet. Check the suggested fixes below for guidance.`;
    }
    
    if (relatedPRs.length === 0) {
        return `No matching PRs were found. This might be a new issue or the relevant code hasn't been indexed yet.`;
    }
    
    return `Analysis complete. Found ${relatedPRs.length} potentially related PR${relatedPRs.length !== 1 ? 's' : ''}.`;
}

/**
 * GET /api/analyze/recent
 * Get recent analysis queries
 */
export async function getRecent(req: Request, res: Response, next: NextFunction) {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const analyses = await getRecentAnalyses(limit);

        res.json({
            success: true,
            data: analyses,
            count: analyses.length,
        });
    } catch (error) {
        next(error);
    }
}
