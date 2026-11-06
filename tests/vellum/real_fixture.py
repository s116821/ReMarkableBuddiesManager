"""Opt-in Linux public-key-only observation of bounded two-target test fixtures."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
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
CURRENT = 'current-resident-fixture'
SDK_REPO = 'https://github.com/s116821/ReMarkableOpenSDK'
SDK_SHA = 'a0c6480be6785480c2e0da76a3c06697a18efae4'
BUNDLE_SHA = 'f9c4b44b9baf281bc47c74470ddd8d098853e79383e9323e5ff02ef2846fb477'
LIB = 'home/root/.local/lib/remarkable-buddies/'
RESIDENT_MODES = {LIB + name: 420 for name in ('Dobby-LICENSE', 'OpenSDK-LICENSE',
    'libremarkable-resident.so', 'resident-profile.json', 'resident-recovery.json')}
RESIDENT_MODES.update({LIB+'reader-buddy': 493,
    'usr/lib/systemd/system/reader-buddy.service': 420,
    'usr/lib/systemd/system/reader-buddy-stock-recovery.service': 420,
    'usr/share/remarkable-buddies/LICENSE': 420, 'usr/share/remarkable-buddies/build.json': 420})


def require(condition, message):
    if not condition:
        raise ValueError(message)


def same_json(left, right):
    """JSON identity without Python's bool/int/float equality aliases."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_json(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


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


def checked_manifest_bytes(path, expected_pin):
    with regular(path).open('rb') as stream:
        raw = stream.read(16385)
    require(len(raw) <= 16384 and hashlib.sha256(raw).hexdigest() == pin(expected_pin),
            'Independent manifest digest mismatch')
    return raw


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


def current_build(manifest, arch, receipt):
    """Check declared fixture metadata, never attest compiler or native behavior."""
    build = manifest['builds'][arch]
    require(type(build) is dict and set(build) == {'schema','evidence','eligibility','source','target','sdk','cargo','toolchain','build','binary'} and
            type(build['schema']) is int and build['schema'] == 1 and
            same_json(build['source'], manifest['source']) and build['evidence'] == 'developer-source-build' and
            build['eligibility'] == 'not-qualified', 'Current declared build identity')
    target, abi = TARGETS[arch]
    require(type(build['target']) is dict and
            same_json(build['target'], dict(rust_target=target,apk_arch=arch,abi=abi,
                elf_class=32 if arch=='armv7' else 64,elf_machine='ARM' if arch=='armv7' else 'AArch64',
                elf_endian='little',interpreter='/lib/ld-linux-armhf.so.3' if arch=='armv7' else '/lib/ld-linux-aarch64.so.1')),
            'Current target/ABI')
    sdk = build['sdk']
    require(type(sdk) is dict and set(sdk) == {'ref_kind','repository','sha','tag','manifest_sha256'} and
            sdk['repository'] == SDK_REPO and sdk['sha'] == SDK_SHA and sdk['ref_kind'] == 'tagged-git' and
            isinstance(sdk['tag'],str) and len(sdk['tag']) <= 64 and
            re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',sdk['tag']),
            'Current SDK identity')
    pin(sdk['manifest_sha256'])
    resident = arch == 'armv7'
    profile = build['build']
    require(type(profile) is dict and set(profile) == {'argv','environment','profile','source_build_helper_sha256'} and
            profile['profile'] == ('rm2-resident-test-key' if resident else 'unqualified-development') and
            isinstance(profile['argv'],list) and len(profile['argv']) <= 64 and
            all(isinstance(x,str) and 0 < len(x) <= 256 and all(32 <= ord(c) < 127 for c in x)
                for x in profile['argv']), 'Current build profile')
    pin(profile['source_build_helper_sha256'])
    environment=profile['environment']
    require(isinstance(environment,dict) and set(environment)=={'RUSTFLAGS','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS'} and
            all(isinstance(x,str) and len(x)<=1024 and all(32<=ord(c)<127 for c in x)
                for x in environment.values()),'Current declared environment')
    tools=build['toolchain']
    require(isinstance(tools,dict) and set(tools)=={'rustc_release','rustc_commit','rustc_host','cross_version',
            'cross_binary_sha256','image_digest','build_configuration_sha256'} and
            all(isinstance(tools[k],str) and 0<len(tools[k])<=128 and all(32<=ord(c)<127 for c in tools[k])
                for k in ('rustc_release','rustc_host','cross_version')) and
            (tools['rustc_commit'] is None or isinstance(tools['rustc_commit'],str) and re.fullmatch('[0-9a-f]{40}',tools['rustc_commit'])) and
            isinstance(tools['image_digest'],str) and tools['image_digest'].startswith('sha256:'),
            'Current declared toolchain')
    pin(tools['cross_binary_sha256']);pin(tools['build_configuration_sha256']);pin(tools['image_digest'][7:])
    require(type(build['cargo']) is dict and set(build['cargo']) == {'features','lock_sha256','metadata_identity_sha256'} and
            isinstance(build['cargo']['features'],list) and len(build['cargo']['features']) <= 64 and
            all(isinstance(x,str) and 0<len(x)<=128 and all(32 <= ord(c) < 127 for c in x)
                for x in build['cargo']['features']) and
            build['cargo']['features'] == sorted(set(build['cargo']['features'])) and
            ('installed-resident-output' in build['cargo']['features']) == resident and
            (not resident or profile['argv'][-2:] == ['--features','installed-resident-output']),
            'Current resident feature')
    pin(build['cargo']['lock_sha256']);pin(build['cargo']['metadata_identity_sha256'])
    modes = RESIDENT_MODES if resident else MODES
    payload = receipt['generation_observations']['packages'][arch]['payload']
    require(type(payload) is dict and set(payload) == set(modes), 'Current finite payload')
    for item in payload.values():
        require(type(item) is dict and set(item) == {'bytes','sha256'} and type(item['bytes']) is int and
                0 < item['bytes'] <= 64*1024*1024, 'Current payload size')
        pin(item['sha256'])
    binary = build['binary'];binary_path = LIB+'reader-buddy' if resident else 'usr/bin/reader-buddy'
    require(type(binary) is dict and set(binary) == {'path','bytes','sha256','mode'} and binary['path'] == binary_path and
            type(binary['mode']) is int and binary['mode'] == 493 and type(binary['bytes']) is int and
            {k:binary[k] for k in ('bytes','sha256')} == payload[binary_path], 'Current executable pin')
    raw = (json.dumps(build,sort_keys=True,separators=(',',':'),ensure_ascii=True)+'\n').encode()
    entry = payload['usr/share/remarkable-buddies/build.json']
    require(len(raw) <= 65536 and len(raw) == entry['bytes'] and
            hashlib.sha256(raw).hexdigest() == entry['sha256'], 'Canonical declared build bytes')
    return build, modes


def admit(root, manifest_pin, external_manifest=None):
    require(root.is_dir() and not root.is_symlink(), 'Regular input directory required')
    manifest_file = regular(external_manifest if external_manifest is not None else root / 'hash-manifest.json')
    if external_manifest is not None:
        require(manifest_file.absolute() == manifest_file.resolve() and
                not manifest_file.is_relative_to(root) and
                not any(p.is_symlink() for p in manifest_file.parents), 'Canonical external manifest required')
    raw_manifest = checked_manifest_bytes(manifest_file, manifest_pin)
    manifest = strict(raw_manifest, 16384)
    require(type(manifest) is dict, 'Fixture manifest object required')
    current = external_manifest is not None
    if current:
        require(set(manifest) == {'schema','purpose','profile','eligibility','installation_eligible',
                'private_key_included','source','helper_commit','docs_commit','license','builds','artifacts'} and
                manifest['schema'] == 2 and type(manifest['schema']) is int and
                manifest['profile'] == CURRENT and manifest['purpose'] == 'host-only-offline-consumer-test-fixture' and
                manifest['eligibility'] == 'not-qualified' and manifest['installation_eligible'] is False and
                manifest['private_key_included'] is False and manifest['license'] in ('GPL-3.0','GPL-3.0-only') and
                type(manifest['builds']) is dict and set(manifest['builds']) == set(TARGETS) and
                all(isinstance(manifest[k],str) and re.fullmatch('[0-9a-f]{40}',manifest[k])
                    for k in ('helper_commit','docs_commit')), 'Only explicit current test fixture')
    else:
        require(type(manifest['schema']) is int and manifest['schema'] == 1 and
            manifest['purpose'] == 'host-only-offline-consumer-test-fixture' and
            manifest['profile'] == 'legacy-no-sdk' and manifest['eligibility'] == 'not-qualified' and
            manifest['installation_eligible'] is False and manifest['private_key_included'] is False and
                manifest['transport_zip_only'] is True, 'Only installation-ineligible legacy test fixture')
    source = manifest['source']
    require(type(source) is dict and set(source) == {'repository', 'sha', 'tag', 'epoch'} and source['repository'] == SOURCE_REPO and
            type(source['tag']) is str and type(source['sha']) is str and
            re.fullmatch('v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)', source['tag']) and
            len(source['tag']) <= 64 and re.fullmatch('[0-9a-f]{40}', source['sha']) and
            type(source['epoch']) is int and 0 <= source['epoch'] <= 2**63-1, 'Fixture source identity')
    names = {f'remarkable-buddies-{source["tag"][1:]}-r0.{arch}.apk' for arch in TARGETS}
    names |= {'buddy-index.adb', 'fixture.pub', 'test-key-build-receipt.json'}
    require(type(manifest['artifacts']) is dict and set(manifest['artifacts']) == names and
            {p.name for p in root.iterdir()} == names | (set() if current else {'hash-manifest.json'}),
            'Exact public fixture files required')
    for name, expected in manifest['artifacts'].items():
        path = regular(root / name)
        cap = (64 if current else 32) * 1024 * 1024 if name.endswith('.apk') else 65536
        require(type(expected) is dict and set(expected) == {'bytes', 'sha256'} and type(expected['bytes']) is int and
                0 < expected['bytes'] <= cap and path.stat().st_size == expected['bytes'] and
                digest(path) == pin(expected['sha256']), 'Original artifact size/digest mismatch')
    receipt = strict((root / 'test-key-build-receipt.json').read_bytes())
    require(type(receipt) is dict and {'source','status','eligibility','artifacts','generation_observations','public_key_observation'} <= set(receipt),
            'Producer receipt object required')
    generation = receipt['generation_observations']; observation = receipt['public_key_observation']
    require(type(generation) is dict and {'artifact_files','private_key_exported'} <= set(generation) and
            type(observation) is dict and 'private_key_available' in observation, 'Public-only receipt objects required')
    equal = same_json if current else lambda a, b: a == b
    require(equal(receipt['source'], source) and receipt['status'] == 'test-key-source-build-only' and
            receipt['eligibility'] == 'not-qualified', 'Reported producer receipt identity')
    expected_artifacts = {name: value for name, value in manifest['artifacts'].items()
                          if name != 'test-key-build-receipt.json'}
    require(equal(receipt['artifacts'], expected_artifacts) and
            equal(receipt['generation_observations']['artifact_files'], expected_artifacts) and
            receipt['generation_observations']['private_key_exported'] is False and
            receipt['public_key_observation']['private_key_available'] is False,
            'Public-only producer correspondence')
    if current:
        require(set(receipt)=={'status','eligibility','source','artifacts','fixture_public_key_spki_sha256',
                'generation_observations','public_key_observation','build_input_provenance'},'Current receipt members')
        require(set(generation)=={'status','eligibility','fixture_public_key_spki_sha256','packages','index_sha256',
                'regenerated_index_readback','artifact_files','private_key_exported'} and
                type(generation['packages']) is dict and set(generation['packages'])==set(TARGETS) and
                {'status','eligibility','fixture_public_key_spki_sha256','signature_and_payload_verified'} <= set(observation) and
                generation['eligibility']=='not-qualified' and type(generation['regenerated_index_readback']) is str and
                len(generation['regenerated_index_readback']) <= 65536 and type(receipt['build_input_provenance']) is dict and
                observation['eligibility']=='not-qualified' and
                generation['index_sha256']==expected_artifacts['buddy-index.adb']['sha256'], 'Current generation members')
        pin(receipt['fixture_public_key_spki_sha256'])
        for record in generation['packages'].values():
            require(type(record) is dict and set(record) == {'payload','apk_file_bytes','apk_file_sha256',
                    'index_metadata_hash','index_metadata_hash_algorithm','index_metadata_hash_encoding'} and
                    type(record['apk_file_bytes']) is int and 0 < record['apk_file_bytes'] <= 64*1024*1024,
                    'Current package observation object')
        builds = [current_build(manifest,arch,receipt)[0] for arch in TARGETS]
        require(same_json(builds[0]['sdk'], builds[1]['sdk']), 'One consumed SDK fixture identity')
        require(receipt['generation_observations']['status'] == 'generation-self-checks-only' and
                receipt['public_key_observation']['status'] == 'public-key-only-observed' and
                receipt['public_key_observation']['signature_and_payload_verified'] is True and
                receipt['fixture_public_key_spki_sha256'] == receipt['generation_observations']['fixture_public_key_spki_sha256'] ==
                receipt['public_key_observation']['fixture_public_key_spki_sha256'], 'Current public-only receipt')
    return manifest, receipt


def metadata(package, index, arch, manifest, receipt):
    require(type(package) is dict and set(package) == {'info', 'paths'} and
            type(package['info']) is dict and type(package['paths']) is list and type(index) is dict,
            'No package scripts/triggers/unknown members')
    info = package['info']
    source = manifest['source']
    observed = receipt['generation_observations']['packages'][arch]
    current = manifest['profile'] == CURRENT
    equal = same_json if current else lambda a, b: a == b
    build, modes = current_build(manifest,arch,receipt) if current else (None,MODES)
    required_directories = {str(parent) for name in modes for parent in PurePosixPath(name).parents if str(parent) != '.'} if current else DIRECTORIES
    fields = {'name': 'remarkable-buddies', 'origin': 'remarkable-buddies',
              'version': source['tag'][1:] + '-r0', 'arch': arch, 'repo-commit': source['sha'],
              'build-time': source['epoch'], 'license': manifest['license'] if current else 'GPL-3.0',
              'description': 'ReMarkableBuddies test-key source-build package'}
    target, abi = TARGETS[arch]
    binary_path = build['binary']['path'] if current else 'usr/bin/reader-buddy'
    tags = {'abi': abi, 'binary-sha256': observed['payload'][binary_path]['sha256'],
            'contract': '1', 'eligibility': 'not-qualified', 'evidence': 'developer-source-build',
            'pkgrel': '0', 'profile': 'legacy-no-sdk', 'sdk-ref': 'absent',
            'source-repo': SOURCE_REPO, 'source-sha': source['sha'], 'source-tag': source['tag'],
            'target': target}
    if current:
        sdk=build['sdk']
        tags.update(profile=build['build']['profile'],**{'sdk-ref':sdk['ref_kind'],
            'sdk-repo':sdk['repository'],'sdk-sha':sdk['sha'],'sdk-tag':sdk['tag']})
        if arch=='armv7':
            tags.update(device='rm2',firmware='3.28.0.172',**{'sdk-bundle-sha256':BUNDLE_SHA})
            fields['depends']=['remarkable-os=3.28.0.172-r0','rm2']
    fields['tags'] = ['remarkable-buddies:' + name + '=' + value for name, value in sorted(tags.items())]
    require(set(info) == set(fields) | {'installed-size', 'hashes'}, 'Exact initial package info fields')
    require(isinstance(info['hashes'], str) and re.fullmatch('[0-9a-f]{40}', info['hashes']), 'Pinned embedded package identity encoding')
    require(type(info['installed-size']) is int and info['installed-size'] == index['installed-size'] ==
            sum(item['bytes'] for item in observed['payload'].values()), 'Package/index installed size')
    if current:
        require(type(index['installed-size']) is int and type(index['file-size']) is int,
                'Current index integer sizes')
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
        require(type(directory) is dict and set(directory) <= {'name', 'acl', 'files'} and
                {'name', 'acl'} <= set(directory) and type(directory.get('files', [])) is list, 'Directory fields')
        name = directory['name']
        require(type(name) is str and name in required_directories and name not in directories and
                equal(directory['acl'], {'mode': 493, 'user': 'root', 'group': 'root'}), 'Directory inventory/mode')
        directories.add(name)
        for item in directory.get('files', []):
            require(type(item) is dict and set(item) == {'name', 'acl', 'size', 'mtime', 'hash'} and
                    type(item['name']) is str, 'Regular signed file fields')
            path = name + '/' + item['name']
            require(path in modes and path not in files, 'Fixed signed file inventory')
            expected = observed['payload'][path]
            require(equal(item['acl'], {'mode': modes[path], 'user': 'root', 'group': 'root'}) and
                    type(item['mtime']) is int and item['mtime'] == source['epoch'] and
                    type(item['size']) is int and item['size'] == expected['bytes'] and
                    item['hash'] == pin(expected['sha256']), 'Signed file digest/size/mode/time')
            files[path] = expected
    require(directories == required_directories and set(files) == set(modes) and
            set(observed['payload']) == set(modes), 'Complete signed inventory')
    return {'full_version': fields['version'], 'source': source, 'arch': arch,
            'signed_payload': files, 'index_metadata_hash': index['hashes'],
            'package_embedded_hash': info['hashes'],
            'package_embedded_hash_basis': 'pinned mkpkg SHA1 UID; distinct from mkndx SHA256 identity',
            'index_hash_basis': 'matches saved producer regeneration; not independently regenerated',
            'apk_file_sha256': observed['apk_file_sha256'], 'apk_file_bytes': observed['apk_file_bytes']}


def payload_targets(manifest):
    if manifest['profile']==CURRENT:
        return [('changed-package-payload-executable','changed-payload-executable.apk',LIB+'reader-buddy'),
                ('changed-package-payload-library','changed-payload-library.apk',LIB+'libremarkable-resident.so')]
    return [('changed-package-payload','changed-payload.apk','usr/bin/reader-buddy')]


def control_mutations(raw,index):
    old=b'ReMarkableBuddies test-key source-build package'
    new=b'ReMarkableBuddies test-key source-build packagX'
    require(len(raw)<=64*1024*1024 and len(index)<=65536,'Control mutation bounds')
    require(raw.count(old)==1 and index.count(old)>=1,'Pinned signed control targets')
    return raw.replace(old,new,1),index.replace(old,new,1)


def negative_cases(manifest,arm):
    cases=[('wrong-public-key','/originals/'+arm,'wrong'),
           ('changed-package-control','/fixtures/changed-control.apk','good'),
           ('changed-index-control','/fixtures/changed-index.adb','good')]
    cases += [(name,'/fixtures/'+filename,'good') for name,filename,_ in payload_targets(manifest)]
    if manifest['profile']==CURRENT:cases.append(('missing-public-key','/originals/'+arm,'missing'))
    return cases


def index_entries(index, manifest, receipt):
    require(type(index) is dict and set(index) == {'packages', 'pkgname-spec'} and
            index['pkgname-spec'] == PATTERN and type(index['packages']) is list and
            len(index['packages']) == 2, 'Exact signed index root')
    entries = {}
    for entry in index['packages']:
        require(type(entry) is dict, 'Signed index entry object')
        extra = {'depends'} if manifest['profile'] == CURRENT and entry.get('arch') == 'armv7' else set()
        require(set(entry) == {'name', 'version', 'arch', 'origin', 'repo-commit', 'build-time', 'license',
                              'description', 'tags', 'hashes', 'file-size', 'installed-size'} | extra, 'Exact index fields')
        arch = entry['arch']
        require(type(arch) is str and arch in TARGETS and arch not in entries, 'Both unique index architectures')
        require(type(entry['file-size']) is int and type(entry['installed-size']) is int, 'Index size types')
        entries[arch] = entry
    saved = receipt['generation_observations']['regenerated_index_readback']
    require(type(saved) is str, 'Saved index text required')
    expected = strict(saved.encode())
    require(same_json(index, expected) if manifest['profile'] == CURRENT else index == expected,
            'Signed original differs from saved producer comparison')
    return entries


def payload_mutations(raw,manifest,receipt):
    """Mutate only hash-identified complete ELF inputs, never guess a unique ELF."""
    targets=payload_targets(manifest)
    if manifest['profile']!=CURRENT:
        require(raw.count(b'\x7fELF')==1,'Unique raw ELF payload target')
        at=raw.index(b'\x7fELF')+1024
        require(at<len(raw),'Complete ELF mutation target')
        changed=bytearray(raw);changed[at]^=1
        yield targets[0][1],changed
        return
    require(len(raw)<=64*1024*1024,'Current APK mutation bound')
    positions=[];at=0
    while True:
        at=raw.find(b'\x7fELF',at)
        if at<0:break
        positions.append(at);at+=4
        require(len(positions)<=16,'Bounded ELF candidate count')
    payload=receipt['generation_observations']['packages']['armv7']['payload']
    intervals=[];budget=256*1024*1024
    for _,filename,path in targets:
        entry=payload[path];size=entry['bytes'];pin(entry['sha256'])
        require(type(size) is int and 1024<size<=64*1024*1024,'Complete ELF input size')
        matches=[]
        for offset in positions:
            if offset+size>len(raw):continue
            header=raw[offset:offset+52]
            if len(header)!=52 or header[4:7]!=b'\x01\x01\x01' or header[18:20]!=b'\x28\x00':continue
            budget-=size;require(budget>=0,'ELF matching work bound')
            if hashlib.sha256(memoryview(raw)[offset:offset+size]).hexdigest()==entry['sha256']:matches.append(offset)
        require(len(matches)==1,'Unique hash-identified ELF input required')
        start=matches[0];end=start+size
        require(all(end<=a or z<=start for a,z,_ in intervals),'Distinct ELF mutation inputs')
        intervals.append((start,end,filename))
    for start,_,filename in intervals:
        changed=bytearray(raw);changed[start+1024]^=1
        yield filename,changed


def observe(config):
    root, originals = Path('/fixtures'), Path('/originals')
    external = Path('/handoff/manifest.json') if config.get('external_manifest') else None
    manifest, receipt = admit(originals, config['manifest_pin'],external)
    require(digest(Path('/tool/apk')) == config['tool_pin'], 'Mounted exact verifier digest')
    require(digest(Path(__file__)) == config['consumer_pin'] and
            digest(Path('/harness/qualify.py')) == config['qualification_pin'], 'Mounted exact consumer/helpers')
    for mount_path in ('/fixtures', '/originals', '/tool/apk', '/harness/real_fixture.py',
                       *(('/handoff/manifest.json',) if external is not None else ())):
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
        if external is not None:checked_manifest_bytes(external, config['manifest_pin'])
        code, stdout, stderr = bounded_run(common + args, env=env)
        require(current == (snapshot(root), snapshot(originals)) and
                digest(Path('/tool/apk')) == config['tool_pin'], 'Observation changed inputs/roots/tool')
        if external is not None:checked_manifest_bytes(external, config['manifest_pin'])
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
    entries = index_entries(index, manifest, receipt)
    packages = {arch: metadata(dumps[f'remarkable-buddies-{manifest["source"]["tag"][1:]}-r0.{arch}.apk'],
                               entries[arch], arch, manifest, receipt) for arch in TARGETS}
    arm = f'remarkable-buddies-{manifest["source"]["tag"][1:]}-r0.armv7.apk'
    for name, path, keys in negative_cases(manifest,arm):
        _, record = command(['verify', '--keys-dir', 'etc/apk/keys-' + keys, path], negative=True)
        expected = {'payload-integrity', 'file-integrity'} if name.startswith('changed-package-payload') else \
                   {'untrusted-signature'} if name in ('wrong-public-key','missing-public-key') else {'bad-signature', 'untrusted-signature'}
        require(record['classification'] in expected, 'Wrong refusal class')
        cases.append({'name': name, **record})
    require(before == (snapshot(root), snapshot(originals)), 'Observation roots changed')
    return {'evidence_class': 'actual current public-key-only host test fixture' if manifest['profile']==CURRENT else 'actual historical public-key-only host test fixture', 'cases': cases,
            'source': manifest['source'], 'packages': packages, 'installation_eligible': False,
            'update_eligible': False, 'profile': manifest['profile'], 'eligibility': 'not-qualified',
            'expected_spki_sha256': config['spki_pin'], 'private_key_available': False,
            'payloads_extracted_or_executed': False, 'roots_unchanged': True,
            'limits': 'No independent index regeneration, build.json content extraction, compiler/SDK/native/production trust/lifecycle qualification'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('inputs', 'manifest-sha256', 'expected-spki', 'apk', 'build-receipt', 'source-archive', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--manifest',help='Explicit external current-fixture manifest; legacy default is unchanged')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() != 0, 'Linux nonroot developer host required')
    originals = Path(args.inputs).absolute()
    require(not any(p.is_symlink() for p in [originals, *originals.parents]), 'Input root ancestors')
    external = Path(args.manifest).absolute() if args.manifest is not None else None
    manifest, receipt = admit(originals, args.manifest_sha256,external)
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
        for name in ('meta/etc/apk/keys-good', 'meta/etc/apk/keys-wrong', 'payload',
                     *(('meta/etc/apk/keys-missing',) if external is not None else ())):
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
        index = (originals / 'buddy-index.adb').read_bytes()
        changed_control,changed_index=control_mutations(raw,index)
        (root / 'changed-control.apk').write_bytes(changed_control)
        for filename,changed in payload_mutations(raw,manifest,receipt):
            (root/filename).write_bytes(changed)
        (root / 'changed-index.adb').write_bytes(changed_index)
        config = {'manifest_pin': args.manifest_sha256, 'spki_pin': args.expected_spki,
                  'wrong_spki_pin': ('0' if args.expected_spki[0] != '0' else '1') + args.expected_spki[1:],
                  'tool_pin': build['binary_sha256'], 'consumer_pin': consumer_pin,
                  'qualification_pin': qualification_pin}
        if external is not None:config['external_manifest']=True
        (root / 'control.json').write_text(json.dumps(config))
        name = 'manager-real-fixture-' + uuid.uuid4().hex
        argv = ['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m',
                '--pids-limit', '32', '--user', f'{os.geteuid()}:{os.getegid()}',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--env', 'PYTHONDONTWRITEBYTECODE=1']
        mounts=[(root, '/fixtures'), (originals, '/originals'), (apk, '/tool/apk'),
                             (consumer, '/harness/real_fixture.py'),
                             (qualification, '/harness/qualify.py')]
        if external is not None:mounts.append((external,'/handoff/manifest.json'))
        for path, target in mounts:
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
    if external is not None:checked_manifest_bytes(external, args.manifest_sha256)
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
