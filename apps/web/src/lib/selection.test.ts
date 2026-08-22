import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rangeBetween } from './selection.js';

const KEYS = ['a', 'b', 'c', 'd', 'e'];

describe('rangeBetween', () => {
  it('takes everything between the two, inclusive', () => {
    assert.deepEqual(rangeBetween(KEYS, 'b', 'd'), ['b', 'c', 'd']);
  });

  it('reads the same in either direction', () => {
    // Shift-clicking upwards is as ordinary as shift-clicking downwards, and
    // an anchor below the click is the usual case when correcting a selection.
    assert.deepEqual(rangeBetween(KEYS, 'd', 'b'), ['b', 'c', 'd']);
  });

  it('is one item when both ends are the same', () => {
    assert.deepEqual(rangeBetween(KEYS, 'c', 'c'), ['c']);
  });

  it('takes the whole list from end to end', () => {
    assert.deepEqual(rangeBetween(KEYS, 'a', 'e'), KEYS);
  });

  it('selects nothing when an end is no longer in the list', () => {
    /*
     * The anchor outlives the list it was set against - a filter is typed, a
     * page is turned - and a range from something that is no longer displayed
     * would otherwise be computed from an index of -1 and select a stretch
     * nobody pointed at.
     */
    assert.deepEqual(rangeBetween(KEYS, 'gone', 'c'), []);
    assert.deepEqual(rangeBetween(KEYS, 'c', 'gone'), []);
  });

  it('copes with an empty list', () => {
    assert.deepEqual(rangeBetween([], 'a', 'b'), []);
  });
});
