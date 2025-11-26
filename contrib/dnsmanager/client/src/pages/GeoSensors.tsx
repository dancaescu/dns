import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { toast, ToastContainer } from "../components/ui/toast";
import { apiRequest } from "../lib/api";
import { MapPin, Plus, Edit, Trash, RefreshCw, Upload, Download } from "lucide-react";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface Sensor {
  id: number;
  location_code: string;
  location_name: string;
  is_active: boolean;
  is_default: boolean;
  last_seen?: string;
  health_status?: string;
  created_by_user_id?: number;
}

interface SensorScriptVersion {
  id: number;
  version: string;
  is_active: boolean;
  min_python_version: string;
  changelog?: string;
  date_created: string;
}

interface GeoSensorsProps {
  user: User;
  onLogout: () => void;
}

export function GeoSensors({ user, onLogout }: GeoSensorsProps) {
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [scriptVersions, setScriptVersions] = useState<SensorScriptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showScriptModal, setShowScriptModal] = useState(false);
  const [editingSensor, setEditingSensor] = useState<Sensor | null>(null);

  const isSuperadmin = user.role === "superadmin";

  // Form state
  const [locationCode, setLocationCode] = useState("");
  const [locationName, setLocationName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isDefault, setIsDefault] = useState(false);

  // Script version form state
  const [scriptVersion, setScriptVersion] = useState("");
  const [scriptContent, setScriptContent] = useState("");
  const [prerequisitesScript, setPrerequisitesScript] = useState("");
  const [changelog, setChangelog] = useState("");
  const [minPythonVersion, setMinPythonVersion] = useState("3.7");
  const [makeActive, setMakeActive] = useState(true);

  useEffect(() => {
    loadSensors();
    if (isSuperadmin) {
      loadScriptVersions();
    }
  }, [isSuperadmin]);

  const loadSensors = async () => {
    try {
      const data = await apiRequest<Sensor[]>("/sensors");
      setSensors(data);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to load sensors",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const loadScriptVersions = async () => {
    try {
      const data = await apiRequest<SensorScriptVersion[]>("/sensors/script/versions");
      setScriptVersions(data || []);
    } catch (error: any) {
      console.error("Failed to load script versions:", error);
    }
  };

  const handleAddSensor = async () => {
    if (!locationCode || !locationName) {
      toast({
        title: "Validation Error",
        description: "Location code and name are required",
        variant: "destructive",
      });
      return;
    }

    try {
      await apiRequest("/sensors", {
        method: "POST",
        body: JSON.stringify({
          location_code: locationCode,
          location_name: locationName,
          is_active: isActive,
          is_default: isDefault,
        }),
      });

      toast({
        title: "Success",
        description: "Sensor added successfully",
      });

      setShowAddModal(false);
      resetForm();
      loadSensors();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add sensor",
        variant: "destructive",
      });
    }
  };

  const handleUpdateSensor = async () => {
    if (!editingSensor) return;

    try {
      await apiRequest(`/sensors/${editingSensor.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          location_name: locationName,
          is_active: isActive,
          is_default: isDefault,
        }),
      });

      toast({
        title: "Success",
        description: "Sensor updated successfully",
      });

      setEditingSensor(null);
      resetForm();
      loadSensors();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to update sensor",
        variant: "destructive",
      });
    }
  };

  const handleDeleteSensor = async (sensorId: number) => {
    if (!confirm("Are you sure you want to delete this sensor?")) return;

    try {
      await apiRequest(`/sensors/${sensorId}`, {
        method: "DELETE",
      });

      toast({
        title: "Success",
        description: "Sensor deleted successfully",
      });

      loadSensors();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to delete sensor",
        variant: "destructive",
      });
    }
  };

  const handleUploadScript = async () => {
    if (!scriptVersion || !scriptContent) {
      toast({
        title: "Validation Error",
        description: "Version and script content are required",
        variant: "destructive",
      });
      return;
    }

    try {
      await apiRequest("/sensors/script/upload", {
        method: "POST",
        body: JSON.stringify({
          version: scriptVersion,
          script_content: scriptContent,
          prerequisites_script: prerequisitesScript || null,
          changelog: changelog || null,
          min_python_version: minPythonVersion,
          make_active: makeActive,
        }),
      });

      toast({
        title: "Success",
        description: "Script version uploaded successfully",
      });

      setShowScriptModal(false);
      resetScriptForm();
      loadScriptVersions();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to upload script",
        variant: "destructive",
      });
    }
  };

  const handleDownloadScript = async (versionId: number) => {
    try {
      const data = await apiRequest<{ version: string; script_content: string }>(
        `/sensors/script/${versionId}`
      );

      // Create a download link
      const blob = new Blob([data.script_content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sensor-api-${data.version}.py`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Success",
        description: "Script downloaded",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to download script",
        variant: "destructive",
      });
    }
  };

  const resetForm = () => {
    setLocationCode("");
    setLocationName("");
    setIsActive(true);
    setIsDefault(false);
    setShowAddModal(false);
    setEditingSensor(null);
  };

  const resetScriptForm = () => {
    setScriptVersion("");
    setScriptContent("");
    setPrerequisitesScript("");
    setChangelog("");
    setMinPythonVersion("3.7");
    setMakeActive(true);
  };

  const startEdit = (sensor: Sensor) => {
    setEditingSensor(sensor);
    setLocationCode(sensor.location_code);
    setLocationName(sensor.location_name);
    setIsActive(sensor.is_active);
    setIsDefault(sensor.is_default);
  };

  if (loading) {
    return (
      <Layout user={user} onLogout={onLogout} title="GeoIP Sensors">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      user={user}
      onLogout={onLogout}
      title="GeoIP Sensors"
      subtitle="Manage geographic DNS sensors for location-aware responses"
    >
      <ToastContainer />

      {/* Sensors Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Geographic Sensors
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Sensors learn Cloudflare proxy IPs from different geographic locations
            </p>
          </div>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Sensor
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location Code</TableHead>
                <TableHead>Location Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sensors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No sensors configured
                  </TableCell>
                </TableRow>
              ) : (
                sensors.map((sensor) => (
                  <TableRow key={sensor.id}>
                    <TableCell className="font-mono">{sensor.location_code}</TableCell>
                    <TableCell>
                      {sensor.location_name}
                      {sensor.is_default && (
                        <Badge variant="secondary" className="ml-2">
                          Default
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sensor.is_active ? "success" : "secondary"}>
                        {sensor.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          sensor.health_status === "healthy"
                            ? "success"
                            : sensor.health_status === "warning"
                            ? "warning"
                            : "error"
                        }
                      >
                        {sensor.health_status || "Unknown"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {sensor.last_seen
                        ? new Date(sensor.last_seen).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(sensor)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        {isSuperadmin && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDeleteSensor(sensor.id)}
                          >
                            <Trash className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Script Versions (Superadmin Only) */}
      {isSuperadmin && (
        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Sensor Script Versions</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Manage sensor.py versions for auto-update functionality
              </p>
            </div>
            <Button onClick={() => setShowScriptModal(true)}>
              <Upload className="h-4 w-4 mr-2" />
              Upload New Version
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Python Version</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scriptVersions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No script versions uploaded
                    </TableCell>
                  </TableRow>
                ) : (
                  scriptVersions.map((version) => (
                    <TableRow key={version.id}>
                      <TableCell className="font-mono">{version.version}</TableCell>
                      <TableCell>
                        <Badge variant={version.is_active ? "success" : "secondary"}>
                          {version.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>{version.min_python_version}+</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(version.date_created).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownloadScript(version.id)}
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Add/Edit Sensor Modal */}
      {(showAddModal || editingSensor) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>{editingSensor ? "Edit Sensor" : "Add New Sensor"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="location-code">Location Code</Label>
                <Input
                  id="location-code"
                  value={locationCode}
                  onChange={(e) => setLocationCode(e.target.value)}
                  placeholder="e.g., na, eu, apac"
                  disabled={!!editingSensor}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  2-6 character identifier
                </p>
              </div>

              <div>
                <Label htmlFor="location-name">Location Name</Label>
                <Input
                  id="location-name"
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="e.g., North America"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is-active"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="rounded"
                />
                <Label htmlFor="is-active">Active</Label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is-default"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="rounded"
                />
                <Label htmlFor="is-default">Set as default sensor</Label>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={editingSensor ? handleUpdateSensor : handleAddSensor}
                  className="flex-1"
                >
                  {editingSensor ? "Update" : "Add"}
                </Button>
                <Button variant="outline" onClick={resetForm} className="flex-1">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Upload Script Modal */}
      {showScriptModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto p-4">
          <Card className="w-full max-w-2xl my-8">
            <CardHeader>
              <CardTitle>Upload New Script Version</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="script-version">Version</Label>
                <Input
                  id="script-version"
                  value={scriptVersion}
                  onChange={(e) => setScriptVersion(e.target.value)}
                  placeholder="e.g., 1.1.0"
                />
              </div>

              <div>
                <Label htmlFor="script-content">Script Content (Python)</Label>
                <textarea
                  id="script-content"
                  value={scriptContent}
                  onChange={(e) => setScriptContent(e.target.value)}
                  placeholder="Paste the complete sensor-api.py script here..."
                  className="w-full h-64 p-2 border rounded font-mono text-sm"
                />
              </div>

              <div>
                <Label htmlFor="prerequisites">Prerequisites Script (Optional)</Label>
                <textarea
                  id="prerequisites"
                  value={prerequisitesScript}
                  onChange={(e) => setPrerequisitesScript(e.target.value)}
                  placeholder="#!/bin/bash&#10;pip3 install dnspython requests&#10;# Additional setup commands..."
                  className="w-full h-24 p-2 border rounded font-mono text-sm"
                />
              </div>

              <div>
                <Label htmlFor="changelog">Changelog (Optional)</Label>
                <textarea
                  id="changelog"
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  placeholder="- Added feature X&#10;- Fixed bug Y&#10;- Improved performance Z"
                  className="w-full h-24 p-2 border rounded text-sm"
                />
              </div>

              <div>
                <Label htmlFor="min-python">Minimum Python Version</Label>
                <Input
                  id="min-python"
                  value={minPythonVersion}
                  onChange={(e) => setMinPythonVersion(e.target.value)}
                  placeholder="3.7"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="make-active"
                  checked={makeActive}
                  onChange={(e) => setMakeActive(e.target.checked)}
                  className="rounded"
                />
                <Label htmlFor="make-active">
                  Activate this version (deactivates others)
                </Label>
              </div>

              <div className="flex gap-2">
                <Button onClick={handleUploadScript} className="flex-1">
                  Upload
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowScriptModal(false);
                    resetScriptForm();
                  }}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </Layout>
  );
}
