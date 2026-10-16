"""Opt-in Linux public-key-only observation of Main's original two-target test fixture."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

if sys.argv[1:] == ["--observe"]:
    sys.path.insert(0, str(Path(__file__).parent))

from qualify import digest, regular, validate_source

PATTERN = '${name}-${version}.${arch}.apk'
SOURCE_REPO = 'https://github.com/s116821/ReMarkableBuddies'
TARGETS = {'armv7': ('armv7-unknown-linux-gnueabihf', 'gnu-arm-eabihf'),
           'aarch64': ('aarch64-unknown-linux-gnu', 'gnu-aarch64')}
MODES = {'usr/bin/reader-buddy': 493, 'usr/share/remarkable-buddies/LICENSE': 420,
         'usr/share/remarkable-buddies/build.json': 420}
DIRECTORIES = {'usr', 'usr/bin', 'usr/share', 'usr/share/remarkable-buddies'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def strict(raw, limit=65536):
    require(len(raw) <= limit, 'JSON bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON member')
            result[key] = value
        return result
    def constant(_):
        raise ValueError('Nonfinite JSON')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def pin(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value), 'SHA256 pin required')
    return value


def snapshot(root):
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'Regular files/directories only')
        item = {'mode': stat.S_IMODE(info.st_mode), 'kind': 'directory'}
        if path.is_file():
            item.update(kind='file', bytes=info.st_size, sha256=digest(path))
        result[str(path.relative_to(root))] = item
    return result


def bounded_run(argv, timeout=15, limit=65536, cleanup=None, env=None):
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, env=env)
    streams = [bytearray(), bytearray()]
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            for index, stream in enumerate((process.stdout, process.stderr)):
                selector.register(stream, selectors.EVENT_READ, index)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'Observation timeout')
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        streams[key.data].extend(chunk)
                        require(sum(map(len, streams)) <= limit, 'Observation output bound')
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'Observation timeout')
            code = process.wait(timeout=remaining)
        return code, bytes(streams[0]), bytes(streams[1])
    except BaseException:
        try:
            if cleanup:
                cleanup()
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)
        raise
    finally:
        process.stdout.close()
        process.stderr.close()


def admit(root, manifest_pin):
    require(root.is_dir() and not root.is_symlink(), 'Regular input directory required')
    manifest_file = regular(root / 'hash-manifest.json')
    require(manifest_file.stat().st_size <= 16384 and digest(manifest_file) == pin(manifest_pin),
            'Independent manifest digest mismatch')
    manifest = strict(manifest_file.read_bytes(), 16384)
    require(type(manifest['schema']) is int and manifest['schema'] == 1 and
            manifest['purpose'] == 'host-only-offline-consumer-test-fixture' and
            manifest['profile'] == 'legacy-no-sdk' and manifest['eligibility'] == 'not-qualified' and
            manifest['installation_eligible'] is False and manifest['private_key_included'] is False and
            manifest['transport_zip_only'] is True, 'Only installation-ineligible legacy test fixture')
    source = manifest['source']
    require(set(source) == {'repository', 'sha', 'tag', 'epoch'} and source['repository'] == SOURCE_REPO and
            re.fullmatch('v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)', source['tag']) and
            len(source['tag']) <= 64 and re.fullmatch('[0-9a-f]{40}', source['sha']) and
            type(source['epoch']) is int and 0 <= source['epoch'] <= 2**63-1, 'Fixture source identity')
    names = {f'remarkable-buddies-{source["tag"][1:]}-r0.{arch}.apk' for arch in TARGETS}
    names |= {'buddy-index.adb', 'fixture.pub', 'test-key-build-receipt.json'}
    require(set(manifest['artifacts']) == names and
            {p.name for p in root.iterdir()} == names | {'hash-manifest.json'}, 'Exact six public files required')
    for name, expected in manifest['artifacts'].items():
        path = regular(root / name)
        cap = 32 * 1024 * 1024 if name.endswith('.apk') else 65536
        require(set(expected) == {'bytes', 'sha256'} and type(expected['bytes']) is int and
                0 < expected['bytes'] <= cap and path.stat().st_size == expected['bytes'] and
                digest(path) == pin(expected['sha256']), 'Original artifact size/digest mismatch')
    receipt = strict((root / 'test-key-build-receipt.json').read_bytes())
    require(receipt['source'] == source and receipt['status'] == 'test-key-source-build-only' and
            receipt['eligibility'] == 'not-qualified', 'Reported producer receipt identity')
    expected_artifacts = {name: value for name, value in manifest['artifacts'].items()
                          if name != 'test-key-build-receipt.json'}
    require(receipt['artifacts'] == expected_artifacts and
            receipt['generation_observations']['artifact_files'] == expected_artifacts and
            receipt['generation_observations']['private_key_exported'] is False and
            receipt['public_key_observation']['private_key_available'] is False,
            'Public-only producer correspondence')
    return manifest, receipt


def metadata(package, index, arch, manifest, receipt):
    require(set(package) == {'info', 'paths'}, 'No package scripts/triggers/unknown members')
    info = package['info']
    source = manifest['source']
    observed = receipt['generation_observations']['packages'][arch]
    fields = {'name': 'remarkable-buddies', 'origin': 'remarkable-buddies',
              'version': source['tag'][1:] + '-r0', 'arch': arch, 'repo-commit': source['sha'],
              'build-time': source['epoch'], 'license': 'GPL-3.0',
              'description': 'ReMarkableBuddies test-key source-build package'}
    target, abi = TARGETS[arch]
    tags = {'abi': abi, 'binary-sha256': observed['payload']['usr/bin/reader-buddy']['sha256'],
            'contract': '1', 'eligibility': 'not-qualified', 'evidence': 'developer-source-build',
            'pkgrel': '0', 'profile': 'legacy-no-sdk', 'sdk-ref': 'absent',
            'source-repo': SOURCE_REPO, 'source-sha': source['sha'], 'source-tag': source['tag'],
            'target': target}
    fields['tags'] = ['remarkable-buddies:' + name + '=' + value for name, value in sorted(tags.items())]
    require(set(info) == set(fields) | {'installed-size', 'hashes'}, 'Exact initial package info fields')
    require(isinstance(info['hashes'], str) and re.fullmatch('[0-9a-f]{40}', info['hashes']), 'Pinned embedded package identity encoding')
    require(type(info['installed-size']) is int and info['installed-size'] == index['installed-size'] ==
            sum(item['bytes'] for item in observed['payload'].values()), 'Package/index installed size')
    filename = f'remarkable-buddies-{fields["version"]}.{arch}.apk'
    require(observed['apk_file_sha256'] == manifest['artifacts'][filename]['sha256'], 'Saved APK digest correspondence')
    for actual in (info, index):
        require(all(type(actual.get(k)) is type(v) and actual[k] == v for k, v in fields.items()),
                'Authenticated package/index source/tag correspondence')
    require(index['file-size'] == observed['apk_file_bytes'] ==
            manifest['artifacts'][f'remarkable-buddies-{fields["version"]}.{arch}.apk']['bytes'], 'Index file size')
    require(index['hashes'] == pin(observed['index_metadata_hash']) and
            observed['index_metadata_hash_algorithm'] == 'sha256' and
            observed['index_metadata_hash_encoding'] == 'lowercase-hex', 'Saved producer metadata identity')
    directories, files = set(), {}
    for directory in package['paths']:
        require(set(directory) <= {'name', 'acl', 'files'} and {'name', 'acl'} <= set(directory), 'Directory fields')
        name = directory['name']
        require(name in DIRECTORIES and name not in directories and
                directory['acl'] == {'mode': 493, 'user': 'root', 'group': 'root'}, 'Directory inventory/mode')
        directories.add(name)
        for item in directory.get('files', []):
            require(set(item) == {'name', 'acl', 'size', 'mtime', 'hash'}, 'Regular signed file fields')
            path = name + '/' + item['name']
            require(path in MODES and path not in files, 'Fixed signed file inventory')
            expected = observed['payload'][path]
            require(item['acl'] == {'mode': MODES[path], 'user': 'root', 'group': 'root'} and
                    type(item['mtime']) is int and item['mtime'] == source['epoch'] and
                    type(item['size']) is int and item['size'] == expected['bytes'] and
                    item['hash'] == pin(expected['sha256']), 'Signed file digest/size/mode/time')
            files[path] = expected
    require(directories == DIRECTORIES and set(files) == set(MODES) and
            set(observed['payload']) == set(MODES), 'Complete signed inventory')
    return {'full_version': fields['version'], 'source': source, 'arch': arch,
            'signed_payload': files, 'index_metadata_hash': index['hashes'],
            'package_embedded_hash': info['hashes'],
            'package_embedded_hash_basis': 'pinned mkpkg SHA1 UID; distinct from mkndx SHA256 identity',
            'index_hash_basis': 'matches saved producer regeneration; not independently regenerated',
            'apk_file_sha256': observed['apk_file_sha256'], 'apk_file_bytes': observed['apk_file_bytes']}


def observe(config):
    root, originals = Path('/fixtures'), Path('/originals')
    manifest, receipt = admit(originals, config['manifest_pin'])
    require(digest(Path('/tool/apk')) == config['tool_pin'], 'Mounted exact verifier digest')
    require(digest(Path(__file__)) == config['consumer_pin'] and
            digest(Path('/harness/qualify.py')) == config['qualification_pin'], 'Mounted exact consumer/helpers')
    for mount_path in ('/fixtures', '/originals', '/tool/apk', '/harness/real_fixture.py'):
        line = next((line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()
                     if line.split()[4] == mount_path), None)
        require(line is not None and 'ro' in line[5].split(','), 'Actual read-only observation mount required')
    require(os.geteuid() != 0, 'Nonroot observation required')
    before = (snapshot(root), snapshot(originals))
    env = {'PATH': '/usr/bin:/bin', 'APK_CONFIG': '/fixtures/meta/etc/apk/config',
           'HOME': '/tmp', 'TMPDIR': '/tmp', 'LC_ALL': 'C'}
    cases = []
    def command(args, negative=False):
        require(args[0] in {'verify', 'adbdump'}, 'Read-only applet allowlist')
        require(not any(a in {'--allow-untrusted', '--force', '--no-verify'} for a in args), 'Bypass refused')
        common = ['/tool/apk', '--root', '/fixtures/meta', '--install-root', '/fixtures/payload',
                  '--no-network', '--no-cache', '--no-logfile', '--repositories-file',
                  '/fixtures/meta/etc/apk/repositories']
        current = (snapshot(root), snapshot(originals))
        code, stdout, stderr = bounded_run(common + args, env=env)
        require(current == (snapshot(root), snapshot(originals)) and
                digest(Path('/tool/apk')) == config['tool_pin'], 'Observation changed inputs/roots/tool')
        classification = 'success'
        if negative:
            labels = {'UNTRUSTED signature': 'untrusted-signature', 'BAD signature': 'bad-signature',
                      'ADB integrity error': 'payload-integrity', 'file integrity error': 'file-integrity'}
            classification = labels.get(stdout.decode('utf-8').strip().rsplit(': ', 1)[-1])
            require(code == 1 and not stderr and classification is not None, 'Unrecognized actual verifier refusal')
        else:
            require(code == 0 and not stderr, 'Actual read-only command failed')
        record = {'exit_code': code, 'classification': classification, 'roots_unchanged': True,
                  'diagnostic_bytes': len(stdout) + len(stderr),
                  'stdout_sha256': hashlib.sha256(stdout).hexdigest(),
                  'stderr_sha256': hashlib.sha256(stderr).hexdigest()}
        return stdout, record
    code, der, stderr = bounded_run(['openssl', 'pkey', '-pubin', '-in',
                                    '/originals/fixture.pub', '-outform', 'DER'], limit=8192, env=env)
    require(code == 0 and not stderr and hashlib.sha256(der).hexdigest() == config['spki_pin'],
            'Actual public key differs from independent DER-SPKI pin')
    cases.append({'name': 'independent-public-key-pin', 'classification': 'success'})
    try:
        require(hashlib.sha256(der).hexdigest() == config['wrong_spki_pin'], 'Independent DER-SPKI pin mismatch')
    except ValueError:
        pass
    else:
        raise ValueError('Wrong-pin control ineffective')
    cases.append({'name': 'wrong-independent-pin', 'classification': 'pin-mismatch-refused'})
    dumps = {}
    for name in ['buddy-index.adb', *sorted(n for n in manifest['artifacts'] if n.endswith('.apk'))]:
        _, record = command(['verify', '--keys-dir', 'etc/apk/keys-good', '/originals/' + name])
        cases.append({'name': 'original-' + name, **record})
        raw, record = command(['adbdump', '--keys-dir', 'etc/apk/keys-good', '--format', 'json', '/originals/' + name])
        dumps[name] = strict(raw)
        cases.append({'name': 'metadata-' + name, **record})
    index = dumps['buddy-index.adb']
    require(set(index) == {'packages', 'pkgname-spec'} and index['pkgname-spec'] == PATTERN and
            isinstance(index['packages'], list) and len(index['packages']) == 2, 'Exact signed index root')
    entries = {}
    for entry in index['packages']:
        require(set(entry) == {'name', 'version', 'arch', 'origin', 'repo-commit', 'build-time', 'license',
                              'description', 'tags', 'hashes', 'file-size', 'installed-size'}, 'Exact index fields')
        arch = entry['arch']
        require(arch in TARGETS and arch not in entries, 'Both unique index architectures')
        require(type(entry['file-size']) is int and type(entry['installed-size']) is int, 'Index size types')
        entries[arch] = entry
    require(index == strict(receipt['generation_observations']['regenerated_index_readback'].encode()),
            'Signed original differs from saved producer comparison')
    packages = {arch: metadata(dumps[f'remarkable-buddies-{manifest["source"]["tag"][1:]}-r0.{arch}.apk'],
                               entries[arch], arch, manifest, receipt) for arch in TARGETS}
    arm = f'remarkable-buddies-{manifest["source"]["tag"][1:]}-r0.armv7.apk'
    for name, path, keys in [('wrong-public-key', '/originals/' + arm, 'wrong'),
                             ('changed-package-control', '/fixtures/changed-control.apk', 'good'),
                             ('changed-index-control', '/fixtures/changed-index.adb', 'good'),
                             ('changed-package-payload', '/fixtures/changed-payload.apk', 'good')]:
        _, record = command(['verify', '--keys-dir', 'etc/apk/keys-' + keys, path], negative=True)
        expected = {'payload-integrity', 'file-integrity'} if name.endswith('payload') else \
                   {'untrusted-signature'} if name == 'wrong-public-key' else {'bad-signature', 'untrusted-signature'}
        require(record['classification'] in expected, 'Wrong refusal class')
        cases.append({'name': name, **record})
    require(before == (snapshot(root), snapshot(originals)), 'Observation roots changed')
    return {'evidence_class': 'actual historical public-key-only host test fixture', 'cases': cases,
            'source': manifest['source'], 'packages': packages, 'installation_eligible': False,
            'update_eligible': False, 'profile': 'legacy-no-sdk', 'eligibility': 'not-qualified',
            'expected_spki_sha256': config['spki_pin'], 'private_key_available': False,
            'payloads_extracted_or_executed': False, 'roots_unchanged': True,
            'limits': 'No independent index regeneration, build.json content extraction, compiler/SDK/native/production trust/lifecycle qualification'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('inputs', 'manifest-sha256', 'expected-spki', 'apk', 'build-receipt', 'source-archive', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() != 0, 'Linux nonroot developer host required')
    originals = Path(args.inputs).absolute()
    require(not any(p.is_symlink() for p in [originals, *originals.parents]), 'Input root ancestors')
    manifest, receipt = admit(originals, args.manifest_sha256)
    pin(args.expected_spki)
    require(receipt['fixture_public_key_spki_sha256'] == args.expected_spki, 'Reported pin differs from external pin')
    apk, build_file, archive = map(regular, [args.apk, args.build_receipt, args.source_archive])
    require(build_file.stat().st_size <= 65536, 'Build receipt bound')
    build = strict(build_file.read_bytes())
    validate_source(build, apk, archive)
    image = build['runtime_image_id']
    require(re.fullmatch('sha256:[0-9a-f]{64}', image), 'Immutable local image required')
    code, observed, stderr = bounded_run(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'])
    require(code == 0 and not stderr and observed.decode().strip() == image, 'Runtime image mismatch')
    output = Path(args.output).absolute()
    require(output.parent.is_dir() and not output.exists() and
            not any(p.is_symlink() for p in [output, *output.parents]), 'New output under regular existing parent required')
    original_snapshot = snapshot(originals)
    consumer = regular(Path(__file__))
    qualification = regular(Path(__file__).with_name('qualify.py'))
    consumer_pin, qualification_pin = digest(consumer), digest(qualification)
    with tempfile.TemporaryDirectory(prefix='manager-real-fixture-') as temporary:
        root = Path(temporary)
        for name in ('meta/etc/apk/keys-good', 'meta/etc/apk/keys-wrong', 'payload'):
            (root / name).mkdir(parents=True)
        for name in ('config', 'repositories', 'world'):
            (root / 'meta/etc/apk' / name).write_text('')
        shutil.copyfile(originals / 'fixture.pub', root / 'meta/etc/apk/keys-good/fixture.pub')
        # Mutate only the public RSA modulus, preserving DER framing/exponent. No keypair/signing operation.
        pem = (originals / 'fixture.pub').read_text()
        der = bytearray(base64.b64decode(''.join(pem.splitlines()[1:-1]), validate=True))
        require(der[-5:] == bytes.fromhex('0203010001'), 'Expected fixture RSA public exponent')
        der[-8] ^= 1
        encoded = base64.b64encode(der).decode()
        (root / 'meta/etc/apk/keys-wrong/wrong.pub').write_text(
            '-----BEGIN PUBLIC KEY-----\n' + '\n'.join(encoded[i:i+64] for i in range(0, len(encoded), 64)) +
            '\n-----END PUBLIC KEY-----\n')
        arm = originals / f'remarkable-buddies-{manifest["source"]["tag"][1:]}-r0.armv7.apk'
        raw = arm.read_bytes()
        old = b'ReMarkableBuddies test-key source-build package'
        new = b'ReMarkableBuddies test-key source-build packagX'
        require(len(old) == len(new) and raw.count(old) == 1, 'Unique equal-length control target')
        (root / 'changed-control.apk').write_bytes(raw.replace(old, new))
        require(raw.count(b'\x7fELF') == 1, 'Unique raw ELF payload target')
        changed = bytearray(raw);changed[raw.index(b'\x7fELF') + 1024] ^= 1
        (root / 'changed-payload.apk').write_bytes(changed)
        index = (originals / 'buddy-index.adb').read_bytes()
        require(index.count(old) >= 1, 'Index signed control target')
        (root / 'changed-index.adb').write_bytes(index.replace(old, new, 1))
        config = {'manifest_pin': args.manifest_sha256, 'spki_pin': args.expected_spki,
                  'wrong_spki_pin': ('0' if args.expected_spki[0] != '0' else '1') + args.expected_spki[1:],
                  'tool_pin': build['binary_sha256'], 'consumer_pin': consumer_pin,
                  'qualification_pin': qualification_pin}
        (root / 'control.json').write_text(json.dumps(config))
        name = 'manager-real-fixture-' + uuid.uuid4().hex
        argv = ['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m',
                '--pids-limit', '32', '--user', f'{os.geteuid()}:{os.getegid()}',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--env', 'PYTHONDONTWRITEBYTECODE=1']
        for path, target in [(root, '/fixtures'), (originals, '/originals'), (apk, '/tool/apk'),
                             (consumer, '/harness/real_fixture.py'),
                             (qualification, '/harness/qualify.py')]:
            argv += ['--mount', f'type=bind,source={path},target={target},readonly']
        argv += ['--entrypoint', 'python3', image, '-I', '-B', '/harness/real_fixture.py', '--observe']
        # -I excludes script directory; internal entry explicitly adds the checked mounted harness path.
        def cleanup():
            result = subprocess.run(['docker', 'rm', '--force', name], capture_output=True, timeout=20)
            require(result.returncode == 0, 'Owned container cleanup unconfirmed')
        code, stdout, stderr = bounded_run(argv, timeout=120, limit=131072, cleanup=cleanup)
        require(code == 0 and not stderr, 'Observation failed; diagnostic SHA256 ' + hashlib.sha256(stdout + stderr).hexdigest())
        result = strict(stdout, 131072)
    require(original_snapshot == snapshot(originals) and digest(apk) == build['binary_sha256'] and
            digest(archive) == build['source_archive_sha256'] and digest(consumer) == consumer_pin and
            digest(qualification) == qualification_pin, 'Original/tool/archive/consumer changed')
    result.update(manifest_sha256=args.manifest_sha256, tool_source=build['source_revision'],
                  tool_binary_sha256=build['binary_sha256'], runtime_image_id=image,
                  build_receipt_sha256=digest(build_file), original_files=manifest['artifacts'],
                  helper_commit=manifest['helper_commit'], producer_docs_commit=manifest['docs_commit'],
                  consumer_sha256=consumer_pin, qualification_helper_sha256=qualification_pin)
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(f'PASS: {len(result["cases"])} focused actual-fixture observations; installation remains ineligible.')


if __name__ == '__main__':
    if sys.argv[1:] == ['--observe']:
        config = strict(Path('/fixtures/control.json').read_bytes(), 4096)
        print(json.dumps(observe(config), sort_keys=True))
    else:
        main()
