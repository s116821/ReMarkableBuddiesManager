import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Parser, Lexer, Evaluator, data } from '@actions/expressions';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const workflow = name => parse(readFileSync(path.join(root, '.github/workflows', name + '.yml'), 'utf8'));
const expr = text => String.fromCharCode(36) + '{{ ' + text + ' }}';
const manager = true;

test('PR and main job budgets include every matrix expansion', () => {
  const ci = workflow('ci'), pipeline = workflow('pipeline');
  const count = job => {
    if (!job.strategy) return 1;
    assert.deepEqual(Object.keys(job.strategy.matrix), ['os'], 'Account for every added matrix dimension');
    return job.strategy.matrix.os.length;
  };
  const common = count(ci.jobs.checks) + count(pipeline.jobs.build) + count(pipeline.jobs.integration);
  assert.equal(common + count(ci.jobs.title), manager ? 5 : 4);
  assert.equal(common + count(pipeline.jobs.release), manager ? 5 : 4);
  for (const file of readdirSync(path.join(root, '.github/workflows')).filter(f => /\.ya?ml$/.test(f))) {
    if (['ci.yml','pipeline.yml','pr-title.yml'].includes(file)) continue;
    const triggers = parse(readFileSync(path.join(root, '.github/workflows', file), 'utf8')).on;
    const names = typeof triggers === 'string' ? [triggers] : Array.isArray(triggers) ? triggers : Object.keys(triggers ?? {});
    assert.ok(!names.some(event => ['push','pull_request','pull_request_target'].includes(event)),
      file + ' adds a separate PR/push workflow; incorporate its jobs into the stage budget');
  }
});

test('four stages preserve platform coverage and block dependent jobs on failure', () => {
  const ci = workflow('ci'), pipeline = workflow('pipeline');
  assert.deepEqual(Object.keys(ci.jobs), ['title','checks','application']);
  assert.deepEqual(Object.keys(pipeline.jobs), ['build','integration','release']);
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.equal(ci.on.pull_request_target, undefined);
  assert.equal(ci.jobs.title.if, "github.event_name == 'pull_request'");
  assert.equal(ci.jobs.checks.needs, 'title');
  assert.equal(ci.jobs.checks.if, "!cancelled() && (github.event_name == 'push' || needs.title.result == 'success') && needs.title.outputs.body_only != 'true'");
  assert.deepEqual(ci.jobs.application.needs, ['title','checks']);
  assert.equal(ci.jobs.application.if, "!cancelled() && needs.checks.result == 'success' && needs.checks.outputs.application == 'true'");
  assert.equal(pipeline.jobs.build.needs, undefined);
  assert.deepEqual(pipeline.jobs.integration.needs, 'build');
  assert.deepEqual(pipeline.jobs.release.needs, ['build','integration']);
  assert.equal(pipeline.jobs.release.if, 'inputs.release');
  assert.equal(pipeline.concurrency.queue, 'max');
  assert.equal(pipeline.concurrency['cancel-in-progress'], false);
  assert.equal(ci.jobs.checks['continue-on-error'], undefined);
  for (const job of [ci.jobs.title, ...Object.values(pipeline.jobs)]) {
    assert.equal(job['continue-on-error'], undefined);
    assert.ok(!/always\(|cancelled\(|failure\(/.test(job.if ?? ''));
  }
  assert.equal(ci.jobs.checks.strategy, undefined);
  assert.equal(ci.jobs.checks['runs-on'], 'ubuntu-latest');
  if (manager) {
    assert.deepEqual(pipeline.jobs.integration.strategy.matrix.os, ['ubuntu-latest','windows-latest']);
    assert.equal(pipeline.jobs.build['runs-on'], 'ubuntu-22.04');
    assert.equal(pipeline.jobs.integration['runs-on'], expr("matrix.os == 'ubuntu-latest' && 'ubuntu-22.04' || matrix.os"));
    assert.equal(pipeline.jobs.integration.name, 'Integration (' + expr('matrix.os') + ')');
  } else {
    assert.equal(pipeline.jobs.integration.strategy, undefined);
  }
  assert.equal(ci.jobs.checks.defaults.run.shell, 'bash');
  assert.equal(pipeline.jobs.integration.defaults.run.shell, 'bash');
});

function evaluate(text, context, canceled = false) {
  const source = String(text).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const functions = new Map([['cancelled', {
    name: 'cancelled', minArgs: 0, maxArgs: 0,
    call: () => new data.BooleanData(canceled)
  }]]);
  const ast = new Parser(new Lexer(source).lex().tokens, Object.keys(context), [...functions.values()]).parse();
  return new Evaluator(ast, JSON.parse(JSON.stringify(context), data.reviver), functions).evaluate();
}
function bodyOnly(event) {
  const step = workflow('ci').jobs.title.steps.find(s => s.id === 'metadata');
  const match = step.run.match(/jq -r '([\s\S]*?)' "\$GITHUB_EVENT_PATH"/);
  assert.ok(match, 'Exercise the actual workflow jq predicate');
  const result = spawnSync(process.env.METADATA_JQ || 'jq', ['-r', match[1]], {
    input: JSON.stringify(event), encoding: 'utf8', windowsHide: true
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^(true|false)$/);
  return result.stdout.trim();
}
test('structured body-only predicate refuses base, mixed, missing and unknown details', () => {
  for (const from of ['', 'old body', '{"title":"not an event key","base":{}}'])
    assert.equal(bodyOnly({action:'edited',changes:{body:{from}}}), 'true');
  const base = {ref:{from:'old-base'},sha:{from:'a'.repeat(40)}};
  for (const changes of [undefined, null, {}, [], 'body', {title:{from:'old'}}, {base},
    {body:{from:'old'},title:{from:'old'}}, {body:{from:'old'},base},
    {body:{from:'old'},unknown:true}, {unknown:true}, {body:{}},
    {body:{from:null}}, {body:{from:7}}, {body:{from:true}},
    {body:{from:'old',unknown:true}}, {body:'old'}])
    assert.equal(bodyOnly({action:'edited',changes}), 'false', JSON.stringify(changes));
  assert.equal(bodyOnly({action:'synchronize',changes:{body:{from:'old'}}}), 'false');
});
test('actual names and guards isolate metadata without masking normal application results', () => {
  const ci = workflow('ci');
  const metadataIndex = ci.jobs.title.steps.findIndex(s => s.id === 'metadata');
  assert.ok(metadataIndex >= 0 && metadataIndex < ci.jobs.title.steps.findIndex(s => s.uses?.startsWith('amannn/')));
  assert.equal(ci.jobs.title.outputs.body_only, expr('steps.metadata.outputs.body_only'));
  for (const body_only of ['true','false','']) {
    const context = {github:{event_name:'pull_request'}, needs:{
      title:{result:'success',outputs:{body_only,application:'true'}},
      checks:{result:body_only==='true'?'skipped':'success',outputs:{application:'true'}}
    }};
    assert.equal(evaluate(ci.jobs.checks.name,context).coerceString(), body_only==='true'?'PR metadata (no source checks)':'Checks');
    assert.equal(evaluate(ci.jobs.application.name,context).coerceString(), body_only==='true'?'PR metadata (no artifact jobs)':'application');
    assert.equal(evaluate(ci.jobs.checks.if,context).coerceString(), body_only==='true'?'false':'true');
    assert.equal(evaluate(ci.jobs.application.if,context).coerceString(), body_only==='true'?'false':'true');
    context.needs.title.result='failure';
    assert.equal(evaluate(ci.jobs.checks.if,context).coerceString(),'false');
    if (body_only==='true') assert.notEqual(evaluate(ci.jobs.checks.name,context).coerceString(),'Checks');
  }
});
test('main skipped-title and failed or canceled prerequisites keep real stage gates', () => {
  const ci = workflow('ci');
  const context = {github:{event_name:'push'},needs:{
    title:{result:'skipped',outputs:{}},checks:{result:'success',outputs:{application:'true'}}
  }};
  assert.equal(evaluate(ci.jobs.checks.if,context).coerceString(),'true');
  assert.equal(evaluate(ci.jobs.application.if,context).coerceString(),'true');
  assert.equal(evaluate(ci.jobs.checks.name,context).coerceString(),'Checks');
  assert.equal(evaluate(ci.jobs.application.name,context).coerceString(),'application');
  for (const result of ['failure','cancelled','skipped']) {
    context.needs.checks.result=result;
    assert.equal(evaluate(ci.jobs.application.if,context).coerceString(),'false');
  }
  assert.equal(evaluate(ci.jobs.checks.if,context,true).coerceString(),'false');
  assert.equal(evaluate(ci.jobs.application.if,context,true).coerceString(),'false');
});

test('common source and dependency checks have exactly one owning job', () => {
  const checks = workflow('ci').jobs.checks;
  const pipeline = workflow('pipeline');
  const common = /cargo (?:fmt|clippy|test)|npm (?:run lint|test|run test:release|audit)|unittest discover|node --test cicd\/release\/fixtures\/workflow/;
  const sourceChecks = checks.steps.filter(step => common.test(step.run ?? ''));
  assert.ok(sourceChecks.length >= 4);
  assert.equal(checks.steps.filter(step => step.run === 'npm audit --prefix cicd/release/fixtures').length, 1);
  const tools = checks.steps.find(step => step.uses === './.github/actions/release-tools');
  assert.notEqual(tools.with?.['audit-dependencies'], 'false');
  for (const [jobName, job] of Object.entries(pipeline.jobs)) {
    for (const step of job.steps) {
      assert.ok(!repeatsCommonChecks(jobName, step), jobName + ' repeats a Checks-owned suite: ' + step.run);
      if (step.uses === './.github/actions/release-tools')
        assert.equal(step.with?.['audit-dependencies'], 'false', jobName + ' repeats the locked Python dependency audit');
    }
  }
  const action = parse(readFileSync(path.join(root, '.github/actions/release-tools/action.yml'), 'utf8'));
  assert.equal(action.inputs['audit-dependencies'].default, 'true');
  const audit = action.runs.steps.find(step => /pip_audit/.test(step.run ?? ''));
  assert.equal(audit.if, "inputs.audit-dependencies == 'true'");
});

test('docs-only runs retain title checks without compiling or entering the release queue', () => {
  const ci = workflow('ci'), pipeline = workflow('pipeline'), title = workflow('pr-title');
  assert.deepEqual(title.on.pull_request['branches-ignore'], ['main']);
  const steps = ci.jobs.checks.steps;
  assert.equal(steps.find(s => s.id === 'paths').with['predicate-quantifier'], 'every');
  assert.equal(ci.jobs.checks.outputs.application, expr("github.event_name == 'pull_request' && needs.title.outputs.application || steps.paths.outputs.application"));
  assert.equal(steps.find(s => s.id === 'paths').if, "github.event_name == 'push'");
  assert.equal(ci.jobs.title.outputs.application, expr('steps.paths.outputs.application'));
  assert.equal(ci.jobs.title.steps.find(s => s.id === 'paths').if, undefined, 'PR admission must actually classify its changed files');
  const titleSteps = ci.jobs.title.steps.filter(s => s.uses?.startsWith('amannn/'));
  assert.equal(titleSteps.length, 2);
  assert.ok(titleSteps.some(s => s.if.includes("outputs.application == 'true'")));
  assert.ok(titleSteps.some(s => s.if.includes("outputs.application != 'true'")));
  for (const step of steps) {
    if (/cargo |npm |node --test|pip install/.test(step.run ?? '') ||
        /rust-toolchain|setup-node|\.github\/actions\/release-tools/.test(step.uses ?? ''))
      assert.ok(step.if?.startsWith("(needs.title.outputs.application == 'true' || steps.paths.outputs.application == 'true')"), step.name ?? step.run ?? step.uses);
  }
  assert.equal(ci.concurrency, undefined, 'Docs runs must not enter the application queue');
  assert.ok(pipeline.concurrency);
  assert.equal(ci.jobs.application.with.release, expr("github.event_name == 'push' && github.ref == 'refs/heads/main'"));
});

test('only release may publish and it consumes the exact build artifacts without rebuilding', () => {
  const ci = workflow('ci'), pipeline = workflow('pipeline');
  assert.notEqual(ci.jobs.checks.permissions?.contents, 'write');
  for (const [name, job] of Object.entries(pipeline.jobs))
    if (name !== 'release') assert.notEqual(job.permissions?.contents, 'write');
  const build = pipeline.jobs.build, integration = pipeline.jobs.integration, release = pipeline.jobs.release;
  const freeze = build.steps.findIndex(s => s.id === 'freeze');
  const compile = build.steps.findIndex(s => /npm run build/.test(s.run ?? ''));
  assert.ok(freeze >= 0 && compile > freeze);
  assert.match(build.steps[freeze].run, /version --print-tag/);
  assert.ok(!build.steps.some(s => /--push|PATCH |POST /.test(s.run ?? '')));
  assert.ok(!integration.steps.some(s => /cicd\/release\/build.py build|cargo (?:build|test)|npm run build/.test(s.run ?? '')));
  assert.ok(!integration.steps.some(s => /rust-toolchain|cargo-xwin/.test(s.uses ?? '') ||
    s.with?.repository === 's116821/ReMarkableBuddies'));
  for (const job of [integration, release]) {
    const downloads = job.steps.filter(s => s.uses?.startsWith('actions/download-artifact'));
    assert.ok(downloads.some(s => s.with['artifact-ids'] === expr('needs.build.outputs.artifact_id')));
    assert.ok(!downloads.some(s => String(s.with['artifact-ids']).includes('uploader')));
  }
  assert.equal(release.env.TAG, expr('needs.build.outputs.tag'));
  assert.equal(release.env.SHA, expr('needs.build.outputs.sha'));
  const tag = release.steps.findIndex(s => s.name === 'Official tag only after every preceding job passed');
  assert.ok(tag > release.steps.findIndex(s => s.name === 'Verify the exact integration-tested upload inventory'));
  assert.ok(!release.steps.some(s => /cross build|npm run build|coordinator\.py/.test(s.run ?? '')));
  const upload = release.steps.find(s => s.uses === 'svenstaro/upload-release-action@29e53e917877a24fad85510ded594ab3c9ca12de');
  assert.equal(upload.with.overwrite, false); assert.equal(upload.with.draft, true);
  assert.equal(upload.with.promote, false); assert.equal(upload.with.check_duplicates, true);
  assert.equal(upload.with.release_id, expr('steps.retained.outputs.release_id'));
});

if (manager) test('Windows integration stops at each failed native command', () => {
  const integration = workflow('pipeline').jobs.integration;
  const step = integration.steps.find(s => s.if === "runner.os == 'Windows'" && /npm run test:hosts/.test(s.run ?? ''));
  assert.ok(step);
  const native = integration.steps.filter(s => s.name === 'Preserve Windows native API and NTFS custody controls');
  assert.equal(native.length, 1, 'Run selected native controls exactly once');
  const nativeIndex = integration.steps.indexOf(native[0]);
  assert.ok(nativeIndex > integration.steps.findIndex(s => s.name === 'Set trusted host interpreter for retained-package controls'));
  assert.ok(nativeIndex < integration.steps.findIndex(s => /npx playwright install/.test(s.run ?? '')));
  assert.ok(nativeIndex < integration.steps.indexOf(step), 'Fail before long UI suites if native custody is broken');
  const commands = step.run.trim().split('\n').map(s => s.trim());
  assert.deepEqual(commands.slice(0, 4), ['npm run test:hosts','npm run test:package','npm run test:wired-hosts','npm run test:wired-hosts -- --packaged']);
  assert.ok(commands.every(command => /^npm run test:[a-z-]+(?: -- --packaged)?$/.test(command)));
  assert.equal(step.shell ?? integration.defaults.run.shell, 'bash');
  for (let failAt=1; failAt<=commands.length; failAt++) {
    const setup = 'calls=0\nnpm() { calls=$((calls+1)); printf "called:%s\\n" "$calls"; if test "$calls" -eq ' + failAt + '; then return 17; fi; }\n';
    const result = spawnSync(process.env.CI_BASH || 'bash', ['--noprofile','--norc','-e','-o','pipefail','-c',setup+step.run],
      {encoding:'utf8', windowsHide:true});
    assert.ifError(result.error);
    assert.equal(result.status, 17, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, failAt, 'Commands after a failure must not run');
  }
});

function repeatsCommonChecks(jobName, step) {
  const common = /cargo (?:fmt|clippy|test)|npm (?:run lint|test|run test:release|audit)|unittest discover|node --test cicd\/release\/fixtures\/workflow/;
  const selectedWindowsControls = new Set([
    'python -m unittest discover -s tests/wired -p test_windows.py -k WindowsNative -v',
    'python -m unittest discover -s tests/drive -p test_store.py -k test_actual_broad_ntfs_grant_refuses -v',
    'python -m unittest discover -s tests/drive -p test_store.py -k test_isolated_writer_process_exit_releases_lock_without_touching_oauth -v',
  ]);
  if (jobName !== 'integration' || step.if !== "runner.os == 'Windows'" || step.shell !== 'bash')
    return common.test(step.run ?? '');
  return (step.run ?? '').split('\n').some(line => common.test(line) && !selectedWindowsControls.has(line.trim()));
}

test('Build retains ordinary commands before compiling target-specific test harnesses', () => {
  const pipeline = workflow('pipeline'), build = pipeline.jobs.build;
  const admission = build.steps.find(s => s.id === 'oracle_pin');
  const checkout = build.steps.find(s => s.with?.repository === 's116821/ReMarkableBuddies');
  assert.ok(admission && checkout);
  assert.match(admission.run, /check-ignore/);
  assert.match(admission.run, /Missing reviewed notice input/);
  assert.equal(checkout.with.path, 'out/buddy-oracle-source');
  assert.equal(checkout.with.ref, expr('steps.oracle_pin.outputs.source_sha'));
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  const rust = build.steps.find(s => s.uses?.startsWith('dtolnay/rust-toolchain@'));
  assert.equal(String(rust.with.toolchain), '1.98.1');
  assert.equal(rust.with.targets, 'x86_64-unknown-linux-gnu,x86_64-pc-windows-msvc');
  const install = build.steps.find(s => s.uses?.startsWith('taiki-e/install-action@'));
  assert.equal(install.uses, 'taiki-e/install-action@cfdb7ed4ccc7c7dce37759eae89dc5674b469b39');
  assert.equal(install.with.tool, 'cargo-xwin@0.23.1,cargo-about@0.9.3,cargo-binstall@1.26.2');
  assert.equal(install.with.fallback, 'none');
  assert.equal(install.with.checksum, true);
  const llvm = build.steps.find(s => s.uses?.startsWith('KyleMayes/install-llvm-action@'));
  assert.equal(llvm.uses, 'KyleMayes/install-llvm-action@ebc0426251bc40c7cd31162802432c68818ab8f0');
  assert.equal(llvm.with.version, '22.1.8');
  assert.match(llvm.with['force-url'], /llvmorg-22\.1\.8\/LLVM-22\.1\.8-Linux-X64\.tar\.xz$/);
  const compile = build.steps.find(s => s.name === 'Build and retain both ordinary host commands before their test harnesses');
  const pack = build.steps.find(s => s.name === 'Assemble fixed release inventory');
  assert.ok(build.steps.indexOf(checkout) < build.steps.indexOf(compile));
  assert.ok(build.steps.indexOf(compile) < build.steps.indexOf(pack));
  for (const field of ['sourceSha', 'sourceTree', 'cargoLockSha256', 'sdkRevision', 'READER_BUDDY_VERSION',
    'build-script-executed', 'compiler-artifact', 'package_id', 'COPYRIGHT-library.html', 'Apache-2.0.txt', 'MIT.txt'])
    assert.ok(compile.run.includes(field), field);
  const copied = compile.run.indexOf('shutil.copy2(ordinary, binary)');
  const testCompile = compile.run.indexOf("test_args = prefix + ['test'");
  assert.ok(copied > 0 && testCompile > copied);
  assert.match(compile.run.slice(testCompile), /'--no-run'/);
  assert.match(compile.run, /'--bin', 'reader-buddy'/);
  assert.match(compile.run, /'--test', 'archive_cli'/);
  assert.match(compile.run, /CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS/);
  assert.match(compile.run, /'target-feature=\+crt-static'/);
  assert.match(compile.run, /'PREBUILT_NASM': '0', 'NO_ASM': '0'/);
  assert.doesNotMatch(compile.run, /--include-local|Wine|\['.*reader-buddy.*', '--version'\]/);
  assert.match(compile.run, /Foreign Git SDK notices missing/);
  assert.match(compile.run, /'llvm-readobj', '--coff-imports'/);
  assert.match(compile.run, /Unexpected dynamic Microsoft CRT dependency/);
  assert.match(compile.run, /not policy.get\('private', \{\}\).get\('ignore', False\)/);
  assert.match(pack.run, /--oracle-root "\$ORACLE_ROOT"/);
  const development = build.steps.find(s => s.id === 'development');
  assert.equal(development.with.path, 'test-results/development/browser/\ntest-results/development/host-oracle/buddy-host-tests.tar\n');
  const tar = build.steps.find(s => s.name === 'Retain the CI-only host tests without duplicating shipping commands');
  assert.ok(build.steps.indexOf(tar) > build.steps.indexOf(pack));
  assert.match(tar.run, /path.name not in \('reader-buddy', 'reader-buddy.exe'\)/);
});

test('Integration and Release use original Build provenance and never rebuild the shipping command', () => {
  const pipeline = workflow('pipeline'), integration = pipeline.jobs.integration, release = pipeline.jobs.release;
  for (const job of [integration, release]) {
    const download = job.steps.find(s => s.with?.['artifact-ids'] === expr('needs.build.outputs.development_artifact_id'));
    const extract = job.steps.find(s => s.name === 'Validate and extract the original Build host test receipt');
    const verify = job.steps.find(s => /cicd\/release\/build.py verify/.test(s.run ?? ''));
    assert.ok(download && extract && verify);
    assert.equal(download.with.path, 'test-results/development');
    assert.ok(job.steps.indexOf(download) < job.steps.indexOf(extract));
    assert.ok(job.steps.indexOf(extract) < job.steps.indexOf(verify));
    assert.equal(extract.if, undefined);
    assert.match(extract.run, /Unexpected CI tar membership/);
    assert.match(extract.run, /provenance_sha256/);
    for (const step of job.steps.filter(s => /cicd\/release\/(?:build.py verify|verify_release.py retained)/.test(s.run ?? '')))
      assert.match(step.run, /--oracle-root "\$ORACLE_ROOT"/);
  }
  const bound = integration.steps.find(s => s.name === 'Bind the native retained test to the unpacked shipping oracle');
  const tests = integration.steps.find(s => s.name === 'Exercise the retained command through the precompiled archive tests');
  const native = integration.steps.find(s => s.name === 'Verify native Windows resource locking with the retained command');
  const producer = integration.steps.find(s => s.name === 'Verify actual producer packages through the retained Manager oracle');
  const after = integration.steps.find(s => s.name === 'Confirm native tests preserved command, harness and original provenance bytes');
  const zip = integration.steps.find(s => s.name === 'Confirm native qualification preserved every original ZIP');
  for (const step of [bound, tests, producer, after, zip]) { assert.ok(step); assert.equal(step.if, undefined); }
  for (const [left, right] of [[bound,tests],[tests,native],[native,producer],[producer,after],[after,zip]])
    assert.ok(integration.steps.indexOf(left) < integration.steps.indexOf(right));
  assert.equal(native.if, "runner.os == 'Windows'");
  assert.equal(native.run, "node --test --test-name-pattern '^native Windows' tests/isolated-backup-verifier.test.mjs");
  assert.equal(producer.env.MANAGER_REQUIRE_RETAINED_ORACLE, '1');
  assert.equal(producer.run, "node --test --test-name-pattern '^retained host oracle' tests/isolated-backup-retained.test.mjs");
  for (const key of ['COMMAND', 'BYTES', 'SHA256']) assert.ok(bound.run.includes('READER_BUDDY_ARCHIVE_TEST_' + key));
  assert.match(bound.run, /out\/packages\/ReMarkableBuddiesManager-/);
  assert.match(bound.run, /original == manager \/ 'out\/buddy-oracle-source'/);
  assert.match(bound.run, /source-fixtures/);
  assert.match(bound.run, /command = os.path.realpath\(/);
  assert.match(tests.run, /os.environ\['ORACLE_TEST_EXECUTABLE'\], '--nocapture'/);
  assert.doesNotMatch(tests.run, /cargo|--skip|--exact/);
  assert.match(after.run, /provenance_sha256/);
  assert.match(zip.run, /--oracle-root "\$ORACLE_ROOT"/);
  assert.equal(repeatsCommonChecks('integration', tests), false);
  assert.equal(repeatsCommonChecks('integration', {...tests, run: tests.run + '\ncargo test'}), true);
});

test('Cargo JSON selection refuses foreign, duplicated, feature-unified and wrong-target artifacts', () => {
  const build = workflow('pipeline').jobs.build.steps.find(s => s.name === 'Build and retain both ordinary host commands before their test harnesses');
  const source = build.run.match(/^python - <<'PY'\n([\s\S]*)\nPY\s*$/)?.[1];
  assert.ok(source);
  const fixture = String.raw`
import ast, copy, json, pathlib, subprocess, sys, tempfile
from types import SimpleNamespace
source = ast.parse(sys.stdin.read())
functions = ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('cargo_messages', 'executable')], type_ignores=[])
with tempfile.TemporaryDirectory() as temporary:
    target_dir = pathlib.Path(temporary) / 'target'
    target = 'x86_64-unknown-linux-gnu'
    ordinary = target_dir / target / 'release/reader-buddy'
    ordinary.parent.mkdir(parents=True)
    ordinary.write_text('synthetic source fixture; no compiler is invoked')
    harness = ordinary.parent / 'deps/archive_cli-fixture'
    harness.parent.mkdir()
    harness.write_text('synthetic test fixture')
    selected = dict(reason='compiler-artifact', package_id='root-id', target=dict(name='reader-buddy',kind=['bin']), executable=str(ordinary), features=[], profile=dict(test=False))
    namespace = dict(json=json, Path=pathlib.Path, root_id='root-id', target_dir=target_dir, source=pathlib.Path(temporary))
    exec(compile(functions, '<actual workflow parser>', 'exec'), namespace)
    choose = namespace['executable']
    assert choose([selected], 'reader-buddy', 'bin', target) == ordinary
    test = copy.deepcopy(selected)
    test.update(target=dict(name='archive_cli',kind=['test']), executable=str(harness), profile=dict(test=True))
    assert choose([test], 'archive_cli', 'test', target) == harness
    def refuse(records, name='reader-buddy', kind='bin', selected_target=target):
        try: choose(records, name, kind, selected_target)
        except (AssertionError, OSError): return
        raise AssertionError('admitted invalid Cargo artifact')
    refuse([]); refuse([selected, selected]); refuse([selected], selected_target='x86_64-pc-windows-msvc')
    for field, value in [('package_id','foreign-id'),('features',['simulator']),('profile',dict(test=True)),('target',dict(name='other',kind=['bin']))]:
        wrong = copy.deepcopy(selected); wrong[field] = value; refuse([wrong])
    wrong = copy.deepcopy(test); wrong['executable'] = str(ordinary)
    refuse([wrong], 'archive_cli', 'test')
    # Exercise the real line parser with a fake subprocess that only writes the
    # supplied transcript. No cargo process, toolchain or executable is run.
    transcript = []
    def run(arguments, **kwargs):
        assert arguments == ['fixture-only']
        kwargs['stdout'].write(('maintained xwin progress\n' + '\n'.join(json.dumps(r) for r in transcript) + '\n').encode())
    namespace['subprocess'] = SimpleNamespace(run=run)
    parse_messages = namespace['cargo_messages']
    finished = dict(reason='build-finished', success=True)
    for index, (messages, valid) in enumerate([([selected,finished],True),([selected],False),([selected,finished,finished],False),([selected,dict(reason='build-finished',success=False)],False)]):
        transcript[:] = messages
        try: result = parse_messages(['fixture-only'], pathlib.Path(temporary) / (str(index)+'.jsonl'), {})
        except AssertionError:
            assert not valid
        else:
            assert valid and result == messages
print('Cargo JSON source fixtures passed')
`;
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', fixture], {input: source, encoding:'utf8', windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cargo JSON source fixtures passed/);
});

test('Windows input receipt preserves the maintained cache and rejects unattributed bytes', () => {
  const build = workflow('pipeline').jobs.build.steps.find(s => s.name === 'Build and retain both ordinary host commands before their test harnesses');
  const source = build.run.match(/^python - <<'PY'\n([\s\S]*)\nPY\s*$/)?.[1];
  assert.ok(source);
  const fixture = String.raw`
import ast, hashlib, json, pathlib, shutil, sys, tempfile
from types import SimpleNamespace
source = ast.parse(sys.stdin.read())
functions = ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('sha', 'write', 'prime_windows')], type_ignores=[])
for scenario in ('valid', 'unattributed', 'changed-package', 'changed-ucrt', 'existing-cache'):
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        receipt = root / 'retained'
        receipt.mkdir()
        base = root / 'managed'
        cache = base / 'xwin'
        payload = b'synthetic payload; no compiler or network operation'
        payload_hash = hashlib.sha256(payload).hexdigest()
        calls = []
        if scenario == 'existing-cache':
            cache.mkdir(parents=True)
        def run(arguments, **kwargs):
            calls.append(arguments)
            assert '--cache-dir' in arguments and arguments[arguments.index('--cache-dir') + 1] == str(cache)
            if arguments[-1] == 'list':
                assert arguments[-3:-1] == ['--manifest-version', '17']
                (cache / 'dl').mkdir(parents=True)
                (cache / 'dl/manifest_17.json').write_text('{"channelItems":[]}')
                packages = [dict(id='fixture-sdk', version='2' if scenario == 'changed-package' else '1',
                    payloads=[dict(fileName='input.cab', sha256=payload_hash, size=len(payload), url='https://example.invalid')])]
                packages.append(dict(id='fixture-ucrt', version='2' if scenario == 'changed-ucrt' else '1',
                    payloads=packages[0]['payloads']))
                (cache / 'dl/pkg_manifest_fixture.vsman').write_text(json.dumps(dict(packages=packages)))
            else:
                assert arguments[-1] == 'download'
                assert arguments[-3:-1] == ['--manifest', str(cache / 'dl/manifest_17.json')]
                assert '--manifest-version' not in arguments
                cabinet = cache / 'dl/sdk-layout/Installers/input.cab'
                cabinet.parent.mkdir(parents=True)
                cabinet.write_bytes(payload)
                if scenario == 'unattributed':
                    (cache / 'dl/unexpected').write_bytes(b'not in publisher metadata')
            kwargs['stdout'].write(b'synthetic maintained CLI output')
        namespace = dict(hashlib=hashlib, json=json, Path=pathlib.Path, shutil=shutil,
            subprocess=SimpleNamespace(run=run, STDOUT=-2),
            vendor_inputs=dict(selectedPackages=[dict(id='fixture-sdk', version='1'), dict(id='fixture-ucrt', version='1')]))
        exec(compile(functions, '<actual workflow receipt>', 'exec'), namespace)
        try:
            logs = namespace['prime_windows'](receipt, dict(XWIN_CACHE_DIR=str(base)))
        except AssertionError:
            assert scenario != 'valid'
            if scenario == 'existing-cache':
                assert not calls
        else:
            assert scenario == 'valid' and len(calls) == 2
            assert not (cache / 'DONE').exists()
            recorded = json.loads((receipt / 'xwin-inputs.json').read_text())
            assert recorded['files']['sdk-layout/Installers/input.cab']['sha256'] == payload_hash
            assert recorded['packages'][0]['id'] == 'fixture-sdk'
            assert (receipt / 'xwin-channel.json').read_bytes() == (cache / 'dl/manifest_17.json').read_bytes()
            assert (receipt / 'xwin-packages.vsman').read_bytes() == (cache / 'dl/pkg_manifest_fixture.vsman').read_bytes()
            assert set(logs) == {p.name for p in receipt.iterdir()}
print('Windows input receipt source fixtures passed')
`;
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', fixture], {input: source, encoding:'utf8', windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Windows input receipt source fixtures passed/);
});

test('Windows native selections preserve platform coverage without admitting repeated common suites', () => {
  const selected = {
    if: "runner.os == 'Windows'", shell: 'bash',
    run: 'python -m unittest discover -s tests/wired -p test_windows.py -k WindowsNative -v',
  };
  assert.equal(repeatsCommonChecks('integration', selected), false);
  assert.equal(repeatsCommonChecks('integration', {...selected, run: 'python -m unittest discover -s tests/drive -p test_store.py -k test_actual_broad_ntfs_grant_refuses -v'}), false);
  assert.equal(repeatsCommonChecks('integration', {...selected, run: 'python -m unittest discover -s tests/drive -p test_store.py -k test_isolated_writer_process_exit_releases_lock_without_touching_oauth -v'}), false);
  assert.equal(repeatsCommonChecks('integration', {...selected, run: 'python -m unittest discover -s tests/drive -p test_store.py -k test_isolated -v'}), true);
  assert.equal(repeatsCommonChecks('build', selected), true);
  assert.equal(repeatsCommonChecks('integration', {...selected, if: undefined}), true);
  assert.equal(repeatsCommonChecks('integration', {...selected, if: "runner.os == 'Linux'"}), true);
  assert.equal(repeatsCommonChecks('integration', {...selected, shell: 'pwsh'}), true);
  assert.equal(repeatsCommonChecks('integration', {...selected, run: 'python -m unittest discover -s tests/wired -v'}), true);
  assert.equal(repeatsCommonChecks('integration', {...selected, run: selected.run + '\nnpm test'}), true);
  assert.equal(repeatsCommonChecks('integration', {...selected, run: selected.run + ' && npm test'}), true);
});

