import { Router } from 'express';
import { handleWebhook, ingestData, syncPRs, getSyncStatus, listSyncJobs, triggerWebhook } from '../controllers/githubController.js';

const router = Router();

/**
 * POST /api/github/webhook
 * Handle GitHub webhook events
 */
router.post('/webhook', handleWebhook);

/**
 * POST /api/github/ingest
 * Manually ingest GitHub data
 */
router.post('/ingest', ingestData);

/**
 * POST /api/github/sync/prs
 * Start background sync of PRs from a GitHub repository
 */
router.post('/sync/prs', syncPRs);

/**
 * GET /api/github/sync/status/:jobId
 * Get status of a sync job
 */
router.get('/sync/status/:jobId', getSyncStatus);

/**
 * GET /api/github/sync/jobs
 * Get recent sync jobs
 */
router.get('/sync/jobs', listSyncJobs);

/**
 * POST /api/github/trigger-webhook
 * Manually trigger webhook for a specific PR (simulates GitHub webhook)
 */
router.post('/trigger-webhook', triggerWebhook);

export default router;
