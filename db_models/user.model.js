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
            enum: ['admin', 'user', 'developer'],
            default: 'user',
            required: true
        },
        emp_no: {
            type: String,
            required: true,
        },
        mobile: {
            type: String,
            required: true,
            maxlength: 15
        }

    },
    {
        _id: true,
        timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
    }
);

module.exports = mongoose.model('User', userSchema);