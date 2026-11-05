const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            maxlength: 100
        },
        password: {
            type: String,
            required: true,
            maxlength: 60
        },
        role: {
            type: String,
            enum: ['admin', 'user', 'developer', 'integration_reviewer'],
            default: 'user',
            required: true
        },
        emp_no: {
            type: String,
            trim: true,
            default: '',
        },
        mobile: {
            type: String,
            required: true,
            maxlength: 15
        },
        // Platform privileges and creation quotas are never accepted at signup.
        platform_owner: { type: Boolean, default: false },
        property_creation_limit: { type: Number, min: 0, max: 1000, default: 0, validate: Number.isInteger },
        property_creation_revision: { type: Number, default: 0 }

    },
    {
        _id: true,
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
    }
);

module.exports = mongoose.model('User', userSchema);
