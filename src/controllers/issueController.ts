import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { 
    submitIssue, 
    getIssueById, 
    getUserIssues, 
    getAllIssues,
    getIssueStats 
} from '../services/issueService.js';
import { logger } from '../utils/logger.js';

// Validation schemas
const submitIssueSchema = z.object({
    title: z.string().min(5, 'Title must be at least 5 characters'),
    description: z.string().min(10, 'Description must be at least 10 characters'),
    inputType: z.enum(['error', 'stack_trace', 'jira_ticket', 'github_issue', 'description']).default('description'),
    userId: z.string().optional(),
    email: z.string().email().optional(),
});

const paginationSchema = z.object({
    limit: z.string().optional().transform(val => Math.min(parseInt(val || '20', 10), 100)),
    offset: z.string().optional().transform(val => parseInt(val || '0', 10)),
    status: z.enum(['pending', 'analyzing', 'resolved', 'unresolved', 'needs_attention']).optional(),
});

/**
 * POST /api/issues
 * Submit a new issue for analysis
 */
export async function createIssue(req: Request, res: Response, next: NextFunction) {
    try {
        const validatedBody = submitIssueSchema.parse(req.body);
        
        logger.info(`New issue submission: ${validatedBody.title}`);
        
        const result = await submitIssue(validatedBody);
        
        res.status(201).json({
            success: true,
            data: result,
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
 * GET /api/issues/:issueId
 * Get issue by ID
 */
export async function getIssue(req: Request, res: Response, next: NextFunction) {
    try {
        const issueId = req.params.issueId as string;
        
        if (!issueId) {
            res.status(400).json({
                success: false,
                error: 'Issue ID is required',
            });
            return;
        }
        
        const issue = await getIssueById(issueId);
        
        if (!issue) {
            res.status(404).json({
                success: false,
                error: 'Issue not found',
            });
            return;
        }
        
        res.json({
            success: true,
            data: issue,
        });
    } catch (error) {
        next(error);
    }
}

/**
 * GET /api/issues
 * Get all issues (paginated)
 */
export async function listIssues(req: Request, res: Response, next: NextFunction) {
    try {
        const { limit, offset, status } = paginationSchema.parse(req.query);
        const userId = req.query.userId as string | undefined;
        
        const result = userId 
            ? await getUserIssues(userId, { limit, offset, status })
            : await getAllIssues({ limit, offset, status });
        
        res.json({
            success: true,
            data: result.issues,
            pagination: {
                total: result.total,
                limit,
                offset,
                hasMore: offset + result.issues.length < result.total,
            },
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            res.status(400).json({
                success: false,
                error: 'Invalid query parameters',
                details: error.errors,
            });
            return;
        }
        next(error);
    }
}

/**
 * GET /api/issues/stats
 * Get issue statistics
 */
export async function getStats(req: Request, res: Response, next: NextFunction) {
    try {
        const stats = await getIssueStats();
        
        res.json({
            success: true,
            data: stats,
        });
    } catch (error) {
        next(error);
    }
}
