import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function buildInfo(repo = process.cwd(), env = process.env) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const sha = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
  const candidate = env.MANAGER_CANDIDATE_TAG !== undefined || env.MANAGER_CANDIDATE_SHA !== undefined;
  if (candidate && (env.MANAGER_RELEASE_TAG !== undefined || env.MANAGER_RELEASE_SHA !== undefined)) throw new Error('Candidate and published-tag metadata cannot be combined');
  const tag = candidate ? env.MANAGER_CANDIDATE_TAG : env.MANAGER_RELEASE_TAG;
  const expectedSha = candidate ? env.MANAGER_CANDIDATE_SHA : env.MANAGER_RELEASE_SHA;
  if (tag !== undefined || expectedSha !== undefined) {
    if (!/^v0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) throw new Error('Official version requires a pre-1.0 semantic tag; REM-35 owns 1.0');
    if (git('rev-parse', '--is-shallow-repository') !== 'false' || dirty) throw new Error('Official version requires clean full history');
    if ((!candidate && git('rev-parse', `${tag}^{commit}`) !== sha) || expectedSha !== sha) throw new Error('Official tag/SHA mismatch');
    return { version: tag.slice(1), sha, tag, official: true };
  }
  return { version: `0.0.0-dev-${sha.slice(0, 12)}${dirty ? '-dirty' : ''}`, sha, tag: null, official: false };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const content = JSON.stringify(buildInfo(), null, 2) + '\n';
  writeFileSync('src/build-info.json', content);
  writeFileSync('electron/build-info.json', content);
}
