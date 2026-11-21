const { test } = require('node:test');
const assert = require('node:assert/strict');

test('CommonJS and ESM expose the same public API', async () => {
    const cjs = require('agent-hyper');
    const esm = await import('agent-hyper');
    assert.equal(cjs.default, cjs);
    assert.equal(esm.default, cjs);
    const names = ['HttpProxyAgent', 'HttpsProxyAgent', 'createHttp2Transport', 'createHttp2TransportPool'];
    assert.deepEqual(Object.keys(cjs).sort(), names);
    assert.deepEqual(Object.keys(esm).sort(), [...names, 'default']);
    for (const name of names) {
        assert.equal(typeof cjs[name], 'function');
        assert.equal(esm[name], cjs[name]);
    }
});
