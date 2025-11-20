import fetch from "node-fetch";
import { query } from "./db.js";

interface MultitelSettings {
  api_user: string;
  api_pass: string;
  api_url: string;
}

/**
 * Load Multitel API settings from database
 */
async function getMultitelSettings(): Promise<MultitelSettings> {
  const [rows] = await query<{ setting_key: string; setting_value: string; is_encrypted: number }>(
    `SELECT setting_key, setting_value, is_encrypted
     FROM dnsadmin_settings
     WHERE setting_key IN ('multitel_api_user', 'multitel_api_pass', 'multitel_api_url')`
  );

  const settings: any = {};
  rows.forEach((row) => {
    const key = row.setting_key.replace("multitel_", "");
    settings[key] = row.setting_value;
  });

  if (!settings.api_user || !settings.api_pass) {
    throw new Error("Multitel API credentials not configured");
  }

  return {
    api_user: settings.api_user,
    api_pass: settings.api_pass,
    api_url: settings.api_url || "https://api.multitel.net/v3/sendcode",
  };
}

/**
 * Send 2FA code via SMS using Multitel API
 */
export async function sendSMS(phoneNumber: string, code: string): Promise<void> {
  const settings = await getMultitelSettings();

  const message = `Your DNS Manager verification code is: ${code}. This code expires in 10 minutes.`;

  const response = await fetch(settings.api_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user: settings.api_user,
      pass: settings.api_pass,
      to: phoneNumber,
      message: message,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Multitel API error: ${errorText}`);
  }

  const result: any = await response.json();
  if (!result.success) {
    throw new Error(`Multitel API failed: ${result.error || "Unknown error"}`);
  }
}

/**
 * Send 2FA code via email using Multitel API
 */
export async function sendEmail(email: string, code: string): Promise<void> {
  const settings = await getMultitelSettings();

  const subject = "DNS Manager - Verification Code";
  const message = `
    <html>
      <body>
        <h2>DNS Manager Verification Code</h2>
        <p>Your verification code is: <strong>${code}</strong></p>
        <p>This code expires in 10 minutes.</p>
        <p>If you did not request this code, please ignore this email.</p>
      </body>
    </html>
  `;

  const response = await fetch(settings.api_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user: settings.api_user,
      pass: settings.api_pass,
      to: email,
      subject: subject,
      message: message,
      type: "email",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Multitel API error: ${errorText}`);
  }

  const result: any = await response.json();
  if (!result.success) {
    throw new Error(`Multitel API failed: ${result.error || "Unknown error"}`);
  }
}

/**
 * Send 2FA code based on method (email or sms)
 */
export async function send2FACode(method: "email" | "sms", contact: string, code: string): Promise<void> {
  try {
    if (method === "sms") {
      await sendSMS(contact, code);
    } else if (method === "email") {
      await sendEmail(contact, code);
    } else {
      throw new Error(`Unsupported 2FA method: ${method}`);
    }
  } catch (error) {
    console.error(`Failed to send 2FA code via ${method}:`, error);
    throw error;
  }
}
