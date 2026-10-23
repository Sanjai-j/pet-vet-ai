import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedSocketOrigin } from '../src/ws.js';

test('the WebSocket handshake accepts this deployment\'s own origin', () => {
  assert.equal(isAllowedSocketOrigin('http://localhost:4200'), true);
  assert.equal(isAllowedSocketOrigin('http://127.0.0.1:4200'), true);
});

test('the WebSocket handshake accepts clients that send no origin', () => {
  // Node scripts and health probes omit Origin; they still need a valid token.
  assert.equal(isAllowedSocketOrigin(undefined), true);
});

test('the WebSocket handshake rejects a foreign site', () => {
  assert.equal(isAllowedSocketOrigin('https://evil.example'), false);
  assert.equal(isAllowedSocketOrigin('http://localhost:9999'), false);
  // A lookalike host must not match by prefix.
  assert.equal(isAllowedSocketOrigin('http://localhost:4200.evil.example'), false);
});
