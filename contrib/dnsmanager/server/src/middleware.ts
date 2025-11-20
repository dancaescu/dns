import { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import { jwtSecret } from "./config.js";
import { AuthenticatedRequest, AuthenticatedUser } from "./types.js";

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing authorization header" });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, jwtSecret) as AuthenticatedUser;
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
