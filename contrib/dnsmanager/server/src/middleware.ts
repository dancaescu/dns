import { NextFunction, Response } from "express";
import { getSession } from "./auth.js";
import { AuthenticatedRequest } from "./types.js";

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  console.log("[middleware] Auth header:", header ? header.substring(0, 30) + "..." : "MISSING");

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing authorization header" });
  }

  const sessionToken = header.slice(7);
  console.log("[middleware] Extracted token:", sessionToken.substring(0, 20) + "...");

  try {
    const session = await getSession(sessionToken);
    if (!session) {
      console.log("[middleware] Session not found or expired");
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    console.log("[middleware] Session valid for user:", session.username);
    req.user = {
      id: session.userId,
      username: session.username,
      role: session.role,
    };
    return next();
  } catch (error) {
    console.error("[middleware] Authentication error:", error);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
