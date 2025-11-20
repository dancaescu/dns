import { Router } from "express";
import { z } from "zod";
import { query, execute } from "../db.js";
import { getSession, logAction } from "../auth.js";
import { sendTicketNotification } from "../mailer.js";

const router = Router();

// Middleware to check authentication
async function requireAuth(req: any, res: any, next: any) {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  if (!sessionToken) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const session = await getSession(sessionToken);
  if (!session) {
    return res.status(401).json({ message: "Invalid or expired session" });
  }

  req.session = session;
  next();
}

router.use(requireAuth);

const createTicketSchema = z.object({
  incident_date: z.string().min(1),
  incident_hour: z.string().min(1),
  incident_type: z.enum(["RR", "SOA", "Cloudflare", "API", "Other"]),
  subject: z.string().min(1).max(500),
  message: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  screenshot_data: z.string().optional(),
});

/**
 * GET /api/tickets
 * List user's tickets
 */
router.get("/", async (req: any, res) => {
  try {
    const status = req.query.status || null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    let sql = `
      SELECT t.*, u.username, u.email, u.full_name,
             (SELECT COUNT(*) FROM dnsmanager_ticket_replies r WHERE r.ticket_id = t.id) as reply_count,
             (SELECT COUNT(*) FROM dnsmanager_ticket_attachments a WHERE a.ticket_id = t.id) as attachment_count
      FROM dnsmanager_tickets t
      JOIN dnsmanager_users u ON u.id = t.user_id
      WHERE t.user_id = ?
    `;
    const params: any[] = [req.session.userId];

    if (status) {
      sql += ` AND t.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await query(sql, params);
    res.json({ tickets: rows });
  } catch (error) {
    console.error("List tickets error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/tickets/all (Admin only)
 * List all tickets
 */
router.get("/all", async (req: any, res) => {
  try {
    // Check if user is superadmin
    if (req.session.role !== "superadmin") {
      return res.status(403).json({ message: "Insufficient permissions" });
    }

    const status = req.query.status || null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    let sql = `
      SELECT t.*, u.username, u.email, u.full_name,
             (SELECT COUNT(*) FROM dnsmanager_ticket_replies r WHERE r.ticket_id = t.id) as reply_count,
             (SELECT COUNT(*) FROM dnsmanager_ticket_attachments a WHERE a.ticket_id = t.id) as attachment_count
      FROM dnsmanager_tickets t
      JOIN dnsmanager_users u ON u.id = t.user_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status) {
      sql += ` AND t.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await query(sql, params);
    res.json({ tickets: rows });
  } catch (error) {
    console.error("List all tickets error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/tickets/:id
 * Get ticket details
 */
router.get("/:id", async (req: any, res) => {
  try {
    const ticketId = Number(req.params.id);

    // Get ticket
    const [tickets] = await query(
      `SELECT t.*, u.username, u.email, u.full_name
       FROM dnsmanager_tickets t
       JOIN dnsmanager_users u ON u.id = t.user_id
       WHERE t.id = ? AND (t.user_id = ? OR ? = 'superadmin')`,
      [ticketId, req.session.userId, req.session.role]
    );

    if (tickets.length === 0) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    const ticket = tickets[0];

    // Get replies
    const [replies] = await query(
      `SELECT r.*, u.username, u.email, u.full_name
       FROM dnsmanager_ticket_replies r
       JOIN dnsmanager_users u ON u.id = r.user_id
       WHERE r.ticket_id = ?
       ORDER BY r.created_at ASC`,
      [ticketId]
    );

    // Get attachments
    const [attachments] = await query(
      `SELECT id, ticket_id, reply_id, filename, file_type, file_size, created_at
       FROM dnsmanager_ticket_attachments
       WHERE ticket_id = ?
       ORDER BY created_at ASC`,
      [ticketId]
    );

    res.json({
      ticket,
      replies,
      attachments,
    });
  } catch (error) {
    console.error("Get ticket error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * POST /api/tickets
 * Create new ticket
 */
router.post("/", async (req: any, res) => {
  const parsed = createTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request", issues: parsed.error.issues });
  }

  const ipAddress = req.socket.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    const data = parsed.data;

    // Parse incident date and time
    const incidentDateParts = data.incident_date.split("/");
    const incidentDate = `${incidentDateParts[2]}-${incidentDateParts[0]}-${incidentDateParts[1]}`;

    // Create ticket
    const result = await execute(
      `INSERT INTO dnsmanager_tickets
       (user_id, incident_date, incident_hour, incident_type, subject, message, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
      [req.session.userId, incidentDate, data.incident_hour, data.incident_type, data.subject, data.message, data.priority]
    );

    const ticketId = result.insertId;

    // Handle screenshot if provided
    let screenshotAttachment: { filename: string; content: Buffer; contentType: string } | undefined;
    if (data.screenshot_data) {
      try {
        // Parse base64 data
        let encoded_payload = data.screenshot_data;
        let detected_mime = "image/png";

        const matches = data.screenshot_data.match(/^data:(image\/[a-z0-9.+\-]+);base64,(.*)$/i);
        if (matches) {
          detected_mime = matches[1].toLowerCase();
          encoded_payload = matches[2];
        } else if (data.screenshot_data.includes(",")) {
          const parts = data.screenshot_data.split(",", 2);
          encoded_payload = parts[1];
        }

        // Clean up the payload
        encoded_payload = encoded_payload.replace(/\s/g, "");

        // Add padding if needed
        const padding = encoded_payload.length % 4;
        if (padding) {
          encoded_payload += "=".repeat(4 - padding);
        }

        const screenshot_binary = Buffer.from(encoded_payload, "base64");

        if (screenshot_binary.length > 0) {
          const extension = detected_mime.includes("jpeg") || detected_mime.includes("jpg") ? "jpg" : detected_mime.includes("gif") ? "gif" : detected_mime.includes("webp") ? "webp" : "png";

          const screenshot_filename = `ticket_${ticketId}_screenshot_${Date.now()}.${extension}`;

          // Save to database
          await execute(
            `INSERT INTO dnsmanager_ticket_attachments
             (ticket_id, user_id, filename, file_data, file_type, file_size)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ticketId, req.session.userId, screenshot_filename, screenshot_binary, detected_mime, screenshot_binary.length]
          );

          screenshotAttachment = {
            filename: screenshot_filename,
            content: screenshot_binary,
            contentType: detected_mime,
          };
        }
      } catch (error) {
        console.error("Failed to process screenshot:", error);
        // Continue without screenshot
      }
    }

    // Get user info for email
    const [users] = await query<{ email: string; full_name: string; username: string }>(
      `SELECT email, full_name, username FROM dnsmanager_users WHERE id = ?`,
      [req.session.userId]
    );

    const user = users[0];

    // Get admin email from settings
    const [settings] = await query<{ setting_value: string }>(
      `SELECT setting_value FROM dnsmanager_settings WHERE setting_key = 'ticket_admin_email'`
    );

    const adminEmail = settings.length > 0 && settings[0].setting_value ? settings[0].setting_value : "admin@localhost";

    // Send email notification
    try {
      await sendTicketNotification({
        ticketId,
        userEmail: user.email,
        userName: user.full_name || user.username,
        incidentType: data.incident_type,
        incidentDate: data.incident_date,
        incidentHour: data.incident_hour,
        subject: data.subject,
        message: data.message,
        adminEmail,
        attachments: screenshotAttachment ? [screenshotAttachment] : undefined,
      });
    } catch (emailError) {
      console.error("Failed to send ticket email:", emailError);
      // Don't fail the ticket creation if email fails
    }

    await logAction(req.session.userId, "other", `Created support ticket #${ticketId}: ${data.subject}`, ipAddress, userAgent);

    res.status(201).json({
      success: true,
      ticket_id: ticketId,
      message: "Ticket created successfully",
    });
  } catch (error) {
    console.error("Create ticket error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * PUT /api/tickets/:id/status
 * Update ticket status (Admin only)
 */
router.put("/:id/status", async (req: any, res) => {
  try {
    // Check if user is superadmin
    if (req.session.role !== "superadmin") {
      return res.status(403).json({ message: "Insufficient permissions" });
    }

    const ticketId = Number(req.params.id);
    const { status } = req.body;

    if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    await execute(`UPDATE dnsmanager_tickets SET status = ? WHERE id = ?`, [status, ticketId]);

    const ipAddress = req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";
    await logAction(req.session.userId, "other", `Updated ticket #${ticketId} status to ${status}`, ipAddress, userAgent);

    res.json({ success: true });
  } catch (error) {
    console.error("Update ticket status error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * GET /api/tickets/:id/attachments/:attachmentId
 * Download attachment
 */
router.get("/:id/attachments/:attachmentId", async (req: any, res) => {
  try {
    const ticketId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);

    const [attachments] = await query<{ file_data: Buffer; filename: string; file_type: string }>(
      `SELECT a.file_data, a.filename, a.file_type
       FROM dnsmanager_ticket_attachments a
       JOIN dnsmanager_tickets t ON t.id = a.ticket_id
       WHERE a.id = ? AND a.ticket_id = ? AND (t.user_id = ? OR ? = 'superadmin')`,
      [attachmentId, ticketId, req.session.userId, req.session.role]
    );

    if (attachments.length === 0) {
      return res.status(404).json({ message: "Attachment not found" });
    }

    const attachment = attachments[0];

    res.setHeader("Content-Type", attachment.file_type);
    res.setHeader("Content-Disposition", `attachment; filename="${attachment.filename}"`);
    res.send(attachment.file_data);
  } catch (error) {
    console.error("Download attachment error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
