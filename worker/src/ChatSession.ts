import { DurableObject } from 'cloudflare:workers';
import { createOpenAI } from '@ai-sdk/openai';
import { createWorkersAI } from 'workers-ai-provider';
import { generateText, tool } from 'ai';
import { z } from 'zod';

export interface Env {
  AI: Ai;
  CHAT_KV: KVNamespace;
  AI_PROVIDER: 'local' | 'cloudflare';
  LOCAL_AI_BASE_URL: string;
  LOCAL_AI_API_KEY: string;
  LOCAL_AI_MODEL: string;
  CF_AI_MODEL: string;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface Ticket {
  id: string;
  sessionId: string;
  type: 'escalation' | 'refund' | 'inappropriate';
  reason: string;
  orderId?: string;
  summary: string;
  timestamp: number;
}

interface CustomerInfo {
  orderId?: string;
  productName?: string;
  productSize?: string;
  damageDescription?: string;
  damageLocation?: string;
}

const SYSTEM_PROMPT = `You are Beacon, a friendly customer support assistant for Striker Elite soccer cleats.

Before creating any ticket for defects or refunds, gather as much detail as possible so a human can review a complete case:
- Order number
- Product name and size
- What happened to the product
- Where the damage is located

Only create tickets for significant defects (sole separation, torn uppers, broken studs). Minor scuffs or normal wear don't qualify.

For inappropriate behavior (profanity, threats), flag immediately without needing product details.

For general questions (sizing, surfaces), just answer helpfully.`;

export class ChatSession extends DurableObject<Env> {
  private messages: Message[] = [];
  private sessionId: string | null = null;
  private customerInfo: CustomerInfo = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async loadHistory(): Promise<void> {
    if (this.sessionId && this.messages.length === 0) {
      const stored = await this.env.CHAT_KV.get(`session:${this.sessionId}`, 'json') as { messages: Message[]; customerInfo: CustomerInfo } | null;
      if (stored) {
        this.messages = stored.messages || [];
        this.customerInfo = stored.customerInfo || {};
      }
    }
  }

  private async saveHistory(): Promise<void> {
    if (this.sessionId) {
      await this.env.CHAT_KV.put(
        `session:${this.sessionId}`,
        JSON.stringify({ messages: this.messages, customerInfo: this.customerInfo }),
        { expirationTtl: 60 * 60 * 24 * 7 }
      );
    }
  }

  private hasRequiredInfo(): boolean {
    return !!(
      this.customerInfo.orderId &&
      this.customerInfo.productName &&
      this.customerInfo.damageDescription
    );
  }

  private getMissingFields(): string[] {
    const missing: string[] = [];
    if (!this.customerInfo.orderId) missing.push('order number');
    if (!this.customerInfo.productName) missing.push('product name');
    if (!this.customerInfo.productSize) missing.push('size');
    if (!this.customerInfo.damageDescription) missing.push('damage description');
    if (!this.customerInfo.damageLocation) missing.push('damage location');
    return missing;
  }

  private async saveTicket(ticket: Ticket): Promise<void> {
    const existing = await this.env.CHAT_KV.get('tickets', 'json') as Ticket[] | null;
    const tickets = existing || [];
    tickets.unshift(ticket);
    await this.env.CHAT_KV.put('tickets', JSON.stringify(tickets.slice(0, 100)));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.sessionId = this.ctx.id.toString();

    if (url.pathname === '/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }

    if (url.pathname === '/history') {
      return this.handleHistory();
    }

    if (url.pathname === '/escalations') {
      return this.handleEscalations();
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }

  private async handleChat(request: Request): Promise<Response> {
    const { message } = await request.json() as { message: string };

    await this.loadHistory();
    this.messages.push({ role: 'user', content: message });

    let ticket: Ticket | null = null;
    const sessionId = this.sessionId!;
    const saveTicket = this.saveTicket.bind(this);
    const customerInfo = this.customerInfo;
    const hasRequiredInfo = this.hasRequiredInfo.bind(this);
    const getMissingFields = this.getMissingFields.bind(this);

    try {
      const model = this.env.AI_PROVIDER === 'cloudflare'
        ? createWorkersAI({ binding: this.env.AI })(this.env.CF_AI_MODEL as Parameters<ReturnType<typeof createWorkersAI>>[0])
        : createOpenAI({
            baseURL: this.env.LOCAL_AI_BASE_URL,
            apiKey: this.env.LOCAL_AI_API_KEY,
          })(this.env.LOCAL_AI_MODEL as Parameters<ReturnType<typeof createOpenAI>>[0]);

      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages: this.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        tools: {
          collect_info: tool({
            description: 'Record customer info as they provide it. Call this each time the customer gives you: order number, product name, size, damage description, or damage location.',
            parameters: z.object({
              order_id: z.string().optional().describe('Order number if provided'),
              product_name: z.string().optional().describe('Product name if provided'),
              product_size: z.string().optional().describe('Size if provided'),
              damage_description: z.string().optional().describe('What happened to the product'),
              damage_location: z.string().optional().describe('Where on the product the damage is'),
            }),
            execute: async (info) => {
              if (info.order_id) customerInfo.orderId = info.order_id;
              if (info.product_name) customerInfo.productName = info.product_name;
              if (info.product_size) customerInfo.productSize = info.product_size;
              if (info.damage_description) customerInfo.damageDescription = info.damage_description;
              if (info.damage_location) customerInfo.damageLocation = info.damage_location;

              const missing = getMissingFields();
              if (missing.length === 0) {
                return { success: true, message: 'All info collected. You can now escalate or request refund if appropriate.', complete: true };
              }
              return { success: true, message: `Info recorded. Still need: ${missing.join(', ')}`, complete: false, missing };
            },
          }),
          escalate_to_human: tool({
            description: 'Create escalation ticket. ONLY call after collect_info confirms all info is gathered AND the defect is significant (sole separation, torn uppers, broken studs).',
            parameters: z.object({
              reason: z.string().describe('Specific defect type'),
            }),
            execute: async ({ reason }) => {
              if (!hasRequiredInfo()) {
                const missing = getMissingFields();
                return { success: false, message: `Cannot escalate yet. Still need: ${missing.join(', ')}` };
              }
              ticket = {
                id: crypto.randomUUID(),
                sessionId,
                type: 'escalation',
                reason,
                orderId: customerInfo.orderId,
                summary: `${customerInfo.productName} size ${customerInfo.productSize} - ${customerInfo.damageDescription} at ${customerInfo.damageLocation}`,
                timestamp: Date.now(),
              };
              await saveTicket(ticket);
              return { success: true, message: 'Ticket created for human review' };
            },
          }),
          request_refund: tool({
            description: 'Create refund request. ONLY call after collect_info confirms all info is gathered AND defect qualifies for refund.',
            parameters: z.object({
              reason: z.string().describe('Why refund is warranted'),
            }),
            execute: async ({ reason }) => {
              if (!hasRequiredInfo()) {
                const missing = getMissingFields();
                return { success: false, message: `Cannot process refund yet. Still need: ${missing.join(', ')}` };
              }
              ticket = {
                id: crypto.randomUUID(),
                sessionId,
                type: 'refund',
                reason,
                orderId: customerInfo.orderId,
                summary: `Refund: ${customerInfo.productName} size ${customerInfo.productSize} - ${customerInfo.damageDescription}`,
                timestamp: Date.now(),
              };
              await saveTicket(ticket);
              return { success: true, message: 'Refund request submitted' };
            },
          }),
          flag_inappropriate: tool({
            description: 'Flag for profanity, slurs, or threats ONLY. Not for frustrated or demanding customers.',
            parameters: z.object({
              behavior: z.string().describe('The specific abusive language used'),
            }),
            execute: async ({ behavior }) => {
              ticket = {
                id: crypto.randomUUID(),
                sessionId,
                type: 'inappropriate',
                reason: behavior,
                summary: `Flagged: ${behavior}`,
                timestamp: Date.now(),
              };
              await saveTicket(ticket);
              return { success: true, message: 'Behavior flagged' };
            },
          }),
        },
        maxSteps: 5,
      });

      if (!result.text) {
        return new Response(JSON.stringify({
          error: 'No response generated',
          ticket,
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      this.messages.push({ role: 'assistant', content: result.text });
      await this.saveHistory();

      return new Response(JSON.stringify({
        response: result.text,
        messageCount: this.messages.length,
        ticket,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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

  private async handleEscalations(): Promise<Response> {
    const tickets = await this.env.CHAT_KV.get('tickets', 'json') as Ticket[] | null;

    return new Response(JSON.stringify({
      tickets: tickets || [],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
