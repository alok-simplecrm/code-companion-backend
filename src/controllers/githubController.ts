import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
    verifyWebhookSignature,
    handlePullRequestEvent,
    handlePushEvent,
    ingestPR,
    ingestCommit,
    triggerPRWebhook
} from '../services/githubService.js';
import { startSyncJob, getSyncJob, getRecentSyncJobs } from '../services/syncJobService.js';
import { logger } from '../utils/logger.js';

/**
 * POST /api/github/webhook
 * Handle GitHub webhook events
 */
export async function handleWebhook(req: Request, res: Response, next: NextFunction) {
    try {
        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        const event = req.headers['x-github-event'] as string;
        const deliveryId = req.headers['x-github-delivery'] as string;

        logger.info(`Received GitHub webhook: event=${event}, delivery=${deliveryId}`);

        // Get raw body for signature verification
        const rawBody = JSON.stringify(req.body);

        // Verify signature
        if (!verifyWebhookSignature(rawBody, signature)) {
            logger.error('Invalid webhook signature');
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        let result: { processed: number; errors: string[] } = { processed: 0, errors: [] };

        switch (event) {
            case 'pull_request':
                result = await handlePullRequestEvent(req.body);
                break;
            case 'push':
                result = await handlePushEvent(req.body);
                break;
            case 'ping':
                logger.info('Received ping event - webhook configured successfully');
                res.json({ success: true, message: 'Pong! Webhook configured correctly.' });
                return;
            default:
                logger.debug(`Ignoring event type: ${event}`);
                res.json({ success: true, message: `Event type '${event}' not processed` });
                return;
        }

        logger.info(`Webhook processing complete: ${result.processed} items processed, ${result.errors.length} errors`);

        res.json({
            success: result.errors.length === 0,
            processed: result.processed,
            errors: result.errors,
        });
    } catch (error) {
        next(error);
    }
}

const prSchema = z.object({
    prNumber: z.number(),
    title: z.string(),
    description: z.string().optional(),
    author: z.string(),
    repoUrl: z.string().url(),
    prUrl: z.string().url(),
    mergedAt: z.string().optional(),
    filesChanged: z.array(z.object({
        path: z.string(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
    })).optional(),
    diffContent: z.string().optional(),
});

const commitSchema = z.object({
    sha: z.string(),
    message: z.string(),
    author: z.string(),
    authorEmail: z.string().optional(),
    repoUrl: z.string().url(),
    commitUrl: z.string().url(),
    committedAt: z.string(),
    filesChanged: z.array(z.object({
        path: z.string(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
    })).optional(),
    diffContent: z.string().optional(),
});

const ingestSchema = z.object({
    type: z.enum(['pr', 'commit', 'bulk_prs', 'bulk_commits']),
    data: z.union([prSchema, commitSchema, z.array(prSchema), z.array(commitSchema)]),
});

/**
 * POST /api/github/ingest
 * Manually ingest GitHub data (PRs, commits)
 */
export async function ingestData(req: Request, res: Response, next: NextFunction) {
    try {
        const { type, data } = ingestSchema.parse(req.body);

        logger.info(`Processing ${type} ingestion request`);

        let results: Array<{ success: boolean; id?: string; error?: string }> = [];

        switch (type) {
            case 'pr': {
                const result = await ingestPR(data as z.infer<typeof prSchema>);
                results = [result];
                break;
            }
            case 'commit': {
                const result = await ingestCommit(data as z.infer<typeof commitSchema>);
                results = [result];
                break;
            }
            case 'bulk_prs': {
                const prs = data as z.infer<typeof prSchema>[];
                logger.info(`Ingesting ${prs.length} PRs`);
                for (const pr of prs) {
                    const result = await ingestPR(pr);
                    results.push(result);
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                break;
            }
            case 'bulk_commits': {
                const commits = data as z.infer<typeof commitSchema>[];
                logger.info(`Ingesting ${commits.length} commits`);
                for (const commit of commits) {
                    const result = await ingestCommit(commit);
                    results.push(result);
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                break;
            }
        }

        const successCount = results.filter(r => r.success).length;
        const failureCount = results.filter(r => !r.success).length;

        logger.info(`Ingestion complete: ${successCount} succeeded, ${failureCount} failed`);

        res.json({
            success: failureCount === 0,
            message: `Processed ${results.length} items: ${successCount} succeeded, ${failureCount} failed`,
            results,
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

const syncSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    limit: z.number().int().nonnegative().optional().default(0), // 0 means fetch all PRs
});

/**
 * POST /api/github/sync/prs
 * Start background sync of PRs from a GitHub repository
 * Returns immediately with a job ID for status polling
 */
export async function syncPRs(req: Request, res: Response, next: NextFunction) {
    try {
        const { owner, repo, limit } = syncSchema.parse(req.body);

        logger.info(`Starting background sync for ${owner}/${repo}`);

        // Start sync in background and return immediately
        const job = startSyncJob(owner, repo, limit);

        res.status(202).json({
            success: true,
            message: 'Sync started in background',
            jobId: job.id,
            status: job.status,
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
 * GET /api/github/sync/status/:jobId
 * Get status of a sync job
 */
export async function getSyncStatus(req: Request, res: Response) {
    const jobId = req.params.jobId as string;
    
    const job = getSyncJob(jobId);
    
    if (!job) {
        res.status(404).json({
            success: false,
            error: 'Job not found',
        });
        return;
    }
    
    res.json({
        success: true,
        job: {
            id: job.id,
            owner: job.owner,
            repo: job.repo,
            status: job.status,
            progress: job.progress,
            message: job.message,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
        },
    });
}

/**
 * GET /api/github/sync/jobs
 * Get recent sync jobs
 */
export async function listSyncJobs(_req: Request, res: Response) {
    const jobs = getRecentSyncJobs();
    
    res.json({
        success: true,
        jobs: jobs.map(job => ({
            id: job.id,
            owner: job.owner,
            repo: job.repo,
            status: job.status,
            progress: job.progress,
            message: job.message,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
        })),
    });
}

const triggerWebhookSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    prNumber: z.number().int().positive(),
    action: z.enum(['opened', 'closed', 'synchronize', 'edited']).optional().default('synchronize'),
});

/**
 * POST /api/github/trigger-webhook
 * Manually trigger webhook for a specific PR (simulates GitHub webhook)
 */
export async function triggerWebhook(req: Request, res: Response, next: NextFunction) {
    try {
        const { owner, repo, prNumber, action } = triggerWebhookSchema.parse(req.body);

        logger.info(`Manual webhook trigger for ${owner}/${repo}#${prNumber} (action: ${action})`);

        const result = await triggerPRWebhook(owner, repo, prNumber, action);

        res.json({
            success: result.errors.length === 0,
            message: `Webhook triggered for PR #${prNumber}`,
            processed: result.processed,
            errors: result.errors,
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
