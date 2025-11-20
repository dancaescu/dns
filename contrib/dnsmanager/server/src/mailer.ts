import nodemailer from "nodemailer";
import { promises as fs } from "fs";
import path from "path";
import { query } from "./db.js";

interface MailConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;
  from_email?: string;
  from_name?: string;
}

/**
 * Load mail configuration from /etc/mydns/mail.ini or from database settings
 */
async function getMailConfig(): Promise<MailConfig> {
  // Try to load from database settings first
  const [settings] = await query<{ setting_key: string; setting_value: string; is_encrypted: number }>(
    `SELECT setting_key, setting_value, is_encrypted
     FROM dnsmanager_settings
     WHERE setting_key IN ('smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_email', 'smtp_from_name')`
  );

  const settingsMap: any = {};
  settings.forEach((row) => {
    const key = row.setting_key.replace("smtp_", "");
    settingsMap[key] = row.setting_value;
  });

  // If we have database settings, use those
  if (settingsMap.host && settingsMap.user && settingsMap.pass) {
    return {
      smtp_host: settingsMap.host,
      smtp_port: parseInt(settingsMap.port || "587"),
      smtp_user: settingsMap.user,
      smtp_pass: settingsMap.pass,
      from_email: settingsMap.from_email || settingsMap.user,
      from_name: settingsMap.from_name || "DNS Manager",
    };
  }

  // Fall back to /etc/mydns/mail.ini
  try {
    const iniPath = "/etc/mydns/mail.ini";
    const content = await fs.readFile(iniPath, "utf-8");
    const config: any = {};

    content.split("\n").forEach((line) => {
      line = line.trim();
      if (line && !line.startsWith("#")) {
        const [key, value] = line.split("=", 2);
        if (key && value) {
          config[key.trim()] = value.trim();
        }
      }
    });

    return {
      smtp_host: config.smtp_host || "localhost",
      smtp_port: parseInt(config.smtp_port || "587"),
      smtp_user: config.smtp_user || "",
      smtp_pass: config.smtp_pass || "",
      from_email: config.smtp_user || "",
      from_name: "DNS Manager",
    };
  } catch (error) {
    console.error("Failed to load mail configuration:", error);
    throw new Error("Mail configuration not found. Please configure SMTP settings.");
  }
}

/**
 * Send an email
 */
export async function sendEmail(options: {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{ filename: string; path?: string; content?: Buffer | string }>;
  cc?: string | string[];
  replyTo?: string;
}): Promise<void> {
  const config = await getMailConfig();

  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port,
    secure: config.smtp_port === 465, // true for 465, false for other ports
    auth: {
      user: config.smtp_user,
      pass: config.smtp_pass,
    },
  });

  const mailOptions: any = {
    from: `"${config.from_name}" <${config.from_email}>`,
    to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
    subject: options.subject,
  };

  if (options.html) {
    mailOptions.html = options.html;
  }

  if (options.text) {
    mailOptions.text = options.text;
  }

  if (options.attachments) {
    mailOptions.attachments = options.attachments;
  }

  if (options.cc) {
    mailOptions.cc = Array.isArray(options.cc) ? options.cc.join(", ") : options.cc;
  }

  if (options.replyTo) {
    mailOptions.replyTo = options.replyTo;
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully to:", mailOptions.to);
  } catch (error) {
    console.error("Failed to send email:", error);
    throw error;
  }
}

/**
 * Send ticket notification email
 */
export async function sendTicketNotification(ticketData: {
  ticketId: number;
  userEmail: string;
  userName: string;
  incidentType: string;
  incidentDate: string;
  incidentHour: string;
  subject: string;
  message: string;
  adminEmail: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}): Promise<void> {
  const html = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2563eb;">New Support Ticket #${ticketData.ticketId}</h2>

          <div style="background-color: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>From:</strong> ${ticketData.userName} (${ticketData.userEmail})</p>
            <p style="margin: 5px 0;"><strong>Incident Type:</strong> ${ticketData.incidentType}</p>
            <p style="margin: 5px 0;"><strong>Incident Date:</strong> ${ticketData.incidentDate}</p>
            <p style="margin: 5px 0;"><strong>Incident Time:</strong> ${ticketData.incidentHour}</p>
            <p style="margin: 5px 0;"><strong>Subject:</strong> ${ticketData.subject}</p>
          </div>

          <div style="margin: 20px 0;">
            <h3 style="color: #374151;">Message:</h3>
            <div style="background-color: #ffffff; border: 1px solid #e5e7eb; padding: 15px; border-radius: 5px; white-space: pre-wrap;">
${ticketData.message}
            </div>
          </div>

          ${
            ticketData.attachments && ticketData.attachments.length > 0
              ? `
          <div style="margin: 20px 0;">
            <h3 style="color: #374151;">Attachments:</h3>
            <ul style="list-style-type: none; padding: 0;">
              ${ticketData.attachments.map((att) => `<li>📎 ${att.filename}</li>`).join("")}
            </ul>
          </div>
          `
              : ""
          }

          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
            <p style="color: #6b7280; font-size: 14px;">
              This ticket was submitted through the DNS Manager support system.<br>
              Please reply to this email or log in to the admin panel to respond.
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  const attachments = ticketData.attachments?.map((att) => ({
    filename: att.filename,
    content: att.content,
    contentType: att.contentType,
  }));

  await sendEmail({
    to: ticketData.adminEmail,
    subject: `[DNS Manager Ticket #${ticketData.ticketId}] ${ticketData.subject}`,
    html,
    replyTo: ticketData.userEmail,
    attachments,
  });
}
