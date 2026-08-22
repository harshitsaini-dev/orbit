import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brandFavicon, brandMark } from './brand.js';

/**
 * The share page is the one page a stranger opens, and it is served from a
 * different origin than the app. A logo that disagrees with the one in the tab
 * beside it reads as a phishing page rather than as a rough edge.
 */

describe('the mark the share page uses', () => {
  it('is the application logo, not a second drawing of it', () => {
    // The real favicon.svg has gradients and three bodies on the orbit; the
    // hand-drawn stand-in that used to be here had a circle and an ellipse.
    const mark = brandMark();

    assert.match(mark, /radialGradient/);
    assert.match(mark, /<circle[^>]*r="4.4"/, 'the outermost body is missing');
  });

  it('drops the tile behind it when drawn on a page', () => {
    // The dark rounded square exists so the icon has an edge in a browser tab.
    // On a page it would put the logo in a box nothing else on the page has.
    assert.doesNotMatch(brandMark(), /fill="#151824"/);
  });

  it('is sized where it is asked to be', () => {
    assert.match(brandMark(26), /width="26" height="26"/);
    assert.match(brandMark(16), /width="16" height="16"/);
  });

  it('gives the tab an icon that needs no other request', () => {
    // A link to /favicon.svg would 404: this server serves no static file
    // there, and a share would look like it came from nowhere.
    const favicon = brandFavicon();

    assert.match(favicon, /^data:image\/svg\+xml,/);
    assert.ok(favicon.length > 200, 'that is not the whole mark');
  });

  it('keeps the tile in the tab icon, where it is the edge', () => {
    assert.match(decodeURIComponent(brandFavicon()), /fill="#151824"/);
  });
});
