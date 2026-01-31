#!/usr/bin/env node

/**
 * Script to fetch PRs from GitHub and ingest them into Code Companion
 * Usage: node scripts/ingest-github-prs.js <owner> <repo>
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_URL = 'http://localhost:3001/api';

if (!GITHUB_TOKEN) {
    console.error('❌ GITHUB_TOKEN not found in .env');
    process.exit(1);
}

const owner = process.argv[2] || 'alok-simplecrm';
const repo = process.argv[3] || 'DevNotes';

console.log(`🔍 Fetching PRs from github.com/${owner}/${repo}...`);

async function fetchGitHubPRs(owner, repo, state = 'all') {
    const allPRs = [];
    let page = 1;
    const perPage = 100;

    console.log(`  Fetching page ${page}...`);
    
    while (true) {
        const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'CodeCompanion-Ingester'
            }
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`GitHub API error: ${response.status} - ${error}`);
        }

        const prs = await response.json();
        
        if (prs.length === 0) {
            break; // No more PRs to fetch
        }

        allPRs.push(...prs);
        console.log(`  Fetched page ${page}: ${prs.length} PRs (total: ${allPRs.length})`);

        if (prs.length < perPage) {
            break; // Last page (fewer than perPage results)
        }

        page++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allPRs;
}

async function fetchPRDiff(owner, repo, prNumber) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3.diff',
            'User-Agent': 'CodeCompanion-Ingester'
        }
    });

    if (!response.ok) {
        console.warn(`  ⚠️ Could not fetch diff for PR #${prNumber}`);
        return null;
    }

    const diff = await response.text();
    // Limit diff size to prevent memory issues
    return diff.slice(0, 50000);
}

async function fetchPRFiles(owner, repo, prNumber) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;
    
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'CodeCompanion-Ingester'
        }
    });

    if (!response.ok) {
        return [];
    }

    const files = await response.json();
    return files.map(f => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status
    }));
}

async function ingestPR(prData) {
    const response = await fetch(`${API_URL}/github/ingest`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'pr',
            data: prData
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ingestion error: ${response.status} - ${error}`);
    }

    return response.json();
}

async function main() {
    try {
        // Fetch PRs from GitHub
        const prs = await fetchGitHubPRs(owner, repo);
        console.log(`📦 Found ${prs.length} PRs\n`);

        if (prs.length === 0) {
            console.log('No PRs found in this repository.');
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (const pr of prs) {
            console.log(`Processing PR #${pr.number}: ${pr.title}`);
            
            try {
                // Fetch additional details
                const [diffContent, filesChanged] = await Promise.all([
                    fetchPRDiff(owner, repo, pr.number),
                    fetchPRFiles(owner, repo, pr.number)
                ]);

                // Prepare PR data for ingestion
                const prData = {
                    prNumber: pr.number,
                    title: pr.title,
                    description: pr.body || '',
                    author: pr.user.login,
                    repoUrl: `https://github.com/${owner}/${repo}`,
                    prUrl: pr.html_url,
                    mergedAt: pr.merged_at,
                    state: pr.merged_at ? 'merged' : pr.state,
                    filesChanged,
                    diffContent
                };

                // Ingest into Code Companion
                const result = await ingestPR(prData);
                
                if (result.success) {
                    console.log(`  ✅ Ingested (${filesChanged.length} files)`);
                    successCount++;
                } else {
                    console.log(`  ❌ Failed: ${result.error}`);
                    errorCount++;
                }

                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (err) {
                console.log(`  ❌ Error: ${err.message}`);
                errorCount++;
            }
        }

        console.log(`\n📊 Summary:`);
        console.log(`  ✅ Successfully ingested: ${successCount}`);
        console.log(`  ❌ Failed: ${errorCount}`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();
