import mongoose, { Schema, Document } from 'mongoose';

export interface ICodebaseNode extends Document {
    file: string;
    imports: string[];
    lastScannedAt: Date;
}

const CodebaseNodeSchema: Schema = new Schema({
    file: { type: String, required: true, unique: true },
    imports: [{ type: String }],
    lastScannedAt: { type: Date, default: Date.now }
}, {
    timestamps: true
});

// Index for faster file lookups and dependent queries
CodebaseNodeSchema.index({ file: 1 });
CodebaseNodeSchema.index({ imports: 1 });

export const CodebaseNode = mongoose.model<ICodebaseNode>('CodebaseNode', CodebaseNodeSchema);
