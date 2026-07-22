#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const ignoredDirectories = new Set(["dist", "test", "node_modules"]);

async function sourceFiles(directory) {
	const files = [];
	for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) files.push(...await sourceFiles(path));
		else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
	}
	return files;
}

async function parse(files) {
	const parsed = [];
	for (const file of files) {
		const content = await readFile(resolve(root, file), "utf8");
		parsed.push(parseText(file, content));
	}
	return parsed;
}

function parseText(file, content) {
	const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
	return { file, source, ...importBindings(source) };
}

function importBindings(source) {
	const bindings = new Map();
	const namespaces = new Map();
	const bind = (name, module, exported) => bindings.set(name, { module, exported });
	for (const node of source.statements) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const module = node.moduleSpecifier.text;
			if (node.importClause?.name) bind(node.importClause.name.text, module, "default");
			const named = node.importClause?.namedBindings;
			if (named && ts.isNamespaceImport(named)) namespaces.set(named.name.text, module);
			if (named && ts.isNamedImports(named)) for (const item of named.elements) bind(item.name.text, module, item.propertyName?.text ?? item.name.text);
		}
		if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
			const module = dynamicImportModule(declaration.initializer);
			if (!module) continue;
			if (ts.isIdentifier(declaration.name)) namespaces.set(declaration.name.text, module);
			if (ts.isObjectBindingPattern(declaration.name)) for (const item of declaration.name.elements) {
				if (ts.isIdentifier(item.name)) bind(item.name.text, module, item.propertyName && ts.isIdentifier(item.propertyName) ? item.propertyName.text : item.name.text);
			}
		}
	}
	return { bindings, namespaces };
}

function dynamicImportModule(initializer) {
	let node = initializer;
	while (node && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
	return node && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
}

function visitAll(parsed, visitor) {
	for (const item of parsed) {
		const visit = (node) => { visitor(item, node); ts.forEachChild(node, visit); };
		visit(item.source);
	}
}

function resolvedExport(item, expression) {
	if (ts.isIdentifier(expression)) return item.bindings.get(expression.text);
	if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
		const module = item.namespaces.get(expression.expression.text);
		if (module) return { module, exported: expression.name.text };
	}
}

function callsExported(parsed, expectedModule, exported) {
	const calls = [];
	visitAll(parsed, (item, node) => {
		if (!ts.isCallExpression(node)) return;
		const target = resolvedExport(item, node.expression);
		if (target?.exported === exported && normalizedModuleTarget(item.file, target.module) === stripSourceExtension(expectedModule)) calls.push(item.file);
	});
	return calls;
}

function normalizedModuleTarget(importer, module) {
	if (!module.startsWith(".")) return module;
	return stripSourceExtension(relative(root, resolve(root, dirname(importer), module)).replaceAll("\\", "/"));
}

function stripSourceExtension(path) { return path.replace(/\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/, ""); }

function importedModules(parsed) {
	const imports = [];
	for (const item of parsed) {
		for (const binding of item.bindings.values()) imports.push({ file: item.file, module: binding.module });
		for (const module of item.namespaces.values()) imports.push({ file: item.file, module });
	}
	return imports;
}

function resolvesToMemoryImplementation(file, module) {
	if (module === "@thruvera/memory" || module.startsWith("@thruvera/memory/")) return true;
	if (!module.startsWith(".")) return false;
	const target = relative(root, resolve(root, dirname(file), module)).replaceAll("\\", "/");
	return target === "packages/memory" || target.startsWith("packages/memory/");
}

const protectedAuthorities = new Set(["ThruveraAgentRuntime", "ObjectiveRuntime", "TaskPlanRuntime", "ProfileTaskScheduler"]);
function protectedConstructionKeys(parsed) {
	const constructions = [];
	visitAll(parsed, (item, node) => {
		if (!ts.isNewExpression(node)) return;
		const imported = resolvedExport(item, node.expression);
		const localCoreName = item.file.startsWith("packages/core/src/") && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
		const name = imported?.module === "@thruvera/core" ? imported.exported : localCoreName;
		if (name && protectedAuthorities.has(name)) constructions.push(`${item.file}|${name}`);
	});
	return constructions;
}

function parserFixtureViolations() {
	const fixture = [parseText("packages/gateway/src/duplicate.ts", [
		'import { ObjectiveRuntime as DuplicateRuntime } from "@thruvera/core";',
		'import * as Core from "@thruvera/core";',
		'import { createProfileRuntime as compose } from "../../../apps/cli/src/runtime-composition.ts";',
		"function createProfileRuntime() {}",
		"new DuplicateRuntime(); new Core.TaskPlanRuntime(); compose(); createProfileRuntime();",
	].join("\n"))];
	const constructions = protectedConstructionKeys(fixture).sort();
	const calls = callsExported(fixture, "apps/cli/src/runtime-composition", "createProfileRuntime");
	return JSON.stringify(constructions) === JSON.stringify(["packages/gateway/src/duplicate.ts|ObjectiveRuntime", "packages/gateway/src/duplicate.ts|TaskPlanRuntime"])
		&& JSON.stringify(calls) === JSON.stringify(["packages/gateway/src/duplicate.ts"]) ? 0 : 1;
}

const coreFiles = await sourceFiles("packages/core/src");
const allProductionFiles = [...await sourceFiles("apps"), ...await sourceFiles("packages")];
const core = await parse(coreFiles);
const production = await parse(allProductionFiles);
const cli = production.filter(({ file }) => file.startsWith("apps/cli/src/"));
const boundary = production.filter(({ file }) => file.startsWith("packages/core/src/") || file.startsWith("packages/gateway/src/") || file.startsWith("packages/automation/src/"));
const channelRuntime = production.filter(({ file }) => file.startsWith("packages/channel-runtime/src/"));
const gateway = production.filter(({ file }) => file.startsWith("packages/gateway/src/"));

const ontologyIdentifier = /^(?:client|customer|order|ticket|purchaseorder|workorder)(?:id|type|status|number|ref|reference|record|entity|profile|context|scope|item|items)?$/;
const fixedOntologyIdentifier = /^(?:(?:customer|purchaseorder|workorder)(?:id|type|status|number|ref|reference|record|entity|profile|context|scope|item|items)?|(?:order|ticket)(?:id|type|status|number|ref|reference|record|entity|profile|context|scope|item|items))$/;
const fixedOntologyLiteral = /^(?:customer|order|ticket|purchase[_-]?order|work[_-]?order)(?:[_-](?:id|type|status|number|ref|reference|record|entity|profile|context|scope|item|items))?$/i;
let customerOntologyInCore = 0;
let fixedBusinessOntologyInProduction = 0;
let legacyBusinessContextRuntimeConsumers = 0;
visitAll(core, ({ file }, node) => {
	if (!ts.isIdentifier(node)) return;
	if (ontologyIdentifier.test(node.text.toLowerCase())) customerOntologyInCore++;
	if (node.text === "businessContext" && file !== "packages/core/src/task-ledger.ts") legacyBusinessContextRuntimeConsumers++;
});
visitAll(production, (_item, node) => {
	if (ts.isIdentifier(node) && fixedOntologyIdentifier.test(node.text.toLowerCase())) fixedBusinessOntologyInProduction++;
	if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && fixedOntologyLiteral.test(node.text.trim())) fixedBusinessOntologyInProduction++;
});

const profileWorkCalls = callsExported(cli, "apps/cli/src/profile-work-runtime", "createProfileWorkRuntime");
const profileRuntimeCalls = callsExported(cli, "apps/cli/src/runtime-composition", "createProfileRuntime");
const expectedChannelCalls = new Map([["apps/cli/src/cli.ts", 1], ["apps/cli/src/gateway.ts", 1]]);
const channelProfileRuntimeCoverageViolations = [...expectedChannelCalls].filter(([file, expected]) => profileRuntimeCalls.filter((item) => item === file).length !== expected).length
	+ profileRuntimeCalls.filter((file) => !expectedChannelCalls.has(file)).length;

const constructions = protectedConstructionKeys(production);
const expectedConstructions = new Map([
	["apps/cli/src/runtime-composition.ts|ThruveraAgentRuntime", 1],
	["apps/cli/src/gateway.ts|ThruveraAgentRuntime", 1],
	["apps/cli/src/profile-work-runtime.ts|ObjectiveRuntime", 1],
	["apps/cli/src/profile-work-runtime.ts|TaskPlanRuntime", 1],
	["apps/cli/src/profile-work-runtime.ts|ProfileTaskScheduler", 1],
	["packages/core/src/task-recovery.ts|TaskPlanRuntime", 1],
	["packages/core/src/task-orchestration-tools.ts|TaskPlanRuntime", 1],
]);
const constructionCounts = new Map();
for (const key of constructions) constructionCounts.set(key, (constructionCounts.get(key) ?? 0) + 1);
const protectedAuthorityConstructionViolations = [...new Set([...expectedConstructions.keys(), ...constructionCounts.keys()])]
	.filter((key) => constructionCounts.get(key) !== expectedConstructions.get(key)).length;

const invariants = {
	customerOntologyInCore,
	fixedBusinessOntologyInProduction,
	legacyBusinessContextRuntimeConsumers,
	profileWorkCompositionCallers: profileWorkCalls.length,
	channelProfileRuntimeCallers: profileRuntimeCalls.length,
	channelProfileRuntimeCoverageViolations,
	parserFixtureViolations: parserFixtureViolations(),
	protectedAuthorityConstructionViolations,
	memoryImplementationImportsOutsideComposition: importedModules(boundary).filter(({ file, module }) => resolvesToMemoryImplementation(file, module)).length,
	channelRuntimePlatformImplementationImports: importedModules(channelRuntime).filter(({ module }) => /@thruvera\/(?:gateway|channel-feishu|channel-telegram)|@larksuiteoapi\/node-sdk/u.test(module)).length,
	gatewayPlatformImplementationImports: importedModules(gateway).filter(({ module }) => /@thruvera\/channel-(?:feishu|telegram)|@larksuiteoapi\/node-sdk/u.test(module)).length,
	gatewayProviderPresentationFiles: gateway.filter(({ file }) => file.includes("/card/")).length,
	gatewayProviderPresentationIdentifiers: countIdentifiers(gateway, new Set(["CardSession", "renderCard", "FlushController"])),
	feishuPresentationOwnerFiles: production.filter(({ file }) => file === "packages/channel-feishu/src/presentation/presenter.ts").length,
};
const expected = {
	customerOntologyInCore: 0,
	fixedBusinessOntologyInProduction: 0,
	legacyBusinessContextRuntimeConsumers: 0,
	profileWorkCompositionCallers: 1,
	channelProfileRuntimeCallers: 2,
	channelProfileRuntimeCoverageViolations: 0,
	parserFixtureViolations: 0,
	protectedAuthorityConstructionViolations: 0,
	memoryImplementationImportsOutsideComposition: 0,
	channelRuntimePlatformImplementationImports: 0,
	gatewayPlatformImplementationImports: 0,
	gatewayProviderPresentationFiles: 0,
	gatewayProviderPresentationIdentifiers: 0,
	feishuPresentationOwnerFiles: 1,
};
const failures = Object.entries(expected).filter(([name, value]) => invariants[name] !== value).map(([name, value]) => `${name}: expected ${value}, observed ${invariants[name]}`);
console.log(JSON.stringify({ schemaVersion: 5, parser: `typescript-${ts.version}`, invariants, gate: { passed: failures.length === 0, failures } }, null, 2));
if (failures.length) process.exitCode = 1;

function countIdentifiers(parsed, names) {
	let count = 0;
	visitAll(parsed, (_item, node) => { if (ts.isIdentifier(node) && names.has(node.text)) count++; });
	return count;
}
