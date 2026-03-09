import { ChatSession } from './ChatSession';

export interface Env {
  AI: Ai;
  CHAT_KV: KVNamespace;
  CHAT_SESSION: DurableObjectNamespace;
}

export { ChatSession };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok' });
    }

    // Create new session
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const sessionId = crypto.randomUUID();
      return jsonResponse({ sessionId });
    }

    // Chat endpoint - forward to Durable Object
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = await request.json() as { sessionId?: string; message?: string };
      const { sessionId, message } = body;

      if (!sessionId || !message) {
        return jsonResponse({ error: 'sessionId and message are required' }, 400);
      }

      const id = env.CHAT_SESSION.idFromName(sessionId);
      const stub = env.CHAT_SESSION.get(id);

      const response = await stub.fetch(new Request('http://internal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message }),
      }));

      const data = await response.json();
      return jsonResponse(data, response.status);
    }

    // Get chat history
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId) {
        return jsonResponse({ error: 'sessionId is required' }, 400);
      }

      const id = env.CHAT_SESSION.idFromName(sessionId);
      const stub = env.CHAT_SESSION.get(id);

      const response = await stub.fetch(new Request(`http://internal/history?sessionId=${sessionId}`));
      const data = await response.json();
      return jsonResponse(data, response.status);
    }

    // Get all tickets
    if (url.pathname === '/api/escalations' && request.method === 'GET') {
      const tickets = await env.CHAT_KV.get('tickets', 'json');
      return jsonResponse({ tickets: tickets || [] });
    }

    // Delete a session
    if (url.pathname === '/api/session' && request.method === 'DELETE') {
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId) {
        return jsonResponse({ error: 'sessionId is required' }, 400);
      }

      await env.CHAT_KV.delete(`session:${sessionId}`);
      return jsonResponse({ success: true });
    }

    // Delete a ticket
    if (url.pathname === '/api/ticket' && request.method === 'DELETE') {
      const ticketId = url.searchParams.get('ticketId');

      if (!ticketId) {
        return jsonResponse({ error: 'ticketId is required' }, 400);
      }

      const existing = await env.CHAT_KV.get('tickets', 'json') as Array<{ id: string }> | null;
      if (existing) {
        const filtered = existing.filter(t => t.id !== ticketId);
        await env.CHAT_KV.put('tickets', JSON.stringify(filtered));
      }
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
