// Assertion test for the Core 5 Merfolk extensions (person/sphere, boundary,
// explicit `in`, per-end arrow decorators, style/relstyle/align directives,
// junction) against the src/lib/3d-ast lib.
//
// Bundles the TypeScript lib with the esbuild nested inside vite, then runs
// graph-level assertions against AST3DGenerator.generate().

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/vite/node_modules/esbuild/lib/main.js'));

// --- bundle the 3d-ast lib ------------------------------------------------
const entryFile = path.join(os.tmpdir(), 'test-parse-c4-entry.ts');
const outfile = path.join(os.tmpdir(), 'test-parse-c4-bundle.mjs');
await Promise.all([
  fs.promises.writeFile(
    entryFile,
    "export * from '" + path.join(ROOT, 'src/lib/3d-ast/index.ts').replace(/\\/g, '/') + "';\n" +
      "export { AST3DGenerator } from '" + path.join(ROOT, 'src/lib/3d-ast/generators/3d-generator.ts').replace(/\\/g, '/') + "';\n"
  ),
]);

await esbuild.build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

const { AST3DGenerator, GeometryType, NodeType, ConnectionType } =
  await import(pathToFileURL(outfile).href);

// --- tiny assertion harness -------------------------------------------------
let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- fixture ----------------------------------------------------------------
const FIXTURE = `graph3d "C4 Test"

%% People (sphere geometry)
U~Person: Analyst~
A~Person: Admin~

%% Boundary + junction
{Boundary: PCI Zone}
{Boundary: Billing}
junction J1

%% Containers / components with explicit membership
UI{Component: Web UI}
API{Component: API Gateway}
F[Function: Frontend]
C{Component: Core}
S[Service: Reporting] in <API>
Pay[Service: Payments] in <PCI Zone>

%% Connections with per-end arrow decorators
UI --> API : "calls"
A <-- API : "queries state"        %% arrow at source end
U <--> API : "reviews"             %% arrows at both ends
F --- C : "headless"
J1 *--> API

%% Directives
align row U A
align column UI API
style Service { color: "#FF9800", opacity: 0.7 }
relstyle dataflow { color: "#00BCD4", lineStyle: "dashed" }
`;

const generator = new AST3DGenerator();
const graph = generator.generate(FIXTURE);

// --- node-level checks -------------------------------------------------------
const nodes = new Map();
for (const n of graph.nodes.values()) nodes.set(n.id, n);

console.log('\n[Person / sphere]');
assert('U parsed', nodes.has('U'));
assert('U geometry sphere', nodes.get('U')?.geometry === GeometryType.SPHERE, nodes.get('U')?.geometry);
assert('U nodeType PERSON', nodes.get('U')?.type === NodeType.PERSON, nodes.get('U')?.nodeType);
assert('U color = #FFC107', (nodes.get('U')?.visual?.color || '').toUpperCase() === '#FFC107', nodes.get('U')?.visual?.color);
assert('U has single center face', nodes.get('U')?.faces?.length === 1 && nodes.get('U')?.faces[0].id === 'center', JSON.stringify((nodes.get('U')?.faces || []).map((f) => f.id)));

console.log('\n[Boundary]');
assert('PCI Zone parsed', nodes.has('PCI Zone'), [...nodes.keys()]);
assert('PCI Zone nodeType BOUNDARY', nodes.get('PCI Zone')?.type === NodeType.BOUNDARY, nodes.get('PCI Zone')?.nodeType);

console.log('\n[Junction]');
assert('J1 parsed', nodes.has('J1'));
assert('J1 nodeType JUNCTION', nodes.get('J1')?.type === NodeType.JUNCTION, nodes.get('J1')?.nodeType);

console.log('\n[Explicit `in` membership]');
assert('S parent = API', nodes.get('S')?.parent === 'API', nodes.get('S')?.parent);
assert('API has child S', (nodes.get('API')?.children ?? []).includes('S'));
assert('Pay parent = PCI Zone', nodes.get('Pay')?.parent === 'PCI Zone', nodes.get('Pay')?.parent);

console.log('\n[Alignments]');
const aligns = graph.metadata?.alignments || [];
assert('2 align directives', aligns.length === 2, JSON.stringify(aligns));
assert('row alignment for U/A', aligns.some(a => a.mode === 'row' && a.nodeIds.includes('U') && a.nodeIds.includes('A')));
assert('column alignment for UI/API', aligns.some(a => a.mode === 'column' && a.nodeIds.includes('UI') && a.nodeIds.includes('API')));

console.log('\n[Styles]');
assert('Service color applied', nodes.get('S')?.visual?.color === '#FF9800', nodes.get('S')?.visual?.color);
assert('Service opacity applied', nodes.get('S')?.visual?.opacity === 0.7, nodes.get('S')?.visual?.opacity);

console.log('\n[Arrows]');
const findConn = (src, dst) =>
  [...graph.connections.values()].find(
    (c) => c.source.nodeId === src && c.target.nodeId === dst
  );
const uiApi = findConn('UI', 'API');
assert('UI --> API arrowEnd', uiApi?.arrowEnd === true, JSON.stringify({ aS: uiApi?.arrowStart, aE: uiApi?.arrowEnd }));
assert('UI --> API arrowStart false', uiApi?.arrowStart === false);

const aApi = findConn('A', 'API');
assert('A <-- API type association', aApi?.type === ConnectionType.ASSOCIATION, aApi?.type);
assert('A <-- API arrowStart true', aApi?.arrowStart === true, JSON.stringify({ aS: aApi?.arrowStart, aE: aApi?.arrowEnd }));
assert('A <-- API arrowEnd false', aApi?.arrowEnd === false);

const uApi = findConn('U', 'API');
assert('U <--> API arrowStart true', uApi?.arrowStart === true, JSON.stringify({ aS: uApi?.arrowStart, aE: uApi?.arrowEnd }));
assert('U <--> API arrowEnd true', uApi?.arrowEnd === true);

const fC = findConn('F', 'C');
assert('F --- C headless both false', fC?.arrowStart === false && fC?.arrowEnd === false);
assert('F --- C association', fC?.type === ConnectionType.ASSOCIATION, fC?.type);

const j1Api = findConn('J1', 'API');
assert('J1 *--> API composition', j1Api?.type === ConnectionType.COMPOSITION, j1Api?.type);

console.log('\n[relstyle]');
assert('dataflow relstyle color', uiApi?.visual?.color === '#00BCD4', uiApi?.visual?.color);
assert('dataflow relstyle lineStyle', (uiApi?.metadata || {}).lineStyle === 'dashed', JSON.stringify(uiApi?.metadata));

console.log('\n[Validation]');
const result = generator.validate(FIXTURE);
assert('validate valid', result.valid === true, JSON.stringify(result.errors));
assert('validate no warnings for this fixture', result.warnings.length === 0, JSON.stringify(result.warnings));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);