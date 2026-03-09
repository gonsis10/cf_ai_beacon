import { DurableObject } from 'cloudflare:workers';

export interface Env {
  AI: Ai;
  CHAT_KV: KVNamespace;
}

export class ChatSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    return new Response('ChatSession Durable Object');
  }
}
