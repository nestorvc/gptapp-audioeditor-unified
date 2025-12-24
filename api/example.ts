/**
 * Example Vercel Edge API Route
 * 
 * This demonstrates how to configure edge runtime and cache control
 * without using vercel.json. Place your API routes in the api/ directory.
 */

// Export config to set edge runtime
export const config = {
  runtime: 'edge',
};

// Handler function - receives Request and returns Response
export default async function handler(req: Request): Promise<Response> {
  // Your logic here
  const data = { message: 'Hello from edge runtime' };
  
  // Return Response with Cache-Control header
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

