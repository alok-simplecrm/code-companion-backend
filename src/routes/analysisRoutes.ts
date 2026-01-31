import { Router } from 'express';
import { analyze, getRecent } from '../controllers/analysisController.js';
import { analyzeStream } from '../controllers/streamingController.js';

const router = Router();

/**
 * POST /api/analyze
 * Analyze an error or bug description
 */
router.post('/', analyze);

/**
 * POST /api/analyze/stream
 * Stream analysis using SSE
 */
router.post('/stream', analyzeStream);

/**
 * GET /api/analyze/recent
 * Get recent analysis queries
 */
router.get('/recent', getRecent);

export default router;
