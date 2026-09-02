const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        token_hash: {
            type: String,
            required: true,
            unique: true
        },
        expires_at: {
            type: Date,
            required: true
        }
    },
    {
        _id: true,
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
    }
);

sessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
