const mongoose = require("mongoose");
const crypto = require("crypto");
const User = require("../db_models/user.model");
const Session = require("../db_models/session.model");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sendPasswordResetOtp } = require("../services/password-reset-email.service");

const express = require("express");
const router = express.Router();

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_OTP_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_OTP_RESEND_DELAY_MS = 60 * 1000;
const PASSWORD_RESET_OTP_MAX_ATTEMPTS = 5;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const passwordResetResponse = "If an account exists for that email, a verification code has been sent.";

router.post("/forgot-password", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  try {
    const user = await User.findOne({ email }).select(
      "+password_reset_otp_hash +password_reset_otp_expires_at +password_reset_otp_attempts +password_reset_otp_requested_at"
    );
    if (!user) return res.status(200).json({ message: passwordResetResponse });

    const now = Date.now();
    const lastRequestedAt = user.password_reset_otp_requested_at?.getTime?.();
    if (lastRequestedAt && now - lastRequestedAt < PASSWORD_RESET_OTP_RESEND_DELAY_MS) {
      return res.status(200).json({ message: passwordResetResponse });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    user.password_reset_otp_hash = await bcrypt.hash(otp, 10);
    user.password_reset_otp_expires_at = new Date(now + PASSWORD_RESET_OTP_TTL_MS);
    user.password_reset_otp_attempts = 0;
    user.password_reset_otp_requested_at = new Date(now);
    await user.save();

    try {
      await sendPasswordResetOtp({ to: user.email, name: user.name, otp });
    } catch (error) {
      await User.updateOne({ _id: user._id, password_reset_otp_hash: user.password_reset_otp_hash }, {
        $unset: {
          password_reset_otp_hash: 1,
          password_reset_otp_expires_at: 1,
          password_reset_otp_attempts: 1,
          password_reset_otp_requested_at: 1
        }
      });
      console.error("Password reset email delivery failed:", error.message);
      return res.status(503).json({ message: "Unable to send a password reset code right now. Please try again later." });
    }

    return res.status(200).json({ message: passwordResetResponse });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/reset-password/verify-otp", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const otp = req.body?.otp;
  const newPassword = req.body?.newPassword;
  if (!email || email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: "Enter a valid email address and six-digit verification code." });
  }
  if (typeof newPassword !== "string" || newPassword.length < 6 || Buffer.byteLength(newPassword, "utf8") > 72) {
    return res.status(400).json({
      message: typeof newPassword === "string" && Buffer.byteLength(newPassword, "utf8") > 72
        ? "Password is too long. Choose a shorter password."
        : "Use at least 6 characters for the password."
    });
  }

  try {
    const user = await User.findOne({ email }).select(
      "+password_reset_otp_hash +password_reset_otp_expires_at +password_reset_otp_attempts"
    );
    const now = new Date();
    if (!user?.password_reset_otp_hash
        || !user.password_reset_otp_expires_at
        || user.password_reset_otp_expires_at <= now
        || user.password_reset_otp_attempts >= PASSWORD_RESET_OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ message: "The verification code is invalid or expired." });
    }

    const isMatch = await bcrypt.compare(otp, user.password_reset_otp_hash);
    if (!isMatch) {
      await User.updateOne({
        _id: user._id,
        password_reset_otp_hash: user.password_reset_otp_hash,
        password_reset_otp_expires_at: { $gt: now },
        password_reset_otp_attempts: { $lt: PASSWORD_RESET_OTP_MAX_ATTEMPTS }
      }, { $inc: { password_reset_otp_attempts: 1 } });
      return res.status(400).json({ message: "The verification code is invalid or expired." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const result = await User.updateOne({
      _id: user._id,
      password_reset_otp_hash: user.password_reset_otp_hash,
      password_reset_otp_expires_at: { $gt: now },
      password_reset_otp_attempts: { $lt: PASSWORD_RESET_OTP_MAX_ATTEMPTS }
    }, {
      $set: { password: hashedPassword },
      $unset: {
        password_reset_otp_hash: 1,
        password_reset_otp_expires_at: 1,
        password_reset_otp_attempts: 1,
        password_reset_otp_requested_at: 1
      }
    });
    if (result.matchedCount !== 1) {
      return res.status(400).json({ message: "The verification code is invalid or expired." });
    }

    await Session.deleteMany({ user: user._id });
    return res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body?.password;
  const mobile = typeof req.body?.mobile === "string" ? req.body.mobile.trim() : "";
  if (!name || !email || typeof password !== "string" || !password || !mobile) {
    return res.status(400).json({ message: "Name, email, password and mobile are required." });
  }
  if (name.length > 100 || email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Enter a valid name and email address (up to 100 characters each)." });
  }
  if (password.length < 6 || Buffer.byteLength(password, "utf8") > 72) {
    return res.status(400).json({ message: password.length < 6 ? "Use at least 6 characters for the password." : "Password is too long. Choose a shorter password." });
  }
  if (mobile.length > 15) {
    return res.status(400).json({ message: "Mobile number must contain no more than 15 characters." });
  }
  try {
    // Check if the user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }
    
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      role: "user",
      mobile
    });

    await newUser.save();
    res.status(201).json({ message: "Account created successfully" });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "An account already uses this email address." });
    if (error instanceof mongoose.Error.ValidationError) return res.status(400).json({ message: "Check your name, email and mobile number." });
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
    try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "No User For this email" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1h"
    });

    const refreshToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET_REFRESH, {
      expiresIn: "7d"
    });

    await Session.create({
      user: user._id,
      token_hash: hashToken(refreshToken),
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
    });

    res.status(200).json({ token, refreshToken });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});


router.post("/refresh-token", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token is required" });
  }

  jwt.verify(refreshToken, process.env.JWT_SECRET_REFRESH, async (err, payload) => {
    if (err) return res.status(403).json({ message: "Invalid or expired refresh token" });

    try {
      const session = await Session.findOne({ token_hash: hashToken(refreshToken) });
      if (!session) {
        return res.status(403).json({ message: "Invalid or expired refresh token" });
      }

      const token = jwt.sign({ id: payload.id }, process.env.JWT_SECRET, {
        expiresIn: "1h"
      });

      res.status(200).json({ token });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Internal server error" });
    }
  });
});

router.post("/logout", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ message: "Refresh token is required" });
  }

  try {
    await Session.deleteOne({ token_hash: hashToken(refreshToken) });
    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

const authenticateToken = (req, res, next) => {

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });

}

router.post("/reset-password", authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Current password and new password are required" });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    await Session.deleteMany({ user: user._id });

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
module.exports.authenticateToken = authenticateToken;
