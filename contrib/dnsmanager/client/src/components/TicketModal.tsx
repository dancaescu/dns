import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { apiRequest } from "../lib/api";

interface TicketModalProps {
  isOpen: boolean;
  onClose: () => void;
  screenshotData: string | null;
  pageUrl: string;
}

export function TicketModal({ isOpen, onClose, screenshotData, pageUrl }: TicketModalProps) {
  const [incidentDate, setIncidentDate] = useState("");
  const [incidentHour, setIncidentHour] = useState("");
  const [incidentType, setIncidentType] = useState<"RR" | "SOA" | "Cloudflare" | "API" | "Other">("Other");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Set default date/time when modal opens
  useEffect(() => {
    if (isOpen) {
      const now = new Date();
      setIncidentDate(now.toISOString().split("T")[0]);
      setIncidentHour(now.toTimeString().split(" ")[0].substring(0, 5));
      setError(null);
      setSuccess(false);
    }
  }, [isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await apiRequest("/tickets", {
        method: "POST",
        body: JSON.stringify({
          incident_date: incidentDate,
          incident_hour: incidentHour,
          incident_type: incidentType,
          subject,
          message,
          priority,
          screenshot_data: screenshotData,
          page_url: pageUrl,
        }),
      });

      setSuccess(true);
      setTimeout(() => {
        onClose();
        // Reset form
        setIncidentDate("");
        setIncidentHour("");
        setIncidentType("Other");
        setSubject("");
        setMessage("");
        setPriority("medium");
        setSuccess(false);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit ticket");
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-6 py-4">
          <h2 className="text-xl font-semibold">Create Support Ticket</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={loading}
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {screenshotData && (
            <div className="rounded-md border bg-green-50 p-3">
              <p className="text-sm text-green-700">
                ✓ Screenshot of the current page has been captured automatically
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {success && (
            <div className="rounded-md border border-green-200 bg-green-50 p-3">
              <p className="text-sm text-green-700">Ticket submitted successfully!</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="incident_date">Incident Date *</Label>
              <Input
                id="incident_date"
                type="date"
                value={incidentDate}
                onChange={(e) => setIncidentDate(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="incident_hour">Incident Time *</Label>
              <Input
                id="incident_hour"
                type="time"
                value={incidentHour}
                onChange={(e) => setIncidentHour(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="incident_type">Incident Type *</Label>
              <select
                id="incident_type"
                className="w-full rounded-md border px-3 py-2"
                value={incidentType}
                onChange={(e) => setIncidentType(e.target.value as any)}
                required
              >
                <option value="RR">RR (Resource Record)</option>
                <option value="SOA">SOA</option>
                <option value="Cloudflare">Cloudflare</option>
                <option value="API">API</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <Label htmlFor="priority">Priority *</Label>
              <select
                id="priority"
                className="w-full rounded-md border px-3 py-2"
                value={priority}
                onChange={(e) => setPriority(e.target.value as any)}
                required
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="subject">Subject *</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Brief description of the issue"
              required
              maxLength={500}
            />
          </div>

          <div>
            <Label htmlFor="message">Message *</Label>
            <textarea
              id="message"
              className="min-h-32 w-full rounded-md border px-3 py-2"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Detailed description of the issue"
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || success}>
              {loading ? "Submitting..." : "Submit Ticket"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
