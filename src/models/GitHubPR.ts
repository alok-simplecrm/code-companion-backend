import mongoose, { Schema, Document } from 'mongoose';

export interface IFileChange {
    path: string;
    additions?: number;
    deletions?: number;
    status?: 'modified' | 'added' | 'deleted';
}

export interface IGitHubPR extends Document {
    prNumber: number;
    title: string;
    description?: string;
    author: string;
    repoUrl: string;
    prUrl: string;
    mergedAt?: Date;
    state: 'open' | 'closed' | 'merged';
    filesChanged: IFileChange[];
    diffContent?: string;
    embedding: number[];
    labels: string[];
    createdAt: Date;
    updatedAt: Date;
}

const FileChangeSchema = new Schema<IFileChange>({
    path: { type: String, required: true },
    additions: { type: Number, default: 0 },
    deletions: { type: Number, default: 0 },
    status: { type: String, enum: ['modified', 'added', 'deleted'], default: 'modified' },
});

const GitHubPRSchema = new Schema<IGitHubPR>(
    {
        prNumber: { type: Number, required: true },
        title: { type: String, required: true },
        description: { type: String },
        author: { type: String, required: true },
        repoUrl: { type: String, required: true },
        prUrl: { type: String, required: true },
        mergedAt: { type: Date },
        state: {
            type: String,
            enum: ['open', 'closed', 'merged'],
            default: 'open'
        },
        filesChanged: { type: [FileChangeSchema], default: [] },
        diffContent: { type: String },
        embedding: { type: [Number], default: [] },
        labels: { type: [String], default: [] },
    },
    {
        timestamps: true,
    }
);

// Compound index for unique PR per repo
GitHubPRSchema.index({ prNumber: 1, repoUrl: 1 }, { unique: true });

// Text index for full-text search
GitHubPRSchema.index({ title: 'text', description: 'text' });

export const GitHubPR = mongoose.model<IGitHubPR>('GitHubPR', GitHubPRSchema);
