import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Layout } from "../components/Layout";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

export default function ApiDocs({ onLogout, user }: { onLogout: () => void; user: User | null }) {
  return (
    <Layout
      user={user}
      onLogout={onLogout}
      breadcrumbs={[{ label: "API Documentation" }]}
    >
      <div className="mx-auto max-w-7xl space-y-6">

      {/* Authentication */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
          <CardDescription>
            All API requests require authentication using API tokens
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold mb-2">Creating an API Token</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Navigate to your account settings to create a new API token. You'll need to:
            </p>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              <li>Choose a descriptive name for your token</li>
              <li>Select the required scopes (permissions)</li>
              <li>Optionally set an expiration date</li>
              <li>Copy the token immediately - it won't be shown again!</li>
            </ol>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-2">Using Your Token</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Include your token in the Authorization header of every request:
            </p>
            <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto">
              <code>Authorization: Bearer dnsm_your_token_here</code>
            </pre>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-2">Available Scopes</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">*</span>
                <span className="ml-2 text-muted-foreground">All permissions (superadmin)</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">zones:read</span>
                <span className="ml-2 text-muted-foreground">View Cloudflare zones</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">zones:write</span>
                <span className="ml-2 text-muted-foreground">Create/modify Cloudflare zones</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">records:read</span>
                <span className="ml-2 text-muted-foreground">View DNS records</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">records:write</span>
                <span className="ml-2 text-muted-foreground">Create/modify DNS records</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">soa:read</span>
                <span className="ml-2 text-muted-foreground">View SOA records</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">soa:write</span>
                <span className="ml-2 text-muted-foreground">Create/modify/delete SOA records</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">rr:read</span>
                <span className="ml-2 text-muted-foreground">View RR records</span>
              </div>
              <div>
                <span className="font-mono bg-slate-100 px-2 py-1 rounded">rr:write</span>
                <span className="ml-2 text-muted-foreground">Create/modify/delete RR records</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Cloudflare Zones */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Cloudflare Zones</CardTitle>
          <CardDescription>Manage Cloudflare DNS zones</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Create Zone */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Create Zone</h3>
            <div className="mb-3">
              <span className="font-mono bg-green-100 text-green-800 px-2 py-1 rounded text-sm">POST</span>
              <span className="ml-2 font-mono text-sm">/api/v1/zones</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: zones:write</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X POST http://localhost:4000/api/v1/zones \\
  -H "Authorization: Bearer dnsm_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "account_id": 1,
    "zone_name": "example.com",
    "jump_start": true,
    "zone_type": "full"
  }'`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/zones';

$data = [
    'account_id' => 1,
    'zone_name' => 'example.com',
    'jump_start' => true,
    'zone_type' => 'full'
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token,
    'Content-Type: application/json'
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/zones'

headers = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json'
}

data = {
    'account_id': 1,
    'zone_name': 'example.com',
    'jump_start': True,
    'zone_type': 'full'
}

response = requests.post(url, json=data, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones';

const data = {
  account_id: 1,
  zone_name: 'example.com',
  jump_start: true,
  zone_type: 'full'
};

axios.post(url, data, {
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones';

const data = {
  account_id: 1,
  zone_name: 'example.com',
  jump_start: true,
  zone_type: 'full'
};

fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;
import org.json.JSONObject;

public class CreateZone {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/zones";

        JSONObject data = new JSONObject();
        data.put("account_id", 1);
        data.put("zone_name", "example.com");
        data.put("jump_start", true);
        data.put("zone_type", "full");

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(data.toString()))
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* Get Zone */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Get Zone Details</h3>
            <div className="mb-3">
              <span className="font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">GET</span>
              <span className="ml-2 font-mono text-sm">/api/v1/zones/:id</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: zones:read</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X GET http://localhost:4000/api/v1/zones/1 \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/zones/1';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/zones/1'

headers = {
    'Authorization': f'Bearer {token}'
}

response = requests.get(url, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones/1';

axios.get(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones/1';

fetch(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class GetZone {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/zones/1";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .GET()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* List Zones */}
          <div>
            <h3 className="text-lg font-semibold mb-2">List Zones</h3>
            <div className="mb-3">
              <span className="font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">GET</span>
              <span className="ml-2 font-mono text-sm">/api/v1/zones</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: zones:read</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Query parameters: <code>account_id</code> (optional), <code>search</code> (optional)
            </p>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X GET "http://localhost:4000/api/v1/zones?account_id=1&search=example" \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/zones?account_id=1&search=example';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/zones'

headers = {
    'Authorization': f'Bearer {token}'
}

params = {
    'account_id': 1,
    'search': 'example'
}

response = requests.get(url, headers=headers, params=params)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones';

axios.get(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  },
  params: {
    account_id: 1,
    search: 'example'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones?account_id=1&search=example';

fetch(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class ListZones {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/zones?account_id=1&search=example";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .GET()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* List Zone Records */}
          <div>
            <h3 className="text-lg font-semibold mb-2">List Zone DNS Records</h3>
            <div className="mb-3">
              <span className="font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">GET</span>
              <span className="ml-2 font-mono text-sm">/api/v1/zones/:zoneId/records</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: records:read</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X GET http://localhost:4000/api/v1/zones/1/records \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/zones/1/records';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/zones/1/records'

headers = {
    'Authorization': f'Bearer {token}'
}

response = requests.get(url, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones/1/records';

axios.get(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/zones/1/records';

fetch(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class ListZoneRecords {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/zones/1/records";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .GET()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* SOA Records */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>SOA Records</CardTitle>
          <CardDescription>Manage Start of Authority records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* List SOA */}
          <div>
            <h3 className="text-lg font-semibold mb-2">List SOA Records</h3>
            <div className="mb-3">
              <span className="font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">GET</span>
              <span className="ml-2 font-mono text-sm">/api/v1/soa</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: soa:read</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Query parameters: <code>limit</code> (default: 100, max: 1000), <code>offset</code> (default: 0), <code>search</code> (optional)
            </p>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X GET "http://localhost:4000/api/v1/soa?limit=50&offset=0&search=example" \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/soa?limit=50&offset=0&search=example';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/soa'

headers = {
    'Authorization': f'Bearer {token}'
}

params = {
    'limit': 50,
    'offset': 0,
    'search': 'example'
}

response = requests.get(url, headers=headers, params=params)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa';

axios.get(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  },
  params: {
    limit: 50,
    offset: 0,
    search: 'example'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa?limit=50&offset=0&search=example';

fetch(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class ListSOA {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/soa?limit=50&offset=0&search=example";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .GET()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* Create SOA */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Create SOA Record</h3>
            <div className="mb-3">
              <span className="font-mono bg-green-100 text-green-800 px-2 py-1 rounded text-sm">POST</span>
              <span className="ml-2 font-mono text-sm">/api/v1/soa</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: soa:write</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X POST http://localhost:4000/api/v1/soa \\
  -H "Authorization: Bearer dnsm_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "origin": "example.com.",
    "ns": "ns1.example.com.",
    "mbox": "admin.example.com.",
    "serial": 1,
    "refresh": 28800,
    "retry": 7200,
    "expire": 604800,
    "minimum": 86400,
    "ttl": 86400,
    "active": "Y"
  }'`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/soa';

$data = [
    'origin' => 'example.com.',
    'ns' => 'ns1.example.com.',
    'mbox' => 'admin.example.com.',
    'serial' => 1,
    'refresh' => 28800,
    'retry' => 7200,
    'expire' => 604800,
    'minimum' => 86400,
    'ttl' => 86400,
    'active' => 'Y'
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token,
    'Content-Type: application/json'
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/soa'

headers = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json'
}

data = {
    'origin': 'example.com.',
    'ns': 'ns1.example.com.',
    'mbox': 'admin.example.com.',
    'serial': 1,
    'refresh': 28800,
    'retry': 7200,
    'expire': 604800,
    'minimum': 86400,
    'ttl': 86400,
    'active': 'Y'
}

response = requests.post(url, json=data, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa';

const data = {
  origin: 'example.com.',
  ns: 'ns1.example.com.',
  mbox: 'admin.example.com.',
  serial: 1,
  refresh: 28800,
  retry: 7200,
  expire: 604800,
  minimum: 86400,
  ttl: 86400,
  active: 'Y'
};

axios.post(url, data, {
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa';

const data = {
  origin: 'example.com.',
  ns: 'ns1.example.com.',
  mbox: 'admin.example.com.',
  serial: 1,
  refresh: 28800,
  retry: 7200,
  expire: 604800,
  minimum: 86400,
  ttl: 86400,
  active: 'Y'
};

fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;
import org.json.JSONObject;

public class CreateSOA {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/soa";

        JSONObject data = new JSONObject();
        data.put("origin", "example.com.");
        data.put("ns", "ns1.example.com.");
        data.put("mbox", "admin.example.com.");
        data.put("serial", 1);
        data.put("refresh", 28800);
        data.put("retry", 7200);
        data.put("expire", 604800);
        data.put("minimum", 86400);
        data.put("ttl", 86400);
        data.put("active", "Y");

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(data.toString()))
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* Update SOA */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Update SOA Record</h3>
            <div className="mb-3">
              <span className="font-mono bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-sm">PUT</span>
              <span className="ml-2 font-mono text-sm">/api/v1/soa/:id</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: soa:write</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              You can update individual fields - only include the fields you want to change.
            </p>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X PUT http://localhost:4000/api/v1/soa/1 \\
  -H "Authorization: Bearer dnsm_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "serial": 2,
    "ttl": 3600
  }'`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/soa/1';

$data = [
    'serial' => 2,
    'ttl' => 3600
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PUT');
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token,
    'Content-Type: application/json'
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/soa/1'

headers = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json'
}

data = {
    'serial': 2,
    'ttl': 3600
}

response = requests.put(url, json=data, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa/1';

const data = {
  serial: 2,
  ttl: 3600
};

axios.put(url, data, {
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa/1';

const data = {
  serial: 2,
  ttl: 3600
};

fetch(url, {
  method: 'PUT',
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;
import org.json.JSONObject;

public class UpdateSOA {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/soa/1";

        JSONObject data = new JSONObject();
        data.put("serial", 2);
        data.put("ttl", 3600);

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(data.toString()))
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* Delete SOA */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Delete SOA Record</h3>
            <div className="mb-3">
              <span className="font-mono bg-red-100 text-red-800 px-2 py-1 rounded text-sm">DELETE</span>
              <span className="ml-2 font-mono text-sm">/api/v1/soa/:id</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: soa:write</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X DELETE http://localhost:4000/api/v1/soa/1 \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/soa/1';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'DELETE');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

echo "HTTP Status: " . $httpCode; // Should be 204
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/soa/1'

headers = {
    'Authorization': f'Bearer {token}'
}

response = requests.delete(url, headers=headers)
print(f"HTTP Status: {response.status_code}")  # Should be 204`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa/1';

axios.delete(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => {
  console.log(\`HTTP Status: \${response.status}\`); // Should be 204
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/soa/1';

fetch(url, {
  method: 'DELETE',
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => {
  console.log(\`HTTP Status: \${response.status}\`); // Should be 204
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class DeleteSOA {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/soa/1";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .DELETE()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println("HTTP Status: " + response.statusCode()); // Should be 204
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* RR Records */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Resource Records (RR)</CardTitle>
          <CardDescription>Manage DNS resource records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Create RR */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Create Resource Record</h3>
            <div className="mb-3">
              <span className="font-mono bg-green-100 text-green-800 px-2 py-1 rounded text-sm">POST</span>
              <span className="ml-2 font-mono text-sm">/api/v1/rr</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: rr:write</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X POST http://localhost:4000/api/v1/rr \\
  -H "Authorization: Bearer dnsm_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "zone": 1,
    "name": "www.example.com.",
    "type": "A",
    "data": "192.0.2.1",
    "aux": 0,
    "ttl": 3600
  }'`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/rr';

$data = [
    'zone' => 1,
    'name' => 'www.example.com.',
    'type' => 'A',
    'data' => '192.0.2.1',
    'aux' => 0,
    'ttl' => 3600
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token,
    'Content-Type: application/json'
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/rr'

headers = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json'
}

data = {
    'zone': 1,
    'name': 'www.example.com.',
    'type': 'A',
    'data': '192.0.2.1',
    'aux': 0,
    'ttl': 3600
}

response = requests.post(url, json=data, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr';

const data = {
  zone: 1,
  name: 'www.example.com.',
  type: 'A',
  data: '192.0.2.1',
  aux: 0,
  ttl: 3600
};

axios.post(url, data, {
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr';

const data = {
  zone: 1,
  name: 'www.example.com.',
  type: 'A',
  data: '192.0.2.1',
  aux: 0,
  ttl: 3600
};

fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;
import org.json.JSONObject;

public class CreateRR {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/rr";

        JSONObject data = new JSONObject();
        data.put("zone", 1);
        data.put("name", "www.example.com.");
        data.put("type", "A");
        data.put("data", "192.0.2.1");
        data.put("aux", 0);
        data.put("ttl", 3600);

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(data.toString()))
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* List RR */}
          <div>
            <h3 className="text-lg font-semibold mb-2">List Resource Records</h3>
            <div className="mb-3">
              <span className="font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">GET</span>
              <span className="ml-2 font-mono text-sm">/api/v1/rr</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: rr:read</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Query parameters: <code>zone</code> (optional), <code>limit</code> (default: 100, max: 1000), <code>offset</code> (default: 0)
            </p>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X GET "http://localhost:4000/api/v1/rr?zone=1&limit=50&offset=0" \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/rr?zone=1&limit=50&offset=0';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/rr'

headers = {
    'Authorization': f'Bearer {token}'
}

params = {
    'zone': 1,
    'limit': 50,
    'offset': 0
}

response = requests.get(url, headers=headers, params=params)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr';

axios.get(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  },
  params: {
    zone: 1,
    limit: 50,
    offset: 0
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr?zone=1&limit=50&offset=0';

fetch(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class ListRR {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/rr?zone=1&limit=50&offset=0";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .GET()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* Update RR */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Update Resource Record</h3>
            <div className="mb-3">
              <span className="font-mono bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-sm">PUT</span>
              <span className="ml-2 font-mono text-sm">/api/v1/rr/:id</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: rr:write</span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              You can update individual fields - only include the fields you want to change.
            </p>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X PUT http://localhost:4000/api/v1/rr/1 \\
  -H "Authorization: Bearer dnsm_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": "192.0.2.2",
    "ttl": 7200
  }'`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/rr/1';

$data = [
    'data' => '192.0.2.2',
    'ttl' => 7200
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PUT');
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token,
    'Content-Type: application/json'
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
print_r($result);
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/rr/1'

headers = {
    'Authorization': f'Bearer {token}',
    'Content-Type': 'application/json'
}

data = {
    'data': '192.0.2.2',
    'ttl': 7200
}

response = requests.put(url, json=data, headers=headers)
result = response.json()
print(result)`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr/1';

const data = {
  data: '192.0.2.2',
  ttl: 7200
};

axios.put(url, data, {
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log(response.data);
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr/1';

const data = {
  data: '192.0.2.2',
  ttl: 7200
};

fetch(url, {
  method: 'PUT',
  headers: {
    'Authorization': \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
})
.then(response => response.json())
.then(result => {
  console.log(result);
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;
import org.json.JSONObject;

public class UpdateRR {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/rr/1";

        JSONObject data = new JSONObject();
        data.put("data", "192.0.2.2");
        data.put("ttl", 7200);

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(data.toString()))
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println(response.body());
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>

          {/* Delete RR */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Delete Resource Record</h3>
            <div className="mb-3">
              <span className="font-mono bg-red-100 text-red-800 px-2 py-1 rounded text-sm">DELETE</span>
              <span className="ml-2 font-mono text-sm">/api/v1/rr/:id</span>
              <span className="ml-3 text-sm text-muted-foreground">Required scope: rr:write</span>
            </div>

            <Tabs defaultValue="curl" className="w-full">
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="php">PHP</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="nodejs">Node.js</TabsTrigger>
                <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                <TabsTrigger value="java">Java</TabsTrigger>
              </TabsList>

              <TabsContent value="curl">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`curl -X DELETE http://localhost:4000/api/v1/rr/1 \\
  -H "Authorization: Bearer dnsm_your_token_here"`}
                </pre>
              </TabsContent>

              <TabsContent value="php">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`<?php
$token = 'dnsm_your_token_here';
$url = 'http://localhost:4000/api/v1/rr/1';

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'DELETE');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $token
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

echo "HTTP Status: " . $httpCode; // Should be 204
?>`}
                </pre>
              </TabsContent>

              <TabsContent value="python">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import requests

token = 'dnsm_your_token_here'
url = 'http://localhost:4000/api/v1/rr/1'

headers = {
    'Authorization': f'Bearer {token}'
}

response = requests.delete(url, headers=headers)
print(f"HTTP Status: {response.status_code}")  # Should be 204`}
                </pre>
              </TabsContent>

              <TabsContent value="nodejs">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const axios = require('axios');

const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr/1';

axios.delete(url, {
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => {
  console.log(\`HTTP Status: \${response.status}\`); // Should be 204
})
.catch(error => {
  console.error('Error:', error.response?.data || error.message);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="javascript">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`const token = 'dnsm_your_token_here';
const url = 'http://localhost:4000/api/v1/rr/1';

fetch(url, {
  method: 'DELETE',
  headers: {
    'Authorization': \`Bearer \${token}\`
  }
})
.then(response => {
  console.log(\`HTTP Status: \${response.status}\`); // Should be 204
})
.catch(error => {
  console.error('Error:', error);
});`}
                </pre>
              </TabsContent>

              <TabsContent value="java">
                <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`import java.net.http.*;
import java.net.URI;

public class DeleteRR {
    public static void main(String[] args) throws Exception {
        String token = "dnsm_your_token_here";
        String url = "http://localhost:4000/api/v1/rr/1";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Authorization", "Bearer " + token)
            .DELETE()
            .build();

        HttpResponse<String> response = client.send(request,
            HttpResponse.BodyHandlers.ofString());

        System.out.println("HTTP Status: " + response.statusCode()); // Should be 204
    }
}`}
                </pre>
              </TabsContent>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* Error Handling */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Error Handling</CardTitle>
          <CardDescription>Understanding API error responses</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold mb-2">HTTP Status Codes</h3>
            <ul className="space-y-2 text-sm">
              <li><span className="font-mono bg-green-100 text-green-800 px-2 py-1 rounded">200</span> - Success</li>
              <li><span className="font-mono bg-green-100 text-green-800 px-2 py-1 rounded">201</span> - Created</li>
              <li><span className="font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded">204</span> - No Content (delete success)</li>
              <li><span className="font-mono bg-yellow-100 text-yellow-800 px-2 py-1 rounded">400</span> - Bad Request (validation error)</li>
              <li><span className="font-mono bg-red-100 text-red-800 px-2 py-1 rounded">401</span> - Unauthorized (invalid token)</li>
              <li><span className="font-mono bg-red-100 text-red-800 px-2 py-1 rounded">403</span> - Forbidden (insufficient permissions)</li>
              <li><span className="font-mono bg-red-100 text-red-800 px-2 py-1 rounded">404</span> - Not Found</li>
              <li><span className="font-mono bg-red-100 text-red-800 px-2 py-1 rounded">500</span> - Internal Server Error</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-2">Error Response Format</h3>
            <pre className="bg-slate-950 text-slate-50 p-4 rounded-md overflow-x-auto text-xs">
{`{
  "error": "Invalid or expired token"
}

// Or for validation errors:
{
  "error": "Invalid request",
  "details": [
    {
      "code": "invalid_type",
      "expected": "string",
      "received": "number",
      "path": ["zone_name"],
      "message": "Expected string, received number"
    }
  ]
}`}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Rate Limiting */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Best Practices</CardTitle>
          <CardDescription>Tips for using the API effectively</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm list-disc list-inside">
            <li>Always use HTTPS in production environments</li>
            <li>Store your API tokens securely - never commit them to version control</li>
            <li>Use the minimum required scopes for your tokens</li>
            <li>Set expiration dates on tokens when possible</li>
            <li>Monitor your token usage in the dashboard</li>
            <li>Handle errors gracefully and implement retry logic for transient failures</li>
            <li>Include proper error handling for network failures and timeouts</li>
            <li>Use pagination parameters (limit/offset) for large datasets</li>
          </ul>
        </CardContent>
      </Card>
      </div>
    </Layout>
  );
}
