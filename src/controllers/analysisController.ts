import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { analyzeError, getRecentAnalyses } from '../services/analysisService.js';
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

        const result = await analyzeError(validatedBody);

        res.json({
            success: true,
            analysis: result,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: error.errors,
            });
            return;
        }
        next(error);
    }
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
        });
    } catch (error) {
        next(error);
    }
}
