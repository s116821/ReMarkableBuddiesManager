"""Manager-specific gates augment the real Git/tag/retry regression fixtures."""
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import coordinator as release
from policy import git
from test_release import Fixture, Publisher, CLIFF

ROOT = Path(__file__).resolve().parents[1]

class FoundationTests(unittest.TestCase):
    def test_initial_application_tag_follows_documentation_only_baseline(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            f = Fixture(Path(temp))
            git(f.repo, 'tag', '-d', 'v0.1.12')
            # An untagged application gets git-cliff's configured initial version.
            self.assertEqual(f.plan().tag, 'v0.1.0')
            # A fresh documentation-only project must not manufacture a baseline tag.
            docs = Path(temp) / 'docs'
            docs.mkdir()
            git(docs, 'init', '-b', 'main')
            git(docs, 'config', 'user.name', 'Fixture')
            git(docs, 'config', 'user.email', 'fixture@example.invalid')
            (docs / 'README.md').write_text('docs')
            git(docs, 'add', '.')
            git(docs, 'commit', '-m', 'Initial commit')
            self.assertIsNone(release.plan(docs, 'main'))

    def test_major_publication_gate(self):
        for tag in ('v1.0.0', 'v2.0.0', 'v0.01.0', 'not-a-tag'):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, 'REM-35'):
                release.allow_publication(release.Release(tag, 'a' * 40))
        release.allow_publication(release.Release('v0.99.0', 'a' * 40))

    def test_cross_packaged_linux_keeps_executable_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'source'
            source.mkdir()
            for name in ('ReMarkableBuddiesManager', 'chrome-sandbox', 'chrome_crashpad_handler', 'data.pak'):
                (source / name).write_bytes(b'fixture')
            archive = Path(temp) / 'linux.zip'
            release.archive_package(source, archive, linux=True)
            with zipfile.ZipFile(archive) as package:
                for item in package.infolist():
                    self.assertEqual((item.external_attr >> 16) & 0o777, 0o644 if item.filename == 'data.pak' else 0o755)

    def test_first_untagged_release_recovers_failed_build_before_later_commit(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            f = Fixture(Path(temp))
            git(f.repo, 'tag', '-d', 'v0.1.12')
            git(f.repo, 'push', 'origin', ':refs/tags/v0.1.12')
            first = git(f.repo, 'rev-parse', 'HEAD')
            publisher = Publisher()
            def fail(repo, candidate, directory):
                self.assertEqual(candidate, release.Release('v0.1.0', first))
                self.assertEqual(git(repo, 'ls-remote', 'origin', 'refs/tags/v0.1.0^{}').split()[0], first)
                raise RuntimeError('first build interrupted')
            with self.assertRaisesRegex(RuntimeError, 'first build interrupted'):
                release.publish_all(f.repo, publisher, fail, CLIFF)
            second = f.commit('feat(REM-21): later application', 'src/app.ts')
            f.push()
            built = []
            release.publish_all(f.repo, publisher, lambda repo, candidate, directory: built.append(candidate), CLIFF)
            self.assertEqual(built, [release.Release('v0.1.0', first), release.Release('v0.2.0', second)])
            release.publish_all(f.repo, publisher, lambda repo, candidate, directory: built.append(candidate), CLIFF)
            self.assertEqual(len(built), 2)

    def test_every_application_ci_step_is_gated_but_required_job_completes(self):
        source = (ROOT / '.github/workflows/ci.yml').read_text()
        block = source.split('  check:\n', 1)[1]
        self.assertIn('if: always()', block)
        self.assertIn('test "$POLICY_RESULT" = success', block)
        for step in block.split('\n      - ')[2:]:
            self.assertIn("if: github.event_name == 'pull_request' && needs.policy.outputs.application == 'true'", step)

    def test_release_lock_includes_tag_build_publish_and_ignores_docs(self):
        source = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertNotIn('\nconcurrency:', source)
        block = source.split('  publish:\n', 1)[1]
        self.assertIn("if: needs.policy.outputs.application == 'true'", block)
        self.assertIn('    concurrency:\n', block)
        self.assertIn('cancel-in-progress: false', block)
        self.assertIn('python release/coordinator.py publish', block)
        self.assertNotIn('tags:', source)
        self.assertNotIn('npm run build', source)

    def test_no_component_openspec_and_package_version_not_release_authority(self):
        self.assertFalse((ROOT / 'openspec').exists())
        self.assertFalse((ROOT / '.codex/skills').exists())
        self.assertEqual(json.loads((ROOT / 'package.json').read_text())['version'], '0.0.0')
