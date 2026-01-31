import { Router } from 'express';
import { createIssue, getIssue, listIssues, getStats } from '../controllers/issueController.js';
import { analysisLimiter } from '../middlewares/rateLimiter.js';

const router = Router();

// Get issue statistics (before :issueId to avoid conflicts)
router.get('/stats', getStats);

// Submit a new issue (rate limited like analysis)
router.post('/', analysisLimiter, createIssue);

// List issues (supports ?userId=xxx for user-specific issues)
router.get('/', listIssues);

// Get issue by ID
router.get('/:issueId', getIssue);

export default router;
