#!/usr/bin/env node
import { discoverWorkspaces } from './index.mjs';

const asJson = process.argv.includes('--json');
const { workspaces } = await discoverWorkspaces();

if (asJson) {
  console.log(
    JSON.stringify(
      workspaces.map(({ name, location, manifest }) => ({ name, location, private: !!manifest.private })),
      null,
      2
    )
  );
} else {
  for (const workspace of workspaces) console.log(`${workspace.name}\t${workspace.location}`);
}
