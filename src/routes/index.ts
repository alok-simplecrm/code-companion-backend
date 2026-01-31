import { Router } from 'express';
import analysisRoutes from './analysisRoutes.js';
import githubRoutes from './githubRoutes.js';
import healthRoutes from './healthRoutes.js';
import issueRoutes from './issueRoutes.js';
import reposRoutes from './reposRoutes.js';

const router = Router();

// Health and stats endpoints
router.use('/', healthRoutes);

// Analysis endpoints
router.use('/analyze', analysisRoutes);

// GitHub endpoints (webhooks and ingestion)
router.use('/github', githubRoutes);

// Issue endpoints
router.use('/issues', issueRoutes);

// Repository management endpoints
router.use('/repos', reposRoutes);

export default router;
