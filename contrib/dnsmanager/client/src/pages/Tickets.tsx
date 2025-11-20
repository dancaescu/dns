import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { apiRequest } from "../lib/api";
import { useNavigate } from "react-router-dom";

export function Tickets({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const [incidentDate, setIncidentDate] = useState("");
  const [incidentHour, setIncidentHour] = useState("");
  const [incidentType, setIncidentType] = useState<"RR" | "SOA" | "Cloudflare" | "API" | "Other">("Other");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function captureScreenshot() {
    try {
      // Use modern browser screenshot API if available
      if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { mediaSource: "screen" } as any,
        });

        // Create video element to capture frame
        const video = document.createElement("video");
        video.srcObject = stream;
        video.play();

        // Wait for video to be ready
        await new Promise((resolve) => {
          video.onloadedmetadata = resolve;
        });

        // Create canvas and capture frame
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          const dataUrl = canvas.toDataURL("image/png");
          setScreenshot(dataUrl);
        }

        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());
      } else {
        alert("Screenshot capture is not supported in this browser");
      }
    } catch (error) {
      console.error("Screenshot capture failed:", error);
      alert("Failed to capture screenshot. You can still submit the ticket without it.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!incidentDate || !incidentHour || !subject || !message) {
      alert("Please fill in all required fields");
      return;
    }

    setLoading(true);
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
          screenshot_data: screenshot || undefined,
        }),
      });

      alert("Ticket submitted successfully! You will receive an email confirmation.");

      // Reset form
      setIncidentDate("");
      setIncidentHour("");
      setIncidentType("Other");
      setSubject("");
      setMessage("");
      setPriority("medium");
      setScreenshot(null);

      // Navigate back to dashboard
      navigate("/");
    } catch (error) {
      console.error("Failed to submit ticket:", error);
      alert("Failed to submit ticket. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Submit Support Ticket</h1>
          <p className="text-sm text-muted-foreground">Report an issue with DNS Manager</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate("/")}>
            Back to Dashboard
          </Button>
          <Button variant="outline" onClick={onLogout}>
            Logout
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Ticket Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="incident-date">Incident Date *</Label>
                  <Input
                    id="incident-date"
                    type="text"
                    value={incidentDate}
                    onChange={(e) => setIncidentDate(e.target.value)}
                    placeholder="MM/DD/YYYY"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="incident-hour">Incident Time *</Label>
                  <Input
                    id="incident-hour"
                    type="time"
                    value={incidentHour}
                    onChange={(e) => setIncidentHour(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="incident-type">Incident Type *</Label>
                  <select
                    id="incident-type"
                    value={incidentType}
                    onChange={(e) => setIncidentType(e.target.value as any)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    required
                  >
                    <option value="Other">Other</option>
                    <option value="RR">RR (Resource Records)</option>
                    <option value="SOA">SOA (Start of Authority)</option>
                    <option value="Cloudflare">Cloudflare</option>
                    <option value="API">API</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="priority">Priority</Label>
                  <select
                    id="priority"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as any)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Brief description of the issue"
                  maxLength={500}
                  required
                />
              </div>

              <div>
                <Label htmlFor="message">Message *</Label>
                <textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Detailed description of the issue"
                  rows={6}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  required
                />
              </div>

              <div>
                <Label>Screenshot (Optional)</Label>
                <div className="mt-2 space-y-2">
                  {!screenshot ? (
                    <Button type="button" variant="outline" onClick={captureScreenshot}>
                      📷 Capture Screenshot
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <img
                        src={screenshot}
                        alt="Screenshot preview"
                        className="max-w-full rounded border"
                        style={{ maxHeight: "300px" }}
                      />
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={captureScreenshot}>
                          Retake Screenshot
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setScreenshot(null)}
                        >
                          Remove Screenshot
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Capture a screenshot of the issue to help us understand the problem better
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => navigate("/")} disabled={loading}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? "Submitting..." : "Submit Ticket"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
