export function isAllowedOrigin(origin: string | null): boolean {
  return Boolean(
    origin &&
      (origin.startsWith("chrome-extension://") ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")),
  );
}

export function extensionCorsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && isAllowedOrigin(origin) ? origin : "http://localhost:3001",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
