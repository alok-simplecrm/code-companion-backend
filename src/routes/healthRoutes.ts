import { Router } from 'express';
import { healthCheck, getStats } from '../controllers/healthController.js';

const router = Router();

/**
 * GET /api/health
 * Health check
 */
router.get('/health', healthCheck);

/**
 * GET /api/stats
 * Database statistics
 */
router.get('/stats', getStats);

export default router;
