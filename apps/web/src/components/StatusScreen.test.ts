import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statusKindFor } from './StatusScreen.js';

describe('statusKindFor', () => {
  it('blames the connection only when there is no connection', () => {
    assert.equal(statusKindFor(0, false), 'offline');
    // The network is up and Orbit is not answering: telling someone to check
    // their connection would send them to fix something that is not broken.
    assert.equal(statusKindFor(0, true), 'server-error');
  });

  it('treats both refusals as access denied', () => {
    assert.equal(statusKindFor(401, true), 'denied');
    assert.equal(statusKindFor(403, true), 'denied');
  });

  it('maps 404 to not found', () => {
    assert.equal(statusKindFor(404, true), 'not-found');
  });

  it('maps server faults to the server screen', () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(statusKindFor(status, true), 'server-error');
    }
  });

  it('does not call a bad request a missing page', () => {
    // 400 and 409 are Orbit's fault or a conflict, not a wrong address - saying
    // "that page does not exist" would send the user looking for a typo.
    assert.equal(statusKindFor(400, true), 'server-error');
    assert.equal(statusKindFor(409, true), 'server-error');
  });
});
