import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const envSchema = z.object({
    PORT: z.string().default('3001'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    MONGODB_URI: isProduction 
        ? z.string().min(1, 'MONGODB_URI is required in production')
        : z.string().default('mongodb://localhost:27017/code-companion'),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    GOOGLE_AI_API_KEY: isProduction
        ? z.string().min(1, 'GOOGLE_AI_API_KEY is required in production')
        : z.string().optional(),
    FRONTEND_URL: z.string().default('http://localhost:5173'),
    
    // Allowed repositories (comma-separated URLs)
    ALLOWED_REPOS: z.string().optional().transform((val: string | undefined) => 
        val ? val.split(',').map((r: string) => r.trim()).filter(Boolean) : []
    ),
    
    // Maximum diff content size to process (in characters)
    MAX_DIFF_SIZE: z.string().default('50000').transform((val: string) => parseInt(val, 10)),
    
    // Request timeout in milliseconds
    REQUEST_TIMEOUT: z.string().default('30000').transform((val: string) => parseInt(val, 10)),
    
    // Target repository for PR matching
    TARGET_REPO_OWNER: z.string().default('simplecrm-projects'),
    TARGET_REPO_NAME: z.string().default('simplecrm_v300_new'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env = parsed.data;

// Helper to check if a repo URL is allowed
export function isRepoAllowed(repoUrl: string): boolean {
    // If no allowed repos configured, allow all (development mode)
    if (env.ALLOWED_REPOS.length === 0) {
        return true;
    }
    return env.ALLOWED_REPOS.some((allowed: string) => 
        repoUrl.toLowerCase().includes(allowed.toLowerCase())
    );
}
