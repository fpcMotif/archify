import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createOwnedTempDirectory } from '../archify/renderers/shared/owned-temp-directory.mjs';

test('cleanup finishes while another process deletes the same directory', async () => {
  for (let round = 0; round < 5; round++) {
    const owned = createOwnedTempDirectory('archify-owned-race-');
    for (let i = 0; i < 200; i++) {
      const child = path.join(owned.path, `d${i}`);
      fs.mkdirSync(child);
      for (let j = 0; j < 5; j++) fs.writeFileSync(path.join(child, `f${j}`), 'x');
    }
    const racer = Bun.spawn(['rm', '-rf', owned.path]);
    await owned.cleanup();
    await racer.exited;
    assert.equal(fs.existsSync(owned.path), false);
  }
});
