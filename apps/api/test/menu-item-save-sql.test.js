import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');

test('menu-item save keeps availability and active state separate in SQL', () => {
  assert.match(source, /description = \$5, price = \$6, gst_rate = \$7, gst_inclusive = FALSE, availability = \$8, is_active = TRUE/);
  assert.match(source, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,FALSE,\$7,TRUE\)/);
  assert.doesNotMatch(source, /CASE WHEN \$[678] = 'INACTIVE'/);
});
