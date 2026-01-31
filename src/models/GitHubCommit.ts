import mongoose, { Schema, Document } from 'mongoose';
import { IFileChange } from './GitHubPR.js';

export interface IGitHubCommit extends Document {
    sha: string;
    message: string;
    author: string;
    authorEmail?: string;
    repoUrl: string;
    commitUrl: string;
    committedAt: Date;
    filesChanged: IFileChange[];
    diffContent?: string;
    prId?: mongoose.Types.ObjectId;
    embedding: number[];
    createdAt: Date;
}

const FileChangeSchema = new Schema<IFileChange>({
    path: { type: String, required: true },
    additions: { type: Number, default: 0 },
    deletions: { type: Number, default: 0 },
    status: { type: String, enum: ['modified', 'added', 'deleted'], default: 'modified' },
});

const GitHubCommitSchema = new Schema<IGitHubCommit>(
    {
        sha: { type: String, required: true, unique: true },
        message: { type: String, required: true },
        author: { type: String, required: true },
        authorEmail: { type: String },
        repoUrl: { type: String, required: true },
        commitUrl: { type: String, required: true },
        committedAt: { type: Date, required: true },
        filesChanged: { type: [FileChangeSchema], default: [] },
        diffContent: { type: String },
        prId: { type: Schema.Types.ObjectId, ref: 'GitHubPR' },
        embedding: { type: [Number], default: [] },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    }
);

// Text index for full-text search
GitHubCommitSchema.index({ message: 'text' });

// Index for repo lookups
GitHubCommitSchema.index({ repoUrl: 1, committedAt: -1 });

export const GitHubCommit = mongoose.model<IGitHubCommit>('GitHubCommit', GitHubCommitSchema);
