"""Capture original actual CLI bytes; no report rewriting or tablet paths."""
from pathlib import Path
import base64
import hashlib
import json
import os
import platform
import queue
import subprocess
import threading
import uuid

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / 'portable-import_ReMarkableBuddies'
PRODUCER = HERE.parent / 'ordinary-configuration-target/debug/reader-buddy.exe'
HELPER = HERE / 'setup.exe'
RLIB = HERE.parent / 'ordinary-configuration-target/debug/deps/libremarkable_reader_buddy-6b8a86c58140f756.rlib'
RUN = HERE / ('run-' + str(uuid.uuid4()))
RUN.mkdir()
PACKET = RUN / 'packet'
PACKET.mkdir()
CASES = PACKET / 'cases'
CASES.mkdir()

def sha(data): return hashlib.sha256(data).hexdigest()
def compact(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')
def pin(path):
    raw = path.read_bytes()
    return {'path': str(path.resolve()), 'bytes': len(raw), 'sha256': sha(raw)}

cases = []
def capture(name, args, config, request=None, expected=None):
    stdin = b'' if request is None else request if isinstance(request, bytes) else compact(request)
    env = {k: os.environ[k] for k in ('SystemRoot','SystemDrive','TEMP','TMP') if k in os.environ}
    env.update(REMARKABLE_BUDDIES_CONFIG=str(config), OPENAI_API_KEY='SYNTHETIC_UNUSED', OPENAI_BASE_URL='http://127.0.0.1:1/unused')
    result = subprocess.run([str(PRODUCER), *args], input=stdin, capture_output=True, timeout=15, cwd=RUN, env=env)
    prefix = CASES / name
    for suffix, raw in [('stdin', stdin), ('stdout', result.stdout), ('stderr', result.stderr)]:
        prefix.with_suffix('.'+suffix+'.bin').write_bytes(raw)
    entry = {'name':name, 'argv':[str(PRODUCER), *args], 'cwd':str(RUN),
             'selected_config_path':str(config), 'stdin_mode':'piped exact bytes then EOF', 'environment':env,
             'stdin_base64':base64.b64encode(stdin).decode(), 'stdin_sha256':sha(stdin),
             'stdout_utf8':result.stdout.decode('utf-8'), 'stdout_sha256':sha(result.stdout),
             'stderr_utf8':result.stderr.decode('utf-8'), 'stderr_sha256':sha(result.stderr), 'exit':result.returncode}
    cases.append(entry)
    assert result.returncode == 0 and not result.stderr, name
    value = json.loads(result.stdout)
    if expected is not None:
        assert (value['status'],value.get('outcome')) == expected, (name,value)
    return value, result.stdout

def operation(name, op, config, request=None, expected=None):
    args = ['--portable-configuration-operation',op]
    if op != 'inspect': args += ['--portable-configuration-input','-']
    return capture(name,args,config,request,expected)[0]

def exported(name, source_config, destination):
    value, raw = capture(name,['--export-portable-configuration',str(source_config)],destination)
    assert value['status'] == 'ok'
    text = raw.decode('utf-8')
    # Extract the producer's original nested JSON bytes, without reserialization.
    start = text.index('"artifact":') + len('"artifact":')
    artifact, end = json.JSONDecoder().raw_decode(text,start)
    actual = text[start:end].encode('utf-8')
    assert sha(actual) == value['summary']['artifact_sha256']
    path = PACKET / (name+'.artifact.compact.json')
    path.write_bytes(actual)
    artifacts.append({'case':name,'file':path.name,'bytes':len(actual),'sha256':sha(actual),
                      'basis':'exact byte span from actual Rust stdout, not rewritten',
                      'stdout_byte_start':len(text[:start].encode('utf-8')),
                      'stdout_byte_end':len(text[:end].encode('utf-8')),
                      'producer_digest':value['summary']['artifact_sha256']})
    return artifact

setup = []
configs = {}
for name, action, preferences in [
    ('legacy','legacy',{'product_settings':{'reader_enabled':True,'writer_enabled':True},'personalization':{'enabled':False,'text':'Synthetic destination preserved'},'research_policy':'disabled'}),
    ('notebook','notebook',{'product_settings':None,'personalization':{'enabled':False,'text':'Synthetic notebook old'},'research_policy':'required'}),
]:
    root = RUN / name
    root.mkdir()
    command = [str(HELPER),str(root),action]
    result = subprocess.run(command,capture_output=True,timeout=15)
    setup.append({'argv':command,'exit':result.returncode,'stdout_base64':base64.b64encode(result.stdout).decode(),'stderr_base64':base64.b64encode(result.stderr).decode()})
    assert result.returncode == 0
    preferences.update(paths={key:str(root/key) for key in ['data','cache','credentials']},model='synthetic-excluded-model',model_credential='synthetic_key',base_url='https://synthetic.invalid/v1')
    config = root/'config.json'
    config.write_bytes(json.dumps(preferences,ensure_ascii=False,indent=2).encode('utf-8')+b'\n')
    configs[name] = config
    (PACKET/(name+'.config.before.json')).write_bytes(config.read_bytes())

artifacts = []
text = 'Synthetic é 日本語 😀\r\n\t\b\f\x01 " \\ \u2028\u2029'
sources = {
    'rich':{'product_settings':{'schema_version':1,'reader_enabled':False},'personalization':{'enabled':False,'text':text},'research_policy':None},
    'sparse':{'product_settings':{},'personalization':{'text':text},'research_policy':None},
    'empty':{},
}
for name, settings in sources.items():
    path = RUN/(name+'.source.json')
    path.write_bytes(json.dumps(settings,ensure_ascii=False,indent=2).encode('utf-8'))
    (PACKET/(name+'.source.json')).write_bytes(path.read_bytes())
    sources[name] = exported('export-'+name,path,configs['legacy'])

def prepare(name, config, artifact, expected=('ok','prepared')):
    current = operation(name+'-inspect','inspect',config,expected=('ok','read-only'))
    return operation(name,'prepare',config,{'portable_import_version':1,'operation':str(uuid.uuid4()),
        'base_sha256':current['data']['base_sha256'],'config_path_sha256':current['data']['config_path_sha256'],
        'artifact':artifact},expected)

prepared = prepare('rich-prepare',configs['legacy'],sources['rich'])
intent = prepared['data']['intent']
apply = {'intent':intent,'artifact':sources['rich']}
prepare('nul-text-prepare-refused',configs['legacy'],{'portable_configuration_version':1,'settings':{'personalization':{'text':'Synthetic\x00refused'}}},('invalid-input','not-dispatched'))
operation('rich-status-before','status',configs['legacy'],{'intent':intent},('ok','unresolved'))

holder = subprocess.Popen([str(HELPER),str(configs['legacy'].parent),'hold'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
ready = queue.Queue()
thread = threading.Thread(target=lambda:ready.put(holder.stdout.readline()),daemon=True)
thread.start()
try:
    readiness = ready.get(timeout=15)
    assert readiness in (b'ready\n', b'ready\r\n')
    operation('rich-apply-busy','apply',configs['legacy'],apply,('busy','not-dispatched'))
finally:
    holder.stdin.close()
    try: holder.wait(timeout=15)
    except subprocess.TimeoutExpired: holder.kill();holder.wait(timeout=5)
    setup.append({'argv':[str(HELPER),str(configs['legacy'].parent),'hold'],'exit':holder.returncode,'stdout_base64':base64.b64encode(readiness+holder.stdout.read()).decode(),'stderr_base64':base64.b64encode(holder.stderr.read()).decode()})

operation('rich-apply','apply',configs['legacy'],apply,('ok','verified'))
operation('rich-status-after','status',configs['legacy'],{'intent':intent},('ok','desired-file-observed'))
prepare('rich-prepare-nochange',configs['legacy'],sources['rich'],('ok','no-change'))
prepare('empty-prepare-nochange',configs['legacy'],sources['empty'],('ok','no-change'))
operation('rich-apply-stale','apply',configs['legacy'],apply,('conflict','not-dispatched'))
foreign = json.loads(json.dumps(apply))
foreign['artifact']['settings']['research_policy'] = 'required'
operation('rich-apply-foreign-artifact','apply',configs['legacy'],foreign,('conflict','not-dispatched'))
bad_version = {'intent':dict(intent,portable_import_version=2)}
operation('status-unsupported-version','status',configs['legacy'],bad_version,('unsupported','read-only'))
operation('apply-duplicate-member','apply',configs['legacy'],b'{"intent":{},"intent":{},"artifact":{}}',('invalid-input','not-dispatched'))
alias = RUN/'alternate-config.json'
alias.write_bytes(configs['legacy'].read_bytes())
operation('status-alternate-path','status',alias,{'intent':intent},('conflict','read-only'))
operation('inspect-missing','inspect',RUN/'does-not-exist.json',expected=('unavailable','read-only'))
bad = RUN/'invalid-config.json'
bad.write_bytes(b'{"log_level":"invalid"}')
operation('inspect-invalid-whole-config','inspect',bad,expected=('invalid-input','read-only'))

prepared = prepare('sparse-notebook-prepare',configs['notebook'],sources['sparse'])
nintent = prepared['data']['intent']
operation('sparse-notebook-apply','apply',configs['notebook'],{'intent':nintent,'artifact':sources['sparse']},('ok','verified'))
operation('sparse-notebook-status','status',configs['notebook'],{'intent':nintent},('ok','desired-file-observed'))
for name,config in configs.items(): (PACKET/(name+'.config.after.json')).write_bytes(config.read_bytes())

head = subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE).decode().strip()
manifest = {'fixture_version':1,'source_contents_commit':head,'docs_commit':'2087f0cec22ceb405275bda30dcb4271a9a26789',
 'platform':platform.platform(),'capture_root':str(RUN),'source_worktree':str(SOURCE),
 'producer':pin(PRODUCER),'producer_version_stdout':subprocess.check_output([str(PRODUCER),'--version']).decode(),
 'build_identity_note':'Existing actual CLI compiled from the working-tree source contents subsequently committed as e5bf3b8. Its truthful precommit dev.v0.73.0-dirty metadata is retained; no clean-commit/release build is fabricated.',
 'setup_helper_source':pin(HERE/'setup.rs'),'setup_helper_binary':pin(HELPER),'setup_rlib':pin(RLIB),
 'capture_script':pin(Path(__file__)),'setup_commands':setup,'artifacts':artifacts,'cases':cases,
 'limits':'Synthetic actual Windows CLI/Store corpus; host paths are original, not tablet paths. No provider/tablet/native/runtime activation. Raw stdout/stderr/stdin are retained unchanged; JSON strings/base64 are lossless representations, not replacement producer output.'}
(PACKET/'corpus.json').write_bytes(json.dumps(manifest,ensure_ascii=False,indent=2).encode('utf-8')+b'\n')
files = {str(p.relative_to(PACKET)):{'bytes':len(p.read_bytes()),'sha256':sha(p.read_bytes())} for p in sorted(PACKET.rglob('*')) if p.is_file()}
(PACKET/'file-manifest.json').write_bytes(json.dumps({'files':files},indent=2).encode()+b'\n')
print(json.dumps({'packet':str(PACKET),'cases':len(cases),'files':len(files)+1,'bytes':sum(x['bytes'] for x in files.values()),'corpus_sha256':sha((PACKET/'corpus.json').read_bytes())},indent=2))
