import mongoose, { Schema, Document } from 'mongoose';

/**
 * Allowed repository for PR matching
 * Only PRs from allowed repos will be considered when analyzing issues
 */
export interface IAllowedRepo extends Document {
    repoUrl: string;           // Full GitHub repo URL
    repoOwner: string;         // Organization/owner name
    repoName: string;          // Repository name
    isActive: boolean;         // Whether to include in matching
    description?: string;      // Optional description
    addedAt: Date;
    lastSyncedAt?: Date;       // Last time PRs were synced from this repo
    prCount: number;           // Number of PRs ingested from this repo
}

const AllowedRepoSchema = new Schema<IAllowedRepo>(
    {
        repoUrl: { 
            type: String, 
            required: true, 
            unique: true,
            index: true,
        },
        repoOwner: { type: String, required: true },
        repoName: { type: String, required: true },
        isActive: { type: Boolean, default: true, index: true },
        description: { type: String },
        addedAt: { type: Date, default: Date.now },
        lastSyncedAt: { type: Date },
        prCount: { type: Number, default: 0 },
    },
    {
        timestamps: true,
    }
);

// Compound index for owner/name lookup
AllowedRepoSchema.index({ repoOwner: 1, repoName: 1 }, { unique: true });

/**
 * Parse a GitHub URL to extract owner and repo name
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    const match = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/i);
    if (match) {
        return { 
            owner: match[1], 
            repo: match[2].replace(/\.git$/, '') 
        };
    }
    return null;
}

export const AllowedRepo = mongoose.model<IAllowedRepo>('AllowedRepo', AllowedRepoSchema);
