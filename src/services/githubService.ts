import crypto from 'crypto';
import { GitHubPR, GitHubCommit, type IFileChange } from '../models/index.js';
import { generateEmbedding } from './embeddingService.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Verify GitHub webhook signature
 */
export function verifyWebhookSignature(payload: string, signature: string | undefined): boolean {
    if (!env.GITHUB_WEBHOOK_SECRET) {
        logger.warn('GITHUB_WEBHOOK_SECRET not set - skipping signature verification');
        return true; // Allow in dev mode
    }

    if (!signature) {
        logger.error('No signature provided');
        return false;
    }

    const hmac = crypto.createHmac('sha256', env.GITHUB_WEBHOOK_SECRET);
    hmac.update(payload);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;

    // Constant-time comparison
    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch {
        return false;
    }
}

interface GitHubPRPayload {
    action: string;
    pull_request: {
        number: number;
        title: string;
        body: string | null;
        state: string;
        merged: boolean;
        merged_at: string | null;
        html_url: string;
        user: { login: string };
        labels: Array<{ name: string }>;
    };
    repository: {
        full_name: string;
        html_url: string;
    };
}

interface GitHubPushPayload {
    commits: Array<{
        id: string;
        message: string;
        timestamp: string;
        url: string;
        author: {
            name: string;
            email: string;
        };
        added: string[];
        modified: string[];
        removed: string[];
    }>;
    repository: {
        full_name: string;
        html_url: string;
    };
}

/**
 * Handle Pull Request webhook event
 */
export async function handlePullRequestEvent(payload: GitHubPRPayload): Promise<{ processed: number; errors: string[] }> {
    const { action, pull_request: pr, repository: repo } = payload;

    logger.info(`Processing PR event: ${action} for PR #${pr.number}`);

    // Only process relevant actions
    if (!['opened', 'closed', 'reopened', 'edited', 'synchronize'].includes(action)) {
        logger.debug(`Skipping action: ${action}`);
        return { processed: 0, errors: [] };
    }

    const errors: string[] = [];

    try {
        // Extract owner and repo name from full_name (e.g., "owner/repo")
        const [owner, repoName] = repo.full_name.split('/');
        
        // Fetch files changed in this PR (including diffs)
        let filesChanged: Array<{ path: string; additions?: number; deletions?: number }> = [];
        let diffContent = '';
        
        try {
            const files = await fetchPRFiles(owner, repoName, pr.number);
            filesChanged = files.map(f => ({
                path: f.filename,
                additions: f.additions,
                deletions: f.deletions
            }));
            
            // Combine diffs for RAG context
            diffContent = files
                .filter(f => f.patch)
                .map(f => `File: ${f.filename}\n${f.patch}`)
                .join('\n\n')
                .slice(0, 8000); // 8kb limit for diff text
        } catch (e) {
            logger.warn(`Could not fetch files for PR #${pr.number}: ${e instanceof Error ? e.message : 'Unknown'}`);
        }

        // Build searchable text (now includes diff content)
        const searchText = [
            `PR #${pr.number}: ${pr.title}`,
            pr.body || '',
            `Author: ${pr.user.login}`,
            `Repository: ${repo.full_name}`,
            pr.merged ? 'Status: Merged' : pr.state === 'closed' ? 'Status: Closed' : 'Status: Open',
            `Labels: ${pr.labels.map(l => l.name).join(', ')}`,
            filesChanged.length > 0 ? `Files changed: ${filesChanged.map(f => f.path).join(', ')}` : '',
            diffContent,
        ].filter(Boolean).join('\n');

        const embedding = await generateEmbedding(searchText);

        // Determine PR state
        let state: 'open' | 'closed' | 'merged' = 'open';
        if (pr.merged) {
            state = 'merged';
        } else if (pr.state === 'closed') {
            state = 'closed';
        }

        // Upsert PR with all the data
        await GitHubPR.findOneAndUpdate(
            { prNumber: pr.number, repoUrl: repo.html_url },
            {
                prNumber: pr.number,
                title: pr.title,
                description: pr.body,
                author: pr.user.login,
                repoUrl: repo.html_url,
                prUrl: pr.html_url,
                mergedAt: pr.merged_at ? new Date(pr.merged_at) : undefined,
                state,
                labels: pr.labels.map(l => l.name),
                filesChanged,
                diffContent,
                embedding,
                updatedAt: new Date(),
            },
            { upsert: true, new: true }
        );

        logger.info(`Processed PR #${pr.number} with ${filesChanged.length} files`);
        return { processed: 1, errors: [] };
    } catch (e) {
        const errorMsg = `Failed to process PR #${pr.number}: ${e instanceof Error ? e.message : 'Unknown error'}`;
        logger.error(errorMsg);
        errors.push(errorMsg);
        return { processed: 0, errors };
    }
}

/**
 * Handle Push webhook event (commits)
 */
export async function handlePushEvent(payload: GitHubPushPayload): Promise<{ processed: number; errors: string[] }> {
    const { commits, repository: repo } = payload;

    logger.info(`Processing push event with ${commits.length} commits`);

    if (commits.length === 0) {
        return { processed: 0, errors: [] };
    }

    let processed = 0;
    const errors: string[] = [];

    for (const commit of commits) {
        try {
            // Check if commit already exists
            const existing = await GitHubCommit.findOne({ sha: commit.id });
            if (existing) {
                logger.debug(`Commit ${commit.id.substring(0, 7)} already exists, skipping`);
                continue;
            }

            // Build searchable text
            const searchText = [
                `Commit: ${commit.message}`,
                `Author: ${commit.author.name} <${commit.author.email}>`,
                `SHA: ${commit.id}`,
                `Repository: ${repo.full_name}`,
                `Files modified: ${commit.modified?.join(', ') || 'N/A'}`,
                `Files added: ${commit.added?.join(', ') || 'N/A'}`,
                `Files removed: ${commit.removed?.join(', ') || 'N/A'}`,
            ].join('\n');

            const embedding = await generateEmbedding(searchText);

            // Build files_changed array
            const filesChanged: IFileChange[] = [
                ...(commit.modified || []).map(path => ({ path, status: 'modified' as const })),
                ...(commit.added || []).map(path => ({ path, status: 'added' as const })),
                ...(commit.removed || []).map(path => ({ path, status: 'deleted' as const })),
            ];

            await GitHubCommit.create({
                sha: commit.id,
                message: commit.message,
                author: commit.author.name,
                authorEmail: commit.author.email,
                repoUrl: repo.html_url,
                commitUrl: commit.url,
                committedAt: new Date(commit.timestamp),
                filesChanged,
                embedding,
            });

            logger.debug(`Inserted commit ${commit.id.substring(0, 7)}`);
            processed++;

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
            const errorMsg = `Failed to process commit ${commit.id}: ${e instanceof Error ? e.message : 'Unknown error'}`;
            logger.error(errorMsg);
            errors.push(errorMsg);
        }
    }

    return { processed, errors };
}

interface PRIngestionData {
    prNumber: number;
    title: string;
    description?: string;
    author: string;
    repoUrl: string;
    prUrl: string;
    mergedAt?: string;
    filesChanged?: Array<{ path: string; additions?: number; deletions?: number }>;
    diffContent?: string;
}

interface CommitIngestionData {
    sha: string;
    message: string;
    author: string;
    authorEmail?: string;
    repoUrl: string;
    commitUrl: string;
    committedAt: string;
    filesChanged?: Array<{ path: string; additions?: number; deletions?: number }>;
    diffContent?: string;
}

/**
 * Manually ingest a PR
 */
export async function ingestPR(data: PRIngestionData): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
        const searchText = [
            `PR #${data.prNumber}: ${data.title}`,
            data.description || '',
            `Author: ${data.author}`,
            data.filesChanged?.map(f => f.path).join(', ') || '',
            data.diffContent || '',
        ].filter(Boolean).join('\n');

        const embedding = await generateEmbedding(searchText);

        const result = await GitHubPR.findOneAndUpdate(
            { prNumber: data.prNumber, repoUrl: data.repoUrl },
            {
                ...data,
                mergedAt: data.mergedAt ? new Date(data.mergedAt) : undefined,
                state: data.mergedAt ? 'merged' : 'open',
                embedding,
                updatedAt: new Date(),
            },
            { upsert: true, new: true }
        );

        logger.info(`Ingested PR #${data.prNumber}`);
        return { success: true, id: result._id.toString() };
    } catch (error) {
        logger.error(`Failed to ingest PR #${data.prNumber}:`, error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Manually ingest a commit
 */
export async function ingestCommit(data: CommitIngestionData): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
        const existing = await GitHubCommit.findOne({ sha: data.sha });
        if (existing) {
            logger.debug(`Commit ${data.sha.substring(0, 7)} already exists`);
            return { success: true, id: existing._id.toString() };
        }

        const searchText = [
            `Commit: ${data.message}`,
            `Author: ${data.author}`,
            `SHA: ${data.sha}`,
            data.filesChanged?.map(f => f.path).join(', ') || '',
            data.diffContent || '',
        ].filter(Boolean).join('\n');

        const embedding = await generateEmbedding(searchText);

        const result = await GitHubCommit.create({
            ...data,
            committedAt: new Date(data.committedAt),
            embedding,
        });

        logger.info(`Ingested commit ${data.sha.substring(0, 7)}`);
        return { success: true, id: result._id.toString() };
    } catch (error) {
        logger.error(`Failed to ingest commit ${data.sha}:`, error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

// ============================================================================
// GitHub API Functions for Live PR Fetching
// ============================================================================

export interface GitHubPRFromAPI {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    merged_at: string | null;
    user: {
        login: string;
    };
    labels: Array<{ name: string }>;
    created_at: string;
    updated_at: string;
}

/**
 * Fetch PRs from GitHub API
 */
export async function fetchPRsFromGitHub(
    owner: string,
    repo: string,
    options: { state?: 'open' | 'closed' | 'all'; perPage?: number; page?: number } = {}
): Promise<GitHubPRFromAPI[]> {
    const { state = 'all', perPage = 100, page = 1 } = options;

    if (!env.GITHUB_TOKEN) {
        logger.error('GITHUB_TOKEN not configured');
        throw new Error('GITHUB_TOKEN is required for GitHub API access');
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`;
    
    logger.info(`Fetching PRs from GitHub API: ${owner}/${repo}`);
    
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'code-companion-api',
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`GitHub API error: ${response.status} - ${errorText}`);
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const prs = await response.json() as GitHubPRFromAPI[];
        logger.info(`Fetched ${prs.length} PRs from GitHub`);
        return prs;
    } catch (error) {
        logger.error('Failed to fetch PRs from GitHub:', error);
        throw error;
    }
}

/**
 * Fetch detailed PR information including description
 */
export async function fetchPRDetails(
    owner: string,
    repo: string,
    prNumber: number
): Promise<GitHubPRFromAPI | null> {
    if (!env.GITHUB_TOKEN) {
        logger.error('GITHUB_TOKEN not configured');
        return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'code-companion-api',
            },
        });

        if (!response.ok) {
            logger.error(`Failed to fetch PR #${prNumber}: ${response.status}`);
            return null;
        }

        return await response.json() as GitHubPRFromAPI;
    } catch (error) {
        logger.error(`Failed to fetch PR #${prNumber}:`, error);
        return null;
    }
}

/**
 * Manually trigger PR webhook - simulates what GitHub does
 * Fetches PR details from GitHub API and processes it through the same handler
 */
export async function triggerPRWebhook(
    owner: string,
    repo: string,
    prNumber: number,
    action: 'opened' | 'closed' | 'synchronize' | 'edited' = 'synchronize'
): Promise<{ processed: number; errors: string[] }> {
    logger.info(`Triggering manual webhook for PR #${prNumber} in ${owner}/${repo}`);

    if (!env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN is required');
    }

    // Fetch full PR details from GitHub API
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'code-companion-api',
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch PR #${prNumber}: ${response.status} - ${errorText}`);
    }

    const prData = await response.json() as any;

    // Build the same payload structure that GitHub sends in a webhook
    const webhookPayload: GitHubPRPayload = {
        action,
        pull_request: {
            number: prData.number,
            title: prData.title,
            body: prData.body,
            state: prData.state,
            merged: prData.merged || false,
            merged_at: prData.merged_at,
            html_url: prData.html_url,
            user: { login: prData.user.login },
            labels: (prData.labels || []).map((l: any) => ({ name: l.name })),
        },
        repository: {
            full_name: `${owner}/${repo}`,
            html_url: `https://github.com/${owner}/${repo}`,
        },
    };

    // Process through the same handler as real webhooks
    return handlePullRequestEvent(webhookPayload);
}

/**
 * Search PRs by keywords using GitHub search API
 */
export async function searchPRsByKeywords(
    owner: string,
    repo: string,
    keywords: string[]
): Promise<GitHubPRFromAPI[]> {
    if (!env.GITHUB_TOKEN || keywords.length === 0) {
        return [];
    }

    // Build search query
    const keywordQuery = keywords.slice(0, 5).join(' '); // Limit to 5 keywords
    const searchQuery = `${keywordQuery} repo:${owner}/${repo} type:pr`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=20`;
    
    logger.info(`Searching PRs with keywords: ${keywordQuery}`);
    
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'code-companion-api',
            },
        });

        if (!response.ok) {
            logger.error(`GitHub search API error: ${response.status}`);
            return [];
        }

        const data = await response.json() as { items: GitHubPRFromAPI[] };
        logger.info(`Found ${data.items?.length || 0} PRs matching keywords`);
        
        // Fetch full PR details for each result
        const prDetails: GitHubPRFromAPI[] = [];
        for (const item of (data.items || []).slice(0, 10)) {
            const details = await fetchPRDetails(owner, repo, item.number);
            if (details) {
                prDetails.push(details);
            }
        }
        
        return prDetails;
    } catch (error) {
        logger.error('Failed to search PRs:', error);
        return [];
    }
}

/**
 * Extract keywords from issue text for PR search
 */
export function extractKeywords(text: string): string[] {
    // Remove common words and extract meaningful keywords
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
        'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
        'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
        'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
        'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
        'because', 'until', 'while', 'this', 'that', 'these', 'those', 'it',
        'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
        'her', 'they', 'them', 'their', 'what', 'which', 'who', 'whom',
    ]);
    
    // Extract words, filter stop words, and get unique keywords
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));
    
    // Return unique keywords (max 10)
    return [...new Set(words)].slice(0, 10);
}


/**
 * Fetch files changed in a PR
 */
/**
 * Fetch files changed in a PR with diff patches
 */
export async function fetchPRFiles(
    owner: string,
    repo: string,
    prNumber: number
): Promise<Array<{ filename: string; additions: number; deletions: number; status: string; patch?: string }>> {
    if (!env.GITHUB_TOKEN) {
        return [];
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'code-companion-api',
            },
        });

        if (!response.ok) {
            logger.error(`Failed to fetch files for PR #${prNumber}: ${response.status}`);
            return [];
        }

        const files = await response.json() as any[];
        return files.map(f => ({
            filename: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            status: f.status,
            patch: f.patch, // Include diff patch
        }));
    } catch (error) {
        logger.error(`Failed to fetch files for PR #${prNumber}:`, error);
        return [];
    }
}

/**
 * Sync PRs from a repository (supports pagination)
 * @param limit - Maximum number of PRs to sync. 0 means fetch all PRs.
 */
export async function syncRepoPRs(
    owner: string,
    repo: string,
    limit = 0
): Promise<{ processed: number; updated: number; skipped: number; errors: string[]; stoppedEarly: boolean; message: string }> {
    const fetchAll = limit === 0;
    logger.info(`Syncing PRs for ${owner}/${repo} (limit: ${fetchAll ? 'ALL' : limit})`);
    
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    let page = 1;
    let keepFetching = true;
    let stoppedEarly = false;
    const repoUrl = `https://github.com/${owner}/${repo}`;

    try {
        while (keepFetching) {
            const perPage = 100; // Always fetch 100 per page for efficiency
            const prs = await fetchPRsFromGitHub(owner, repo, { state: 'all', perPage, page });
            
            logger.info(`Fetched page ${page}: ${prs.length} PRs`);
            
            if (prs.length === 0) {
                break;
            }

            let pageSkipped = 0;

            for (const pr of prs) {
                // Check if we've hit the limit (only if not fetching all)
                // Limit applies to total PRs checked (processed + skipped)
                const totalChecked = processed + skipped;
                if (!fetchAll && totalChecked >= limit) {
                    keepFetching = false;
                    break;
                }

                try {
                    // Check if PR already exists in the database
                    const existing = await GitHubPR.findOne({ 
                        prNumber: pr.number, 
                        repoUrl: repoUrl 
                    });

                    // Compare timestamps to see if the PR has been updated
                    const prUpdatedAt = new Date(pr.updated_at);
                    const needsUpdate = !existing || 
                        (existing.updatedAt && prUpdatedAt > existing.updatedAt) ||
                        // Also check if merged status changed
                        (pr.merged_at && existing?.state !== 'merged');

                    if (existing && !needsUpdate) {
                        logger.debug(`PR #${pr.number} already synced and up-to-date, skipping`);
                        skipped++;
                        pageSkipped++;
                        continue;
                    }

                    const isUpdate = existing && needsUpdate;

                    // Fetch files for this PR, including diffs
                    const files = await fetchPRFiles(owner, repo, pr.number);
                    
                    // Combine diffs for RAG context (limit total size to avoid huge embeddings)
                    const diffContent = files
                        .filter(f => f.patch)
                        .map(f => `File: ${f.filename}\n${f.patch}`)
                        .join('\n\n')
                        .slice(0, 8000); // 8kb limit for diff text

                    // Map to ingestion format
                    const ingestionData: PRIngestionData = {
                        prNumber: pr.number,
                        title: pr.title,
                        description: pr.body || '',
                        author: pr.user.login,
                        repoUrl: repoUrl, 
                        prUrl: pr.html_url,
                        mergedAt: pr.merged_at || undefined,
                        filesChanged: files.map(f => ({
                            path: f.filename,
                            additions: f.additions,
                            deletions: f.deletions
                        })),
                        diffContent: diffContent
                    };

                    await ingestPR(ingestionData);
                    if (isUpdate) {
                        updated++;
                        logger.info(`PR #${pr.number} updated (was ${existing?.state}, now ${pr.merged_at ? 'merged' : pr.state})`);
                    } else {
                        processed++;
                    }
                    
                    // Log progress every 10 PRs
                    if (processed % 10 === 0) {
                        logger.info(`Progress: ${processed} PRs synced, ${skipped} skipped...`);
                    }
                    
                    // Rate limit protection
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (err) {
                    const msg = `Failed to sync PR #${pr.number}: ${err instanceof Error ? err.message : 'Unknown error'}`;
                    logger.error(msg);
                    errors.push(msg);
                }
            }

            // If all PRs on this page were already synced, stop early
            if (pageSkipped === prs.length && prs.length > 0) {
                logger.info(`All ${prs.length} PRs on page ${page} already synced. Stopping early.`);
                stoppedEarly = true;
                keepFetching = false;
                break;
            }
            
            // Stop if we got fewer PRs than requested (last page)
            if (prs.length < 100) {
                keepFetching = false;
            } else {
                page++;
                // Small delay between pages to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Build summary message
        let message = '';
        const totalProcessed = processed + updated;
        if (totalProcessed === 0 && skipped > 0) {
            message = `All ${skipped} PRs are already synced and up-to-date. No new or updated PRs to process.`;
        } else if (stoppedEarly) {
            message = `Synced ${processed} new PRs, updated ${updated} PRs, skipped ${skipped} already synced. Stopped early as remaining PRs are already synced.`;
        } else {
            message = `Synced ${processed} new PRs, updated ${updated} PRs, skipped ${skipped} unchanged.`;
        }

        logger.info(`Sync complete: ${processed} new PRs, ${updated} updated, ${skipped} skipped, ${errors.length} errors`);
        return { processed, updated, skipped, errors, stoppedEarly, message };
    } catch (error) {
        throw error;
    }
}
