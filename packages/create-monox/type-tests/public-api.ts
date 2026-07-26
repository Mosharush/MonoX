import {
  createGenerationPlan,
  generateProject,
  type AddonRecipe,
  type ExternalRecipeReference,
  type GenerationResult,
  type GeneratorOptions,
  type WorkspaceRecipe,
} from 'create-monox';
import {
  ADDON_RECIPES,
  RECIPE_API_VERSION,
  WORKSPACE_RECIPES,
  assertAddon,
  assertWorkspaceTemplate,
  catalogManifest,
} from 'create-monox/catalog';
import { normalizeOptions } from 'create-monox/generator';

const workspace: WorkspaceRecipe = WORKSPACE_RECIPES['node-fastify-api'];
const addon: AddonRecipe = ADDON_RECIPES.redis;
const externalReference: ExternalRecipeReference = {
  id: '@acme/java-api',
  apiVersion: '1',
  version: '2.3.4',
  integrity: 'sha256-example',
};

const options = {
  name: 'typed-product',
  workspaces: ['api=node-fastify-api', { name: 'shared', template: 'go-library' }],
  addons: ['redis', 'rabbitmq'],
  delivery: 'docker:local',
  packageManager: 'pnpm',
  git: false,
} satisfies GeneratorOptions;

const plan: GenerationResult = createGenerationPlan(options);
const generated: Promise<Readonly<GenerationResult>> = generateProject({ ...options, dryRun: true });
const normalized = normalizeOptions(options);
const manifest = catalogManifest();

assertWorkspaceTemplate(workspace.framework);
assertAddon(addon.category);
void externalReference;
void generated;
void manifest.integrity;
void normalized.deliveryDefinition.runtime;
void plan.fileDigests;
void RECIPE_API_VERSION;

const invalidExternalReference: ExternalRecipeReference = {
  // @ts-expect-error External references must use a scoped, namespaced ID.
  id: 'java-api',
  apiVersion: '1',
  version: '1.0.0',
  integrity: 'sha256-example',
};
void invalidExternalReference;

// @ts-expect-error Unknown bundled workspace recipe IDs fail at the public type boundary.
createGenerationPlan({ name: 'typed-product', workspaces: [{ name: 'api', template: 'unknown-api' }] });
