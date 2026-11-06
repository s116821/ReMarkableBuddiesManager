"""Focused consumer guards; no signature, producer-build or device qualification."""
from pathlib import Path, PurePosixPath
import sys
import tempfile
import unittest

import real_fixture as fixture


class ConsumerGuards(unittest.TestCase):
    def test_nested_duplicate_and_nonfinite_json_refuse(self):
        for raw in (b'{"info":{"tag":1,"tag":2}}', b'{"value":NaN}', b'{"value":Infinity}'):
            with self.assertRaises(ValueError):
                fixture.strict(raw)

    def test_json_utf8_and_bounds_refuse(self):
        with self.assertRaises(ValueError):
            fixture.strict(b'{}', 1)
        with self.assertRaises(UnicodeError):
            fixture.strict(b'"\xff"')

    def test_pin_requires_complete_lowercase_digest(self):
        for value in (True, 'A' * 64, '0' * 63, '0' * 64 + '\n'):
            with self.assertRaises(ValueError):
                fixture.pin(value)

    def test_manifest_pin_refuses_original_bytes_before_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'hash-manifest.json').write_bytes(b'not-json')
            with self.assertRaisesRegex(ValueError, 'manifest digest'):
                fixture.admit(root, '0' * 64)

    def test_snapshot_detects_content_and_inventory_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'input').write_bytes(b'original')
            original = fixture.snapshot(root)
            (root / 'input').write_bytes(b'changed!')
            self.assertNotEqual(original, fixture.snapshot(root))
            (root / 'extra').mkdir()
            self.assertNotEqual(original, fixture.snapshot(root))

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-only opt-in consumer process/mount boundary')
    def test_snapshot_refuses_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'escape').symlink_to(root.parent)
            with self.assertRaisesRegex(ValueError, 'Regular files'):
                fixture.snapshot(root)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-only bounded selector/process groups')
    def test_actual_process_output_bound(self):
        with self.assertRaisesRegex(ValueError, 'output bound'):
            fixture.bounded_run([sys.executable, '-c', 'import os;os.write(1,b"x"*8192)'], limit=128)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-only bounded selector/process groups')
    def test_actual_timeout_calls_owned_cleanup(self):
        cleaned = []
        with self.assertRaisesRegex(ValueError, 'timeout'):
            fixture.bounded_run([sys.executable, '-c', 'import time;time.sleep(10)'],
                                timeout=0.1, cleanup=lambda: cleaned.append(True))
        self.assertEqual(cleaned, [True])

class CurrentFixtureGuards(unittest.TestCase):
    """Tiny owned metadata/files only; never APK-tool or signature observations."""
    def fixture(self, parent):
        import hashlib,json
        parent=parent.resolve()
        root=parent/'originals';root.mkdir()
        source=dict(repository=fixture.SOURCE_REPO,tag='v0.1.0',sha='a'*40,epoch=100)
        manifest=dict(schema=2,purpose='host-only-offline-consumer-test-fixture',profile=fixture.CURRENT,
            eligibility='not-qualified',installation_eligible=False,private_key_included=False,
            source=source,helper_commit='b'*40,docs_commit='c'*40,license='GPL-3.0-only',builds={},artifacts={})
        generation=dict(status='generation-self-checks-only',eligibility='not-qualified',
            fixture_public_key_spki_sha256='d'*64,packages={},index_sha256='',regenerated_index_readback='{}',
            artifact_files={},private_key_exported=False)
        observation=dict(status='public-key-only-observed',eligibility='not-qualified',
            fixture_public_key_spki_sha256='d'*64,private_key_available=False,signature_and_payload_verified=True)
        receipt=dict(source=source,status='test-key-source-build-only',eligibility='not-qualified',artifacts={},
            fixture_public_key_spki_sha256='d'*64,generation_observations=generation,
            public_key_observation=observation,build_input_provenance={})
        for arch in ('armv7','aarch64'):
            resident=arch=='armv7';path=fixture.LIB+'reader-buddy' if resident else 'usr/bin/reader-buddy'
            modes=fixture.RESIDENT_MODES if resident else fixture.MODES
            payload={name:dict(bytes=9,sha256=hashlib.sha256(name.encode()).hexdigest()) for name in modes}
            build=dict(schema=1,evidence='developer-source-build',eligibility='not-qualified',source=source.copy(),
                target=dict(rust_target=fixture.TARGETS[arch][0],apk_arch=arch,abi=fixture.TARGETS[arch][1],
                    elf_class=32 if resident else 64,elf_machine='ARM' if resident else 'AArch64',elf_endian='little',
                    interpreter='/lib/ld-linux-armhf.so.3' if resident else '/lib/ld-linux-aarch64.so.1'),
                sdk=dict(ref_kind='tagged-git',repository=fixture.SDK_REPO,sha=fixture.SDK_SHA,tag='v0.2.0',manifest_sha256='e'*64),
                cargo=dict(features=['installed-resident-output'] if resident else [],lock_sha256='f'*64,metadata_identity_sha256='1'*64),
                toolchain=dict(rustc_release='synthetic',rustc_commit=None,rustc_host='synthetic',cross_version='synthetic',
                    cross_binary_sha256='2'*64,image_digest='sha256:'+'3'*64,build_configuration_sha256='4'*64),
                build=dict(argv=['cross','--features','installed-resident-output'] if resident else ['cross'],
                    environment={k:'' for k in ('RUSTFLAGS','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS')},
                    profile='rm2-resident-test-key' if resident else 'unqualified-development',source_build_helper_sha256='5'*64),
                binary=dict(path=path,bytes=9,sha256=payload[path]['sha256'],mode=493))
            manifest['builds'][arch]=build
            self.rebind_build(manifest,receipt,arch,payload)
            filename=f'remarkable-buddies-{source["tag"][1:]}-r0.{arch}.apk'
            (root/filename).write_bytes(b'inert metadata fixture '+arch.encode())
        (root/'buddy-index.adb').write_bytes(b'inert index')
        (root/'fixture.pub').write_bytes(b'inert public fixture')
        external=parent/'handoff.json'
        self.publish(root,external,manifest,receipt)
        return root,external,manifest,receipt

    def rebind_build(self,manifest,receipt,arch,payload=None):
        import hashlib,json
        if payload is None:payload=receipt['generation_observations']['packages'][arch]['payload']
        raw=(json.dumps(manifest['builds'][arch],sort_keys=True,separators=(',',':'),ensure_ascii=True)+'\n').encode()
        payload['usr/share/remarkable-buddies/build.json']=dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
        receipt['generation_observations']['packages'][arch]=dict(payload=payload)

    def publish(self,root,external,manifest,receipt):
        import json
        artifacts={p.name:dict(bytes=p.stat().st_size,sha256=fixture.digest(p)) for p in root.iterdir() if p.name!='test-key-build-receipt.json'}
        receipt['artifacts']=artifacts;receipt['generation_observations']['artifact_files']=artifacts
        receipt['generation_observations']['index_sha256']=artifacts['buddy-index.adb']['sha256']
        for arch,record in receipt['generation_observations']['packages'].items():
            name=f'remarkable-buddies-{manifest["source"]["tag"][1:]}-r0.{arch}.apk'
            record.update(apk_file_sha256=artifacts[name]['sha256'],apk_file_bytes=artifacts[name]['bytes'],
                index_metadata_hash='6'*64,index_metadata_hash_algorithm='sha256',index_metadata_hash_encoding='lowercase-hex')
        (root/'test-key-build-receipt.json').write_text(json.dumps(receipt))
        manifest['artifacts']={**artifacts,'test-key-build-receipt.json':dict(bytes=(root/'test-key-build-receipt.json').stat().st_size,sha256=fixture.digest(root/'test-key-build-receipt.json'))}
        external.write_text(json.dumps(manifest))

    def test_explicit_external_current_manifest_accepts_only_unchanged_five_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root,external,manifest,receipt=self.fixture(Path(directory));before=fixture.snapshot(root)
            self.assertEqual(fixture.admit(root,fixture.digest(external),external),(manifest,receipt))
            self.assertEqual(before,fixture.snapshot(root));self.assertEqual(len(list(root.iterdir())),5)
            with self.assertRaises(ValueError):fixture.admit(root,fixture.digest(external))

    def package_metadata(self,manifest,receipt,arch):
        import copy
        build=manifest['builds'][arch];source=manifest['source'];current=manifest['profile']==fixture.CURRENT;resident=current and arch=='armv7'
        payload=receipt['generation_observations']['packages'][arch]['payload']
        tags=dict(abi=fixture.TARGETS[arch][1],contract='1',eligibility='not-qualified',evidence='developer-source-build',
            pkgrel='0',profile=('rm2-resident-test-key' if resident else 'unqualified-development') if current else 'legacy-no-sdk',
            **{'binary-sha256':payload[fixture.LIB+'reader-buddy' if resident else 'usr/bin/reader-buddy']['sha256'],
               'sdk-ref':'tagged-git' if current else 'absent','source-repo':source['repository'],
               'source-sha':source['sha'],'source-tag':source['tag'],'target':fixture.TARGETS[arch][0]})
        if current:tags.update(**{'sdk-repo':fixture.SDK_REPO,'sdk-sha':fixture.SDK_SHA,'sdk-tag':build['sdk']['tag']})
        info=dict(name='remarkable-buddies',origin='remarkable-buddies',version=source['tag'][1:]+'-r0',arch=arch,
            license=manifest['license'] if current else 'GPL-3.0',description='ReMarkableBuddies test-key source-build package',
            **{'repo-commit':source['sha'],'build-time':source['epoch'],'installed-size':sum(x['bytes'] for x in payload.values()),'hashes':'a'*40})
        if resident:
            tags.update(device='rm2',firmware='3.28.0.172',**{'sdk-bundle-sha256':fixture.BUNDLE_SHA})
            info['depends']=['remarkable-os=3.28.0.172-r0','rm2']
        info['tags']=['remarkable-buddies:'+k+'='+v for k,v in sorted(tags.items())]
        index=copy.deepcopy(info);index['hashes']='6'*64
        index['file-size']=receipt['generation_observations']['packages'][arch]['apk_file_bytes']
        modes=fixture.RESIDENT_MODES if resident else fixture.MODES;directories={}
        for path,mode in modes.items():
            for parent in PurePosixPath(path).parents:
                if str(parent)!='.':directories.setdefault(str(parent),dict(name=str(parent),acl=dict(mode=493,user='root',group='root'),files=[]))
            directories[str(PurePosixPath(path).parent)]['files'].append(dict(name=PurePosixPath(path).name,
                acl=dict(mode=mode,user='root',group='root'),mtime=source['epoch'],size=payload[path]['bytes'],hash=payload[path]['sha256']))
        return dict(info=info,paths=list(directories.values())),index

    def test_signed_metadata_current_exact_layout_and_refusals(self):
        import copy
        with tempfile.TemporaryDirectory() as directory:
            root,external,manifest,receipt=self.fixture(Path(directory))
            for arch in ('armv7','aarch64'):
                package,index=self.package_metadata(manifest,receipt,arch)
                result=fixture.metadata(package,index,arch,manifest,receipt)
                self.assertEqual(set(result['signed_payload']),set(fixture.RESIDENT_MODES if arch=='armv7' else fixture.MODES))
            package,index=self.package_metadata(manifest,receipt,'armv7')
            for fault in ('dependency','bundle','SDK','profile','mode','owner','mtime','file-hash','extra-path','missing-path','scripts','index-size','index-hash'):
                with self.subTest(fault=fault):
                    p=copy.deepcopy(package);i=copy.deepcopy(index)
                    if fault=='dependency':p['info']['depends']=i['depends']=['rm2']
                    if fault in ('bundle','SDK','profile'):
                        key={'bundle':'sdk-bundle-sha256','SDK':'sdk-sha','profile':'profile'}[fault]
                        p['info']['tags']=i['tags']=[v if not v.startswith('remarkable-buddies:'+key+'=') else 'remarkable-buddies:'+key+'=wrong' for v in i['tags']]
                    entry=next(d['files'][0] for d in p['paths'] if d['files'])
                    if fault=='mode':entry['acl']['mode']=511
                    if fault=='owner':entry['acl']['user']='user'
                    if fault=='mtime':entry['mtime']+=1
                    if fault=='file-hash':entry['hash']='0'*64
                    if fault=='extra-path':entry['name']='unreviewed'
                    if fault=='missing-path':p['paths'].pop()
                    if fault=='scripts':p['scripts']=[]
                    if fault=='index-size':i['file-size']+=1
                    if fault=='index-hash':i['hashes']='0'*64
                    with self.assertRaises(ValueError):fixture.metadata(p,i,'armv7',manifest,receipt)

    def test_current_declared_profile_identity_refusals(self):
        faults=['sdk','feature','profile','binary-path','mode','canonical','target','environment','toolchain','unknown-build','source']
        for fault in faults:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory:
                root,external,manifest,receipt=self.fixture(Path(directory));build=manifest['builds']['armv7']
                if fault=='sdk':build['sdk']['sha']='9'*40
                if fault=='feature':build['cargo']['features']=[]
                if fault=='profile':build['build']['profile']='legacy-no-sdk'
                if fault=='binary-path':build['binary']['path']='usr/bin/reader-buddy'
                if fault=='mode':build['binary']['mode']=420
                if fault=='target':build['target']['elf_machine']='AArch64'
                if fault=='environment':build['build']['environment']['EXTRA']=''
                if fault=='toolchain':build['toolchain']['extra']=''
                if fault=='unknown-build':build['extra']=True
                if fault=='source':build['source']['sha']='9'*40
                if fault=='canonical':build['build']['argv'].append('different declaration')
                else:self.rebind_build(manifest,receipt,'armv7')
                self.publish(root,external,manifest,receipt)
                with self.assertRaises(ValueError):fixture.admit(root,fixture.digest(external),external)

    def test_signed_metadata_numeric_aliases_and_malformed_records_refuse(self):
        import copy
        with tempfile.TemporaryDirectory() as directory:
            _,_,manifest,receipt=self.fixture(Path(directory))
            package,index=self.package_metadata(manifest,receipt,'armv7')
            for fault in ('directory-mode','file-mode','file-time','file-size','index-size','index-installed','directory','file'):
                with self.subTest(fault=fault):
                    p=copy.deepcopy(package);i=copy.deepcopy(index)
                    directory_record=next(d for d in p['paths'] if d['files'])
                    entry=directory_record['files'][0]
                    if fault=='directory-mode':directory_record['acl']['mode']=493.0
                    elif fault=='file-mode':entry['acl']['mode']=float(entry['acl']['mode'])
                    elif fault=='file-time':entry['mtime']=float(entry['mtime'])
                    elif fault=='file-size':entry['size']=float(entry['size'])
                    elif fault=='index-size':i['file-size']=float(i['file-size'])
                    elif fault=='index-installed':i['installed-size']=float(i['installed-size'])
                    elif fault=='directory':p['paths']=[None]
                    else:directory_record['files']=[None]
                    with self.assertRaises(ValueError):fixture.metadata(p,i,'armv7',manifest,receipt)

    def test_signed_index_types_and_saved_numeric_aliases_refuse(self):
        import copy,json
        with tempfile.TemporaryDirectory() as directory:
            _,_,manifest,receipt=self.fixture(Path(directory))
            index={'pkgname-spec':fixture.PATTERN,'packages':[
                self.package_metadata(manifest,receipt,arch)[1] for arch in fixture.TARGETS]}
            receipt['generation_observations']['regenerated_index_readback']=json.dumps(index)
            self.assertEqual(set(fixture.index_entries(index,manifest,receipt)),set(fixture.TARGETS))
            for fault in ('root','packages','entry','arch','duplicate','file-size','installed-size','saved-float','saved-extra'):
                with self.subTest(fault=fault):
                    i=copy.deepcopy(index);r=copy.deepcopy(receipt);saved=copy.deepcopy(index)
                    if fault=='root':i=[]
                    elif fault=='packages':i['packages']=None
                    elif fault=='entry':i['packages'][0]=None
                    elif fault=='arch':i['packages'][0]['arch']=[]
                    elif fault=='duplicate':i['packages'][1]=copy.deepcopy(i['packages'][0])
                    elif fault in ('file-size','installed-size'):
                        i['packages'][0][fault]=float(i['packages'][0][fault]);saved=copy.deepcopy(i)
                    elif fault=='saved-float':saved['packages'][0]['build-time']=float(saved['packages'][0]['build-time'])
                    else:saved['extra']=True
                    r['generation_observations']['regenerated_index_readback']=json.dumps(saved)
                    with self.assertRaises(ValueError):fixture.index_entries(i,manifest,r)

    def test_nested_build_types_and_numeric_aliases_refuse_after_repinning(self):
        import json
        for fault in ('builds','build','source','target','sdk','cargo','toolchain','environment','profile','binary','epoch-float','class-float'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory:
                root,external,manifest,receipt=self.fixture(Path(directory));build=manifest['builds']['armv7']
                if fault=='builds':manifest['builds']=None
                elif fault=='build':manifest['builds']['armv7']=None
                elif fault=='environment':build['build']['environment']=[]
                elif fault=='profile':build['build']=None
                elif fault=='epoch-float':build['source']['epoch']=float(build['source']['epoch'])
                elif fault=='class-float':build['target']['elf_class']=32.0
                else:build[fault]=None
                if fault in ('epoch-float','class-float'):self.rebind_build(manifest,receipt,'armv7')
                self.publish(root,external,manifest,receipt)
                external.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):fixture.admit(root,fixture.digest(external),external)

    def test_nested_receipt_types_and_numeric_aliases_refuse_after_repinning(self):
        import copy,json
        for fault in ('source-float','artifact-float','generation-artifact-float','generation','observation','packages','package','payload','payload-item','provenance'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory:
                root,external,manifest,receipt=self.fixture(Path(directory))
                if fault=='source-float':
                    receipt['source']=copy.deepcopy(receipt['source']);receipt['source']['epoch']=100.0
                elif fault in ('artifact-float','generation-artifact-float'):
                    owner=receipt if fault=='artifact-float' else receipt['generation_observations']
                    key='artifacts' if fault=='artifact-float' else 'artifact_files'
                    owner[key]=copy.deepcopy(owner[key]);owner[key]['fixture.pub']['bytes']=float(owner[key]['fixture.pub']['bytes'])
                elif fault=='generation':receipt['generation_observations']=None
                elif fault=='observation':receipt['public_key_observation']=None
                elif fault=='packages':receipt['generation_observations']['packages']=None
                elif fault=='package':receipt['generation_observations']['packages']['armv7']=None
                elif fault=='payload':receipt['generation_observations']['packages']['armv7']['payload']=None
                elif fault=='payload-item':receipt['generation_observations']['packages']['armv7']['payload'][fixture.LIB+'reader-buddy']=None
                else:receipt['build_input_provenance']=[]
                path=root/'test-key-build-receipt.json';path.write_text(json.dumps(receipt))
                manifest['artifacts'][path.name]=dict(bytes=path.stat().st_size,sha256=fixture.digest(path))
                external.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):fixture.admit(root,fixture.digest(external),external)

    def test_manifest_drift_and_growth_refuse_at_the_shared_recheck(self):
        with tempfile.TemporaryDirectory() as directory:
            root,external,manifest,receipt=self.fixture(Path(directory));pin=fixture.digest(external)
            fixture.admit(root,pin,external)
            external.write_bytes(external.read_bytes()+b' ')
            with self.assertRaises(ValueError):fixture.checked_manifest_bytes(external,pin)
            external.write_bytes(b' '*16385)
            with self.assertRaises(ValueError):fixture.checked_manifest_bytes(external,fixture.digest(external))

    def test_manifest_authority_inventory_size_and_pin_refusals(self):
        for fault in ['profile','schema','install','private-key','extra','missing-arch','extra-file','oversize','wrong-pin','changed-receipt','sdk-disagreement']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory:
                root,external,manifest,receipt=self.fixture(Path(directory))
                if fault=='profile':manifest['profile']='legacy-no-sdk'
                if fault=='schema':manifest['schema']=True
                if fault=='install':manifest['installation_eligible']=True
                if fault=='private-key':manifest['private_key_included']=True
                if fault=='extra':manifest['extra']=True
                if fault=='missing-arch':del manifest['builds']['aarch64']
                if fault=='extra-file':(root/'extra').write_bytes(b'x')
                if fault=='oversize':manifest['artifacts'][next(n for n in manifest['artifacts'] if n.endswith('.apk'))]['bytes']=64*1024*1024+1
                if fault=='sdk-disagreement':
                    manifest['builds']['aarch64']['sdk']['manifest_sha256']='9'*64
                    self.rebind_build(manifest,receipt,'aarch64');self.publish(root,external,manifest,receipt)
                import json
                external.write_text(json.dumps(manifest));digest=fixture.digest(external)
                if fault=='wrong-pin':digest='0'*64
                if fault=='changed-receipt':(root/'test-key-build-receipt.json').write_bytes(b'changed')
                with self.assertRaises(ValueError):fixture.admit(root,digest,external)

    def elf(self,marker):
        raw=bytearray(marker*1536);raw[:7]=b'\x7fELF\x01\x01\x01';raw[18:20]=b'\x28\x00'
        return bytes(raw)

    def test_resident_payload_negatives_target_both_complete_ELFs(self):
        import hashlib
        executable=self.elf(b'E');library=self.elf(b'L');raw=b'prefix'+executable+b'middle'+library+b'suffix'
        payload={fixture.LIB+'reader-buddy':dict(bytes=len(executable),sha256=hashlib.sha256(executable).hexdigest()),
            fixture.LIB+'libremarkable-resident.so':dict(bytes=len(library),sha256=hashlib.sha256(library).hexdigest())}
        receipt={'generation_observations':{'packages':{'armv7':{'payload':payload}}}}
        changes=list(fixture.payload_mutations(raw,{'profile':fixture.CURRENT},receipt))
        self.assertEqual([n for n,_ in changes],['changed-payload-executable.apk','changed-payload-library.apk'])
        self.assertEqual([[i for i,(a,b) in enumerate(zip(raw,changed)) if a!=b] for _,changed in changes],
            [[6+1024],[6+len(executable)+6+1024]])
        for changed in [b'prefix'+executable+b'suffix',raw+executable]:
            with self.assertRaises(ValueError):list(fixture.payload_mutations(changed,{'profile':fixture.CURRENT},receipt))
        payload[fixture.LIB+'libremarkable-resident.so']['sha256']='0'*64
        with self.assertRaises(ValueError):list(fixture.payload_mutations(raw,{'profile':fixture.CURRENT},receipt))

    def test_legacy_payload_control_is_preserved(self):
        raw=b'prefix'+self.elf(b'E')
        changes=list(fixture.payload_mutations(raw,{'profile':'legacy-no-sdk'},{}))
        self.assertEqual(changes[0][0],'changed-payload.apk');self.assertEqual(changes[0][1][6+1024],raw[6+1024]^1)
        with self.assertRaises(ValueError):list(fixture.payload_mutations(raw+raw,{'profile':'legacy-no-sdk'},{}))

    def test_control_mutations_and_negative_cases_do_not_skip_resident_paths(self):
        text=b'ReMarkableBuddies test-key source-build package'
        raw=b'prefix'+text+b'suffix';index=text+b'other'+text
        package,changed_index=fixture.control_mutations(raw,index)
        self.assertEqual(len(package),len(raw));self.assertEqual(len(changed_index),len(index))
        self.assertNotEqual(package,raw);self.assertEqual(changed_index.count(text),1)
        for bad_package,bad_index in [(raw+raw,index),(b'absent',index),(raw,b'absent')]:
            with self.assertRaises(ValueError):fixture.control_mutations(bad_package,bad_index)
        current=fixture.negative_cases({'profile':fixture.CURRENT},'fixture.apk')
        self.assertEqual([x[0] for x in current],['wrong-public-key','changed-package-control','changed-index-control',
            'changed-package-payload-executable','changed-package-payload-library','missing-public-key'])
        self.assertEqual(len(fixture.negative_cases({'profile':'legacy-no-sdk'},'fixture.apk')),4)

    def test_legacy_manifest_default_and_metadata_remain_accepted(self):
        import json,copy
        with tempfile.TemporaryDirectory() as directory:
            root,external,manifest,receipt=self.fixture(Path(directory))
            manifest.update(schema=1,profile='legacy-no-sdk',transport_zip_only=True)
            receipt['generation_observations']['packages']['armv7']['payload']=copy.deepcopy(receipt['generation_observations']['packages']['aarch64']['payload'])
            self.publish(root,external,manifest,receipt)
            path=root/'hash-manifest.json';path.write_text(json.dumps(manifest))
            self.assertEqual(fixture.admit(root,fixture.digest(path)),(manifest,receipt))
            for arch in ('armv7','aarch64'):
                package,index=self.package_metadata(manifest,receipt,arch)
                self.assertEqual(set(fixture.metadata(package,index,arch,manifest,receipt)['signed_payload']),set(fixture.MODES))

    @unittest.skipUnless(sys.platform=='linux','Linux external manifest aliases')
    def test_external_manifest_alias_and_original_directory_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root,external,manifest,receipt=self.fixture(Path(directory));alias=Path(directory)/'alias.json';alias.symlink_to(external)
            with self.assertRaises(ValueError):fixture.admit(root,fixture.digest(external),alias)
            import shutil
            nested=root/'handoff.json';shutil.copyfile(external,nested)
            with self.assertRaises(ValueError):fixture.admit(root,fixture.digest(nested),nested)


if __name__ == '__main__':
    unittest.main()
