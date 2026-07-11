import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../haxball.mjs', import.meta.url), 'utf8');

test('haxball room script passes one payload object to page.evaluate', () => {
    assert.match(source, /page\.evaluate\(\(\{\s*config,\s*goalAttributionFactorySource\s*\}\)\s*=>/s);
    assert.match(source, /window\.HBInit\(config\)/);
    assert.match(source, /\},\s*\{\s*config:\s*roomConfig,\s*goalAttributionFactorySource,\s*\}\s*\);/s);
    assert.doesNotMatch(source, /page\.evaluate\(\(config,\s*goalAttributionFactorySource\)\s*=>/);
    assert.doesNotMatch(source, /\},\s*roomConfig,\s*goalAttributionFactorySource\s*\);/);
});
