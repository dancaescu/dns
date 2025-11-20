const TOKEN_KEY = "dnsmanager_token";
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

let authToken: string | null = localStorage.getItem(TOKEN_KEY);

export interface LoginResponse {
  token: string;
  user: { id: number; username: string; role: string };
}

export function getToken() {
  return authToken;
}

export function setToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }
  if (response.status === 204) {
    return null as T;
  }
  return response.json();
}

export async function login(username: string, password: string) {
  const data = await apiRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
  return data;
}

export function getCloudflareZone<T = any>(zoneId: number) {
  return apiRequest<T>(`/cloudflare/zones/${zoneId}`);
}

export function getCloudflareZoneRecords<T = any>(zoneId: number) {
  return apiRequest<T>(`/cloudflare/zones/${zoneId}/records`);
}

export function getCloudflareZoneLoadBalancers<T = any>(zoneId: number) {
  return apiRequest<T>(`/cloudflare/zones/${zoneId}/load-balancers`);
}

export function syncCloudflareZone(zoneId: number, mode?: string) {
  return apiRequest(`/cloudflare/zones/${zoneId}/sync`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export function createCloudflareRecord(zoneId: number, record: any, syncRemote: boolean) {
  return apiRequest(`/cloudflare/zones/${zoneId}/records`, {
    method: "POST",
    body: JSON.stringify({ record, syncRemote }),
  });
}

export function updateCloudflareRecord(recordId: number, record: any, syncRemote: boolean) {
  return apiRequest(`/cloudflare/records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify({ record, syncRemote }),
  });
}

export function deleteCloudflareRecord(recordId: number, syncRemote: boolean) {
  return apiRequest(`/cloudflare/records/${recordId}`, {
    method: "DELETE",
    body: JSON.stringify({ syncRemote }),
  });
}

export function createCloudflareLoadBalancer(zoneId: number, loadBalancer: any, syncRemote: boolean) {
  return apiRequest(`/cloudflare/zones/${zoneId}/load-balancers`, {
    method: "POST",
    body: JSON.stringify({ loadBalancer, syncRemote }),
  });
}

export function updateCloudflareLoadBalancer(lbId: number, loadBalancer: any, syncRemote: boolean) {
  return apiRequest(`/cloudflare/load-balancers/${lbId}`, {
    method: "PUT",
    body: JSON.stringify({ loadBalancer, syncRemote }),
  });
}

export function deleteCloudflareLoadBalancer(lbId: number, syncRemote: boolean) {
  return apiRequest(`/cloudflare/load-balancers/${lbId}`, {
    method: "DELETE",
    body: JSON.stringify({ syncRemote }),
  });
}
