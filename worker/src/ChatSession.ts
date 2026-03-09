import { DurableObject } from 'cloudflare:workers';

export interface Env {
  AI: Ai;
  CHAT_KV: KVNamespace;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const SYSTEM_PROMPT = `You are Beacon, the customer support assistant for Striker Elite soccer cleats.

You help customers with:
- Defective products and returns (ask for order number and issue description)
- Product questions (sizing, models, playing surfaces)
- Order tracking and shipping inquiries

Be friendly, empathetic, and keep responses concise.`;

export class ChatSession extends DurableObject<Env> {
  private messages: Message[] = [];
  private sessionId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async loadHistory(): Promise<void> {
    if (this.sessionId && this.messages.length === 0) {
      const stored = await this.env.CHAT_KV.get(`session:${this.sessionId}`, 'json');
      if (stored) {
        this.messages = stored as Message[];
      }
    }
  }

  private async saveHistory(): Promise<void> {
    if (this.sessionId) {
      await this.env.CHAT_KV.put(
        `session:${this.sessionId}`,
        JSON.stringify(this.messages),
        { expirationTtl: 60 * 60 * 24 * 7 } // 7 days
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract session ID from DO name
    this.sessionId = this.ctx.id.toString();

    if (url.pathname === '/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }

    if (url.pathname === '/history') {
      return this.handleHistory();
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  private async handleChat(request: Request): Promise<Response> {
    const { message } = await request.json() as { message: string };

    await this.loadHistory();

    // Add user message
    this.messages.push({ role: 'user', content: message });

    // Build messages for AI with system prompt
    const aiMessages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.messages,
    ];

    try {
      const response = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: aiMessages,
        max_tokens: 1024,
      });

      const assistantMessage = (response as { response: string }).response;

      // Add assistant response to history
      this.messages.push({ role: 'assistant', content: assistantMessage });

      await this.saveHistory();

      return new Response(JSON.stringify({
        response: assistantMessage,
        messageCount: this.messages.length,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleHistory(): Promise<Response> {
    await this.loadHistory();

    return new Response(JSON.stringify({
      messages: this.messages,
      messageCount: this.messages.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
