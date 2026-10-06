import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp({ CORS_ORIGIN: 'http://localhost:5180, http://192.168.18.183:5180' });
});
afterAll(() => t.destroy());

const ask = (origin: string) => request(t.app).options('/api/v1/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST');

describe('CORS', () => {
  it('allows each listed origin, with cookies', async () => {
    for (const origin of ['http://localhost:5180', 'http://192.168.18.183:5180']) {
      const res = await ask(origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    }
  });

  it('does not allow any other origin', async () => {
    expect((await ask('http://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });
});
