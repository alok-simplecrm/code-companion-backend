import { Router } from 'express';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AllowedRepo } from '../models/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/repos
 * List all allowed repositories
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const repos = await AllowedRepo.find({ isActive: true })
            .sort({ addedAt: -1 })
            .select('repoUrl repoOwner repoName description addedAt lastSyncedAt prCount');
        
        res.json({
            success: true,
            data: repos.map(r => ({
                id: r._id,
                owner: r.repoOwner,
                repo: r.repoName,
                url: r.repoUrl,
                description: r.description,
                label: r.description || `${r.repoOwner}/${r.repoName}`,
                addedAt: r.addedAt,
                lastSyncedAt: r.lastSyncedAt,
                prCount: r.prCount,
            })),
        });
    } catch (error) {
        next(error);
    }
});

const addRepoSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    description: z.string().optional(),
});

/**
 * POST /api/repos
 * Add a new repository to the allowed list
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { owner, repo, description } = addRepoSchema.parse(req.body);
        
        const repoUrl = `https://github.com/${owner}/${repo}`;
        
        // Check if repo already exists
        const existing = await AllowedRepo.findOne({ repoOwner: owner, repoName: repo });
        if (existing) {
            // If it exists but is inactive, reactivate it
            if (!existing.isActive) {
                existing.isActive = true;
                if (description) existing.description = description;
                await existing.save();
                logger.info(`Reactivated repo: ${owner}/${repo}`);
            }
            
            return res.json({
                success: true,
                data: {
                    id: existing._id,
                    owner: existing.repoOwner,
                    repo: existing.repoName,
                    url: existing.repoUrl,
                    description: existing.description,
                    label: existing.description || `${existing.repoOwner}/${existing.repoName}`,
                    addedAt: existing.addedAt,
                    lastSyncedAt: existing.lastSyncedAt,
                    prCount: existing.prCount,
                },
                message: 'Repository already exists',
            });
        }
        
        // Create new repo
        const newRepo = await AllowedRepo.create({
            repoUrl,
            repoOwner: owner,
            repoName: repo,
            description,
            isActive: true,
            prCount: 0,
        });
        
        logger.info(`Added new repo: ${owner}/${repo}`);
        
        res.status(201).json({
            success: true,
            data: {
                id: newRepo._id,
                owner: newRepo.repoOwner,
                repo: newRepo.repoName,
                url: newRepo.repoUrl,
                description: newRepo.description,
                label: newRepo.description || `${newRepo.repoOwner}/${newRepo.repoName}`,
                addedAt: newRepo.addedAt,
                lastSyncedAt: newRepo.lastSyncedAt,
                prCount: newRepo.prCount,
            },
            message: 'Repository added successfully',
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
});

/**
 * DELETE /api/repos/:id
 * Remove (deactivate) a repository
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        
        const repo = await AllowedRepo.findByIdAndUpdate(
            id,
            { isActive: false },
            { new: true }
        );
        
        if (!repo) {
            res.status(404).json({
                success: false,
                error: 'Repository not found',
            });
            return;
        }
        
        logger.info(`Deactivated repo: ${repo.repoOwner}/${repo.repoName}`);
        
        res.json({
            success: true,
            message: 'Repository removed',
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PATCH /api/repos/:id/sync
 * Update the last synced timestamp and PR count for a repo
 */
router.patch('/:id/sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const { prCount } = req.body;
        
        const repo = await AllowedRepo.findByIdAndUpdate(
            id,
            { 
                lastSyncedAt: new Date(),
                ...(prCount !== undefined && { prCount }),
            },
            { new: true }
        );
        
        if (!repo) {
            res.status(404).json({
                success: false,
                error: 'Repository not found',
            });
            return;
        }
        
        res.json({
            success: true,
            data: {
                id: repo._id,
                lastSyncedAt: repo.lastSyncedAt,
                prCount: repo.prCount,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/repos/pr-diff
 * Fetch raw PR diff from GitHub on-demand
 */
router.get('/pr-diff', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { owner, repo, prNumber } = req.query;
        
        if (!owner || !repo || !prNumber) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: owner, repo, prNumber',
            });
        }
        
        const { fetchPRDiffRaw } = await import('../services/githubService.js');
        const diff = await fetchPRDiffRaw(owner as string, repo as string, parseInt(prNumber as string));
        
        res.json({
            success: true,
            data: diff,
        });
    } catch (error) {
        next(error);
    }
});

export default router;
