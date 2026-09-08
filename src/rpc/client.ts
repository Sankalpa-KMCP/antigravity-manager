import https from 'https';

export interface RpcOptions {
  port: number;
  csrfToken: string;
  endpoint: string;
  body?: Record<string, any>;
  timeoutMs?: number;
}

export async function callConnectRpc<T>(options: RpcOptions): Promise<T> {
  const { port, csrfToken, endpoint, body = {}, timeoutMs = 5000 } = options;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);

    const reqOptions: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: `/exa.language_server_pb.LanguageServerService/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeoutMs,
      rejectUnauthorized: false
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          return reject(new Error(`RPC ${endpoint} returned HTTP ${res.statusCode}: ${data.substring(0, 150)}`));
        }

        try {
          const parsed = JSON.parse(data);
          resolve(parsed as T);
        } catch (jsonErr) {
          reject(new Error(`Failed to parse JSON response from ${endpoint}: ${(jsonErr as Error).message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`RPC timeout (${timeoutMs}ms) for ${endpoint}`));
    });

    req.on('error', (err) => {
      reject(new Error(`Network error calling ${endpoint}: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}
