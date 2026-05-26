import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { JWT_ALG, JWT_EXP_DAYS, JWT_SECRET } from "./config.js";

export function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw, hashed) {
  try {
    return bcrypt.compareSync(pw, hashed);
  } catch {
    return false;
  }
}

export function issueToken(userId, email) {
  return jwt.sign({ sub: userId, email }, JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn: `${JWT_EXP_DAYS}d`,
  });
}

export function decodeToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALG] });
}

export function newId() {
  return nanoid();
}

export function getBearerToken(authorization) {
  if (!authorization) return null;
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
}
