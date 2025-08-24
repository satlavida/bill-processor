import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('bill processor worker', () => {
  it('rejects non-POST requests (unit style)', async () => {
    const request = new Request('http://example.com');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method not allowed');
  });

  it('rejects non-POST requests (integration style)', async () => {
    const response = await SELF.fetch('http://example.com');
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method not allowed');
  });
});
