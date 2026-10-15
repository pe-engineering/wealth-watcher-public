import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateInvestedShare, getAggregateBreakdown, getCurrentAggregateValue } from './DashboardModel.js';

test('dashboard model reads the latest aggregate value and breakdown safely', () => {
    assert.equal(getCurrentAggregateValue({ Data: [{ Value: 10 }, { Value: '25' }] }), 25);
    assert.equal(getCurrentAggregateValue({ Data: [] }), 0);
    assert.equal(getCurrentAggregateValue({ Data: [{ Value: 10 }], Current: { Value: 25 } }), 25);
    assert.equal(getCurrentAggregateValue({ Data: [{ Value: 10 }], Current: { Value: 0 } }), 0);
    assert.deepEqual(getAggregateBreakdown({ Breakdown: { ISA: 25 } }), { ISA: 25 });
    assert.equal(getAggregateBreakdown({ Breakdown: [] }), null);
});

test('dashboard model allocates invested capital proportionally without invalid values', () => {
    assert.equal(calculateInvestedShare(100, 40, 25), 10);
    assert.equal(calculateInvestedShare(0, 40, 25), 0);
    assert.equal(calculateInvestedShare(100, 'invalid', 25), 0);
});
