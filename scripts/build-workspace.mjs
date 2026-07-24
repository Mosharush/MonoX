import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.cwd();
const destination = path.join(workspace, 'dist');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const directory of ['src', 'public']) {
  await cp(path.join(workspace, directory), path.join(destination, directory), {
    recursive: true,
    force: true,
  }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

console.log(`Built ${path.basename(workspace)} into ${path.relative(workspace, destination)}`);
