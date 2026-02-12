import mongoose, { Schema, Document } from 'mongoose';

export interface IProjectProfile extends Document {
    projectName: string;
    techStack: {
        backend: string[];
        frontend: string[];
        database: string[];
        infra: string[];
    };
    directoryStructure: Map<string, string>;
    architectureOverview: string;
    lastScannedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const ProjectProfileSchema = new Schema<IProjectProfile>(
    {
        projectName: { type: String, required: true, unique: true },
        techStack: {
            backend: [String],
            frontend: [String],
            database: [String],
            infra: [String],
        },
        directoryStructure: {
            type: Map,
            of: String,
        },
        architectureOverview: { type: String },
        lastScannedAt: { type: Date, default: Date.now },
    },
    {
        timestamps: true,
    }
);

export const ProjectProfile = mongoose.model<IProjectProfile>('ProjectProfile', ProjectProfileSchema);
